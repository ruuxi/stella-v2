import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { requireActionCtx } from "@convex-dev/better-auth/utils";
import { Resend } from "@convex-dev/resend";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import {
  anonymous,
  bearer,
  generateExportedKeyPair,
  magicLink,
  oneTimeToken,
} from "better-auth/plugins";
import { symmetricEncrypt } from "better-auth/crypto";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { components, internal } from "./_generated/api";
import type { DataModel, Id } from "./_generated/dataModel";
import type { FunctionReference } from "convex/server";
import authConfig from "./auth.config";
import { ConvexError, v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import betterAuthSchema from "./betterAuth/schema";
import {
  buildMagicLinkEmail,
  getMagicLinkSubject,
} from "./lib/email_templates";
import { enforceActionRateLimit, RATE_SENSITIVE } from "./lib/rate_limits";
import { expoOAuthProxy } from "./lib/expo_oauth_proxy";
import { nativeOttRedirect } from "./lib/native_ott_redirect";
import {
  ownerMigrationSourceFenceActive,
  ownershipMigrationSourceDigest,
} from "./lib/auth_migration_paths";
import {
  assertOwnerDataAccessActive,
  assertOwnerDataWriteAllowed,
} from "./owner_lifecycle";
import {
  getTrustedAppsAuthOrigin,
  resolvesToManagedAppsHostOrigin,
} from "./lib/dev_apps_host_origin";
import { importPKCS8, SignJWT } from "jose";

const getRequiredEnv = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
};

const getOptionalEnv = (name: string) => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

/**
 * The issuer (`iss`) the Convex Better Auth plugin stamps on every JWT. It is
 * hardcoded to `CONVEX_SITE_URL` (see `@convex-dev/better-auth`
 * `auth-config.ts` and `plugins/convex`), and Convex derives
 * `identity.tokenIdentifier` as `${iss}|${sub}`. This is intentionally NOT
 * `getAuthBaseUrl()`: `STELLA_AUTH_BASE_URL` only customizes the public auth
 * base URL used for magic-link and OAuth callback URLs and never reaches the
 * token's `iss` claim.
 */
export const getTokenIssuer = () => getRequiredEnv("CONVEX_SITE_URL");

/**
 * Map a Better Auth `user.id` to the Convex `UserIdentity.tokenIdentifier`
 * shape (`${issuer}|${subject}`, where `subject` is the user id). Use this
 * anywhere we have a Better Auth `user.id` but no live `UserIdentity`
 * (lifecycle hooks, Stripe webhooks, etc.) so the value matches what
 * `requireUserId` and friends return inside Convex functions.
 *
 * Must be built from the token issuer (`CONVEX_SITE_URL`), not the auth base
 * URL — using `STELLA_AUTH_BASE_URL` here mints a second, orphaned ownerId per
 * user that never matches the runtime identity.
 */
export const tokenIdentifierForBetterAuthUserId = (userId: string) =>
  `${getTokenIssuer()}|${userId}`;

/**
 * Service-route check for capabilities whose owner comes from a turn token,
 * not the caller's current JWT. Missing/deleted Better Auth users and
 * anonymous users both fail closed.
 */
export const isConnectedOwnerIdAction = async (
  ctx: Pick<ActionCtx, "runQuery">,
  ownerId: string,
): Promise<boolean> => {
  const separator = ownerId.lastIndexOf("|");
  const userId = separator >= 0 ? ownerId.slice(separator + 1) : "";
  if (!userId) return false;
  const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "user",
    where: [{ field: "_id", value: userId }],
  })) as { _id?: string; isAnonymous?: boolean | null } | null;
  return Boolean(
    user &&
      user._id === userId &&
      user.isAnonymous !== true &&
      ownerId === tokenIdentifierForBetterAuthUserId(userId),
  );
};

export const getAuthBaseUrl = () =>
  getOptionalEnv("STELLA_AUTH_BASE_URL") ?? getRequiredEnv("CONVEX_SITE_URL");

const escapeHtmlAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const getEmailLogoSrc = (siteUrl: string) => {
  const custom = process.env.STELLA_EMAIL_LOGO_URL?.trim();
  if (custom) {
    return custom;
  }
  return `${siteUrl.replace(/\/+$/, "")}/stella-logo.png`;
};

const extraTrustedOrigins = [
  // The Vite dev server port, and the origin the Electron main process
  // declares on every auth request (see DESKTOP_AUTH_ORIGIN in
  // desktop/electron/services/auth-service.ts).
  "http://localhost:57314",
  "http://127.0.0.1:57314",
  "https://stella.sh",
  // `*.stellatunnel.com` was here for the mobile WebView that loaded the
  // desktop UI over a Cloudflare tunnel and called signIn.social from that
  // origin. That screen is gone. The tunnel itself still carries the desktop
  // bridge, but that transport authenticates with a Convex JWT bearer and
  // never touches Better Auth, so it needs no trusted origin.
];

/** Matches `EXPO_PUBLIC_STELLA_MOBILE_SCHEME` for native OAuth callbacks. */
const getMobileDeepLinkOrigins = () => {
  const scheme =
    process.env.EXPO_PUBLIC_STELLA_MOBILE_SCHEME?.trim() ||
    process.env.STELLA_MOBILE_SCHEME?.trim() ||
    "stella-mobile";
  // The native bearer client sends `Linking.createURL("", { scheme })` as
  // expo-origin and returns browser OAuth to a route under the same origin.
  // Platform URL serialization varies between two and three slashes.
  return [`${scheme}://`, `${scheme}:///`];
};

const DEFAULT_JWT_EXPIRATION_SECONDS = 30 * 60;

/**
 * Parse a duration string like `"5m"`, `"300s"`, `"1h"`, or `"86400"` into
 * seconds. Used so `STELLA_JWT_EXPIRATION` keeps its existing TimeString-style
 * contract while we hand `expirationSeconds` (number) to the convex plugin.
 */
const parseExpirationSeconds = (raw: string | undefined): number => {
  if (!raw) return DEFAULT_JWT_EXPIRATION_SECONDS;
  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_JWT_EXPIRATION_SECONDS;
  const match = /^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)?$/i.exec(
    trimmed,
  );
  if (!match) {
    throw new Error(
      `Invalid STELLA_JWT_EXPIRATION value: "${raw}". Use e.g. "5m", "300s", "1h".`,
    );
  }
  const value = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const multiplier = unit.startsWith("d")
    ? 86400
    : unit.startsWith("h")
      ? 3600
      : unit.startsWith("m")
        ? 60
        : 1;
  return value * multiplier;
};

const JWT_EXPIRATION_SECONDS = parseExpirationSeconds(
  process.env.STELLA_JWT_EXPIRATION,
);

/**
 * Better Auth session lifetime. The session token is the long-lived
 * credential — desktop and mobile hold it on disk — so it is set explicitly
 * rather than inheriting the default. `updateAge` is how often an in-use
 * session gets its expiry pushed forward.
 *
 * The value is deliberately the same 7 days Better Auth would have defaulted
 * to: the point of pinning it is that it is now chosen and tunable via env,
 * not inherited. Shortening it is a UX call (it signs idle users out sooner),
 * and the actual gap here was that revocation did not work — which it now
 * does.
 */
const SESSION_EXPIRES_IN_SECONDS = parseExpirationSeconds(
  process.env.STELLA_SESSION_EXPIRATION ?? "7d",
);
const SESSION_UPDATE_AGE_SECONDS = parseExpirationSeconds(
  process.env.STELLA_SESSION_UPDATE_AGE ?? "1d",
);
const STATIC_JWKS = process.env.JWKS?.trim();

const APPLE_CLIENT_SECRET_TTL_SECONDS = 180 * 24 * 60 * 60;

const normalizeApplePrivateKey = (privateKey: string) =>
  privateKey.replace(/\\n/g, "\n");

const generateAppleClientSecret = async ({
  clientId,
  keyId,
  privateKey,
  teamId,
}: {
  clientId: string;
  keyId: string;
  privateKey: string;
  teamId: string;
}) => {
  const key = await importPKCS8(normalizeApplePrivateKey(privateKey), "ES256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: keyId })
    .setIssuer(teamId)
    .setSubject(clientId)
    .setAudience("https://appleid.apple.com")
    .setIssuedAt(now)
    .setExpirationTime(now + APPLE_CLIENT_SECRET_TTL_SECONDS)
    .sign(key);
};

const createAppleProviderOptions = async () => {
  const clientId = getOptionalEnv("APPLE_CLIENT_ID");
  const teamId = getOptionalEnv("APPLE_TEAM_ID");
  const keyId = getOptionalEnv("APPLE_KEY_ID");
  const privateKey = getOptionalEnv("APPLE_PRIVATE_KEY");
  const appBundleIdentifier =
    getOptionalEnv("APPLE_APP_BUNDLE_IDENTIFIER") ?? "com.stella.mobile";
  const enabled = Boolean(clientId && teamId && keyId && privateKey);

  return {
    clientId: clientId ?? "",
    clientSecret: enabled
      ? await generateAppleClientSecret({
          clientId: clientId!,
          teamId: teamId!,
          keyId: keyId!,
          privateKey: privateKey!,
        })
      : "",
    appBundleIdentifier,
    enabled,
  };
};

// NOTE: a `parseNumericClaim` helper used to live here, reading the `iat`
// claim off `UserIdentity`. It always returned null: Convex's `customJwt`
// provider decodes with biscuit, whose `RegisteredClaims` consumes the
// registered claims (`iss`/`sub`/`aud`/`exp`/`nbf`/`iat`/`jti`) before custom
// claims are extracted, so `iat` never reaches the identity object. Session
// revocation now keys on the non-registered `sessionId` claim instead.

const onBetterAuthComponentCreateRef = makeFunctionReference<
  "mutation",
  { model: string; doc: unknown },
  unknown
>("auth:onBetterAuthComponentCreate") as unknown as FunctionReference<
  "mutation",
  "internal",
  { model: string; doc: unknown },
  unknown
>;
const onBetterAuthComponentUpdateRef = makeFunctionReference<
  "mutation",
  { model: string; oldDoc: unknown; newDoc: unknown },
  unknown
>("auth:onBetterAuthComponentUpdate") as unknown as FunctionReference<
  "mutation",
  "internal",
  { model: string; oldDoc: unknown; newDoc: unknown },
  unknown
>;

const assertAttributedAuthDocWrite = async (
  ctx: MutationCtx,
  doc: Record<string, unknown>,
  model: "user" | "session" | "account" | "verification",
): Promise<void> => {
  const authUserId =
    model === "user"
      ? typeof doc._id === "string"
        ? doc._id
        : undefined
      : typeof doc.userId === "string"
        ? doc.userId
        : undefined;
  const ownerId =
    model === "verification" && typeof doc.ownerId === "string"
      ? doc.ownerId
      : authUserId
        ? tokenIdentifierForBetterAuthUserId(authUserId)
        : undefined;
  if (!ownerId) return;
  await assertOwnerMigrationWriteAllowed(
    ctx,
    ownerId,
    typeof doc.ownerGeneration === "string" ? doc.ownerGeneration : undefined,
  );
};

const authWriteTriggers = {
  user: {
    onUpdate: async (ctx: MutationCtx, newDoc: Record<string, unknown>) =>
      await assertAttributedAuthDocWrite(ctx, newDoc, "user"),
  },
  session: {
    onCreate: async (ctx: MutationCtx, doc: Record<string, unknown>) =>
      await assertAttributedAuthDocWrite(ctx, doc, "session"),
    onUpdate: async (ctx: MutationCtx, newDoc: Record<string, unknown>) =>
      await assertAttributedAuthDocWrite(ctx, newDoc, "session"),
  },
  account: {
    onCreate: async (ctx: MutationCtx, doc: Record<string, unknown>) =>
      await assertAttributedAuthDocWrite(ctx, doc, "account"),
    onUpdate: async (ctx: MutationCtx, newDoc: Record<string, unknown>) =>
      await assertAttributedAuthDocWrite(ctx, newDoc, "account"),
  },
  verification: {
    onCreate: async (ctx: MutationCtx, doc: Record<string, unknown>) =>
      await assertAttributedAuthDocWrite(ctx, doc, "verification"),
    onUpdate: async (ctx: MutationCtx, newDoc: Record<string, unknown>) =>
      await assertAttributedAuthDocWrite(ctx, newDoc, "verification"),
  },
} as const;

export const authComponent = createClient<DataModel, typeof betterAuthSchema>(
  components.betterAuth,
  {
    local: {
      schema: betterAuthSchema,
    },
    authFunctions: {
      onCreate: onBetterAuthComponentCreateRef,
      onUpdate: onBetterAuthComponentUpdateRef,
    },
    triggers: authWriteTriggers,
  },
);
const authComponentTriggers = authComponent.triggersApi();
export const onBetterAuthComponentCreate = authComponentTriggers.onCreate;
export const onBetterAuthComponentUpdate = authComponentTriggers.onUpdate;
const resend = new Resend(components.resend, { testMode: false });

/**
 * The `sessionId` claim the Convex plugin stamps on every JWT
 * (`@convex-dev/better-auth` `plugins/convex` `definePayload`). Returns null
 * when absent, which is treated as "cannot prove this session wasn't revoked".
 */
const readSessionIdClaim = (
  identity: Awaited<ReturnType<QueryCtx["auth"]["getUserIdentity"]>>,
): string | null => {
  if (!identity || typeof identity !== "object") {
    return null;
  }
  const value = (identity as Record<string, unknown>).sessionId;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};

const revokedSessionError = () =>
  new ConvexError({
    code: "UNAUTHENTICATED",
    message: "Session has been revoked. Please sign in again.",
  });

/**
 * Whether this owner has a live tombstone for `sessionId`. Expired tombstones
 * are ignored (the JWT they covered can no longer be valid anyway); the
 * `purgeExpiredRevokedSessions` cron deletes them lazily.
 *
 * `sessionId === null` means the token carried no `sessionId` claim, so the
 * session cannot be identified. That is only treated as a denial when the
 * owner has at least one live tombstone — i.e. they actually revoked
 * something. An owner who has never revoked is unaffected, so a future
 * regression in the claim can never mass-lock accounts the way keying on the
 * (always-absent) `iat` claim did.
 */
const isSessionRevokedInDb = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  sessionId: string | null,
  nowMs: number,
) => {
  if (sessionId === null) {
    const anyLive = await ctx.db
      .query("auth_revoked_sessions")
      .withIndex("by_ownerId_and_sessionId", (q) => q.eq("ownerId", ownerId))
      .filter((q) => q.gt(q.field("expiresAt"), nowMs))
      .first();
    return anyLive !== null;
  }
  const row = await ctx.db
    .query("auth_revoked_sessions")
    .withIndex("by_ownerId_and_sessionId", (q) =>
      q.eq("ownerId", ownerId).eq("sessionId", sessionId),
    )
    .unique();
  return row !== null && row.expiresAt > nowMs;
};

export const assertSensitiveSessionPolicy = async (
  ctx: QueryCtx | MutationCtx,
  identity: Awaited<ReturnType<QueryCtx["auth"]["getUserIdentity"]>>,
) => {
  if (!identity) return;
  if (
    await isSessionRevokedInDb(
      ctx,
      identity.tokenIdentifier,
      readSessionIdClaim(identity),
      Date.now(),
    )
  ) {
    throw revokedSessionError();
  }
};

export const assertSensitiveSessionPolicyAction = async (
  ctx: ActionCtx,
  identity: Awaited<ReturnType<QueryCtx["auth"]["getUserIdentity"]>>,
) => {
  if (!identity) return;
  const revoked = await ctx.runQuery(internal.auth.isSessionRevokedInternal, {
    ownerId: identity.tokenIdentifier,
    sessionId: readSessionIdClaim(identity),
  });
  if (revoked) {
    throw revokedSessionError();
  }
};

const assertAuthOwnerActionActive = async (
  ctx: Pick<ActionCtx, "runQuery">,
  ownerId: string,
): Promise<string> => {
  const { generation } = await assertOwnerDataAccessActive(ctx, ownerId);
  if (
    await ctx.runQuery(internal.auth.hasOwnerMigrationSourceFenceInternal, {
      ownerId,
    })
  ) {
    throwMigratedAnonymousIdentity();
  }
  return generation;
};

export const authUserIdFromVerificationPayload = async (
  ctx: Pick<ActionCtx, "runQuery">,
  verification: { identifier: string; value: string },
): Promise<string | null> => {
  const findUser = async (field: "id" | "email", value: string) => {
    if (field === "id") {
      return await ctx.runQuery(
        components.betterAuth.adapter.findUserIdSafely,
        { value },
      );
    }
    const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user",
      where: [{ field: "email", value }],
    })) as { _id?: string } | null;
    return user?._id ?? null;
  };

  const direct = await findUser("id", verification.value);
  if (direct) return direct;
  const byIdentifier = await findUser("email", verification.identifier);
  if (byIdentifier) return byIdentifier;

  try {
    const parsed = JSON.parse(verification.value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.userId === "string") {
        const byId = await findUser("id", record.userId);
        if (byId) return byId;
      }
      if (typeof record.email === "string") {
        const byEmail = await findUser("email", record.email);
        if (byEmail) return byEmail;
      }
    }
  } catch {
    // Opaque verification values are expected for unbound sign-in attempts.
  }
  return null;
};

export const createAuthOptions = (ctx: GenericCtx<DataModel>) => {
  const siteUrl = getRequiredEnv("SITE_URL");
  const authBaseUrl = getAuthBaseUrl();
  const trustedAppsHostOrigin = getTrustedAppsAuthOrigin(process.env);
  if (
    !trustedAppsHostOrigin &&
    (resolvesToManagedAppsHostOrigin(siteUrl) ||
      resolvesToManagedAppsHostOrigin(authBaseUrl))
  ) {
    throw new Error(
      "A managed non-production Apps host cannot be an auth origin without its exact deployment contract.",
    );
  }
  const googleClientId =
    getOptionalEnv("GOOGLE_CLIENT_ID") ??
    getOptionalEnv("WORKSPACE_CLIENT_ID") ??
    "398468929332-q768etk5go3lbjbdh9nth3d505pc7aqk.apps.googleusercontent.com";
  const googleClientSecret =
    getOptionalEnv("GOOGLE_CLIENT_SECRET") ??
    getOptionalEnv("STELLA_NATIVE_OAUTH_GOOGLE_WORKSPACE_CLIENT_SECRET");
  const trustedOrigins = Array.from(
    new Set(
      [
        siteUrl,
        authBaseUrl,
        ...getMobileDeepLinkOrigins(),
        "https://appleid.apple.com",
        ...extraTrustedOrigins,
        trustedAppsHostOrigin,
      ].filter((origin): origin is string => Boolean(origin)),
    ),
  );

  const options = {
    baseURL: authBaseUrl,
    trustedOrigins,
    database: authComponent.adapter(ctx),
    // Explicit rather than inherited. Better Auth's default is a 7-day
    // sliding window, which is a long life for a credential that desktop and
    // mobile hold on disk. `updateAge` still refreshes an in-use session, so
    // active users are not signed out on a fixed schedule.
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },
    // Better Auth's own rate limiter is enabled by default in production
    // (Convex's bundler hard-defines NODE_ENV=production) but silently does
    // nothing here: it keys on `x-forwarded-for`, and Convex does not forward
    // a client IP to HTTP actions, so `getIp` returns null and both hooks
    // bail. Turning it off explicitly removes the illusion of coverage —
    // auth-route limiting goes through `enforceHttpRateLimit`, keyed on
    // email/device/owner instead of IP.
    rateLimit: { enabled: false },
    // The desktop Google flow starts in the app and completes in the system
    // browser, so the oauth_state cookie is never present in the completing
    // browser. State is still verified against the `verification` table; only
    // the cookie echo is skipped.
    account: {
      storeStateStrategy: "database" as const,
      skipStateCookieCheck: true,
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const actionCtx = requireActionCtx(ctx);
            const ownerId = tokenIdentifierForBetterAuthUserId(session.userId);
            const ownerGeneration = await assertAuthOwnerActionActive(
              actionCtx,
              ownerId,
            );
            return { data: { ...session, ownerGeneration } };
          },
        },
      },
      account: {
        create: {
          before: async (account) => {
            const actionCtx = requireActionCtx(ctx);
            const ownerId = tokenIdentifierForBetterAuthUserId(account.userId);
            const ownerGeneration = await assertAuthOwnerActionActive(
              actionCtx,
              ownerId,
            );
            return { data: { ...account, ownerGeneration } };
          },
        },
      },
      verification: {
        create: {
          before: async (verification) => {
            const actionCtx = requireActionCtx(ctx);
            const authUserId = await authUserIdFromVerificationPayload(
              actionCtx,
              verification,
            );
            if (!authUserId) return;
            const ownerId = tokenIdentifierForBetterAuthUserId(authUserId);
            const ownerGeneration = await assertAuthOwnerActionActive(
              actionCtx,
              ownerId,
            );
            return {
              data: { ...verification, ownerId, ownerGeneration },
            };
          },
        },
      },
    },
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          const actionCtx = requireActionCtx(ctx);
          const ownerId = tokenIdentifierForBetterAuthUserId(user.id);
          const lifecycle: { operationId: string; generation: string } =
            await actionCtx.runMutation(
              internal.owner_lifecycle.beginOwnerDataPurgeInternal,
              {
                ownerId,
                operationId: crypto.randomUUID(),
                mode: "delete",
                authUserId: user.id,
                authUserEmail: user.email,
                now: Date.now(),
              },
            );
          const authPreparation = await actionCtx.runAction(
            internal.auth_account_deletion
              .prepareAuthAccountDeletionForRouteInternal,
            {
              ownerId,
              authUserId: user.id,
              operationId: lifecycle.operationId,
              generation: lifecycle.generation,
            },
          );
          if (!authPreparation.ready) {
            throw new Error(
              "Account deletion is continuing in the background. Retry shortly.",
            );
          }
          await actionCtx.runAction(
            internal.account_deletion.purgeOwnerCloudData,
            {
              ownerId,
              operationId: lifecycle.operationId,
              generation: lifecycle.generation,
            },
          );
        },
        afterDelete: async (user) => {
          const actionCtx = requireActionCtx(ctx);
          // Wake the durable finalizer. It deliberately retains its locator
          // until optional Better Auth plugin and verification rows are gone.
          await actionCtx.runMutation(
            internal.auth_account_deletion
              .acknowledgeAuthAccountDeletedInternal,
            {
              ownerId: tokenIdentifierForBetterAuthUserId(user.id),
              authUserId: user.id,
            },
          );
        },
      },
    },
    socialProviders: {
      google: {
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        enabled: Boolean(googleClientSecret),
      },
      apple: createAppleProviderOptions,
    },
    plugins: [
      // Keep Expo's browser-driving authorization proxy, but not its native
      // redirect hook: that hook puts the full session cookie in `?cookie=`.
      // The one-time-token plugin below carries only a short-lived exchange
      // token through the native callback.
      expoOAuthProxy(),
      // The request half of this already shipped: @convex-dev/better-auth's
      // convex() plugin spreads bearer's before-hook, so `Authorization:
      // Bearer` was already accepted. This adds the response half so clients
      // can obtain a token without parsing cookies.
      bearer({ requireSignature: true }),
      oneTimeToken({
        storeToken: "hashed",
        expiresIn: 3,
        disableClientRequest: true,
        setOttHeaderOnNewSession: true,
      }),
      // Must follow oneTimeToken(): its after-hook moves `set-ott` into the
      // callback Location so the native auth session can return it to Stella.
      nativeOttRedirect(),
      anonymous({
        emailDomainName: "anon.stella.local",
        disableDeleteAnonymousUser: true,
        onLinkAccount: async ({ anonymousUser, newUser }) => {
          const actionCtx = requireActionCtx(ctx);
          const migration = {
            fromOwnerId: tokenIdentifierForBetterAuthUserId(
              anonymousUser.user.id,
            ),
            toOwnerId: tokenIdentifierForBetterAuthUserId(newUser.user.id),
            sourceAuthUserId: anonymousUser.user.id,
            ...(typeof anonymousUser.user.email === "string"
              ? { sourceAuthUserEmail: anonymousUser.user.email }
              : {}),
          };
          // Publish a durable pending marker before Better Auth exposes the
          // connected session. The renderer can then preserve the anonymous
          // route until its ownership transfer becomes visible instead of
          // jumping to a blank account conversation.
          await actionCtx.runMutation(
            internal.auth_migration.prepareOwnershipMigration,
            migration,
          );
        },
      }),
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          const actionCtx = requireActionCtx(ctx);
          const logoSrc = escapeHtmlAttribute(getEmailLogoSrc(siteUrl));
          const signInUrl = escapeHtmlAttribute(url);
          // Magic-link is also sent on re-link / device-add flows where
          // the user already has an account and a stored locale. The
          // email's locale falls back to English when we can't derive
          // it (first-time sign-up, etc.). Looking the user up by
          // email is left to a follow-up — the plumbing accepts a
          // locale string today.
          const recipientLocale: string | undefined = undefined;
          await resend.sendEmail(actionCtx, {
            from: getRequiredEnv("RESEND_FROM"),
            to: email,
            subject: getMagicLinkSubject(recipientLocale),
            html: buildMagicLinkEmail(logoSrc, signInUrl, recipientLocale),
          });
        },
      }),
      // The `convex({...})` plugin owns the JWT subsystem we actually use:
      // it issues `/convex/token` (consumed by desktop via `convex.token()`)
      // and `/convex/jwks` (used by Convex to verify the bearer token), with
      // a date-safe adapter override that hydrates the Convex-stored numeric
      // `createdAt`/`expiresAt` back to `Date` for better-auth's JWT helpers.
      // Do not also register `jwt({...})` here: that registers a parallel JWT
      // plugin without the date adapter override, which crashes
      // `/api/auth/get-session` with `r.createdAt.getTime is not a function`.
      convex({
        authConfig,
        ...(STATIC_JWKS ? { jwks: STATIC_JWKS } : {}),
        jwksRotateOnTokenGenerationError: true,
        jwt: {
          expirationSeconds: JWT_EXPIRATION_SECONDS,
        },
      }),
    ],
  } satisfies BetterAuthOptions;

  return options;
};

export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth(createAuthOptions(ctx));

/**
 * Remove exact user-linked rows from optional Better Auth component tables.
 *
 * The app-level Better Auth adapter only recognizes plugins enabled in the
 * current configuration. The component schema intentionally retains optional
 * plugin tables, so account deletion uses the component's typed adapter API to
 * clean legacy rows even after a plugin has been disabled.
 */
export const deleteBetterAuthOwnerAuxiliaryRows = async (
  ctx: Pick<ActionCtx, "runMutation">,
  args: { authUserId: string; email?: string },
): Promise<boolean> => {
  const paginationOpts = { cursor: null, numItems: 100 } as const;
  const results = await Promise.all([
    ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: {
        model: "twoFactor",
        where: [{ field: "userId", value: args.authUserId }],
      },
      paginationOpts,
    }),
    ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: {
        model: "oauthAccessToken",
        where: [{ field: "userId", value: args.authUserId }],
      },
      paginationOpts,
    }),
    ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: {
        model: "oauthConsent",
        where: [{ field: "userId", value: args.authUserId }],
      },
      paginationOpts,
    }),
    ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: {
        model: "oauthApplication",
        where: [{ field: "userId", value: args.authUserId }],
      },
      paginationOpts,
    }),
    ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: {
        model: "verification",
        where: [{ field: "value", value: args.authUserId }],
      },
      paginationOpts,
    }),
    ...(args.email
      ? [
          ctx.runMutation(components.betterAuth.adapter.deleteMany, {
            input: {
              model: "verification" as const,
              where: [{ field: "identifier", value: args.email }],
            },
            paginationOpts,
          }),
        ]
      : []),
  ]);
  return results.every(
    (result) =>
      typeof result === "object" &&
      result !== null &&
      "isDone" in result &&
      result.isDone === true,
  );
};

export const { getAuthUser } = authComponent.clientApi();

export const getCurrentUser = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      id: v.string(),
      email: v.optional(v.string()),
      name: v.optional(v.string()),
      image: v.optional(v.string()),
      isAnonymous: v.optional(v.boolean()),
    }),
  ),
  handler: async (ctx) => {
    // `safeGetAuthUser` returns a Convex document for the better-auth
    // `user` table (or undefined when there's no session). Convex
    // documents expose their primary key as `_id`, not `id`; an earlier
    // version of this query checked `record.id` and silently returned
    // `null` for every signed-in user.
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user || typeof user !== "object") {
      return null;
    }
    const record = user as Record<string, unknown>;
    const id =
      typeof record._id === "string"
        ? record._id
        : typeof record.id === "string"
          ? record.id
          : "";
    if (!id) {
      return null;
    }
    return {
      id,
      email: typeof record.email === "string" ? record.email : undefined,
      name: typeof record.name === "string" ? record.name : undefined,
      image: typeof record.image === "string" ? record.image : undefined,
      isAnonymous: record.isAnonymous === true ? true : undefined,
    };
  },
});

/**
 * The subset of a `jwks` adapter row this rotation reads. The Better Auth
 * adapter hands back `createdAt`/`expiresAt` as `Date` through the ORM path
 * and as epoch milliseconds through the Convex component, so both are read.
 */
type JwksRow = {
  id: string;
  createdAt: Date | number;
  expiresAt?: Date | number | null;
};

const jwksTimeMs = (value: Date | number | null | undefined): number | null =>
  value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : null;

/**
 * Rotate the signing key without invalidating outstanding tokens.
 *
 * `auth.api.rotateKeys()` deletes every key in the table, so every JWT signed
 * by the old key stops verifying the moment it runs. Every Stella surface
 * holding a live Convex JWT — the desktop main process, the builder
 * WebSocket, an in-flight `executor-cloud` turn — would be forced back
 * through sign-in. That violates the one-sign-in guarantee for a routine
 * maintenance action, so this inserts the new signer instead and leaves the
 * outgoing key published.
 *
 * The overlap comes from the plugin's own publishing rule: the newest
 * `createdAt` row signs, and a row with `expiresAt` set stays in the public
 * JWKS through its grace window. So a new row plus an `expiresAt` stamp on
 * the outgoing row moves signing forward while verification stays valid.
 *
 * `jwksRotateOnTokenGenerationError` (the self-heal for a key the current
 * secret can no longer decrypt) is deliberately left alone: that path is
 * recovering from an already-broken keyset, where there is nothing to
 * preserve.
 */
export const rotateKeys = internalAction({
  args: {},
  handler: async (ctx) => {
    if (process.env.JWKS?.trim()) {
      throw new Error(
        "JWKS env var is set (static keyset mode): published keys come from the env var, not the database, so a graceful database rotation would sign with a key verifiers never see. Unset JWKS to rotate database-backed keys.",
      );
    }
    const auth = createAuth(ctx);
    const authContext = await auth.$context;
    const adapter = authContext.adapter;

    const newestRows = await adapter.findMany<JwksRow>({
      model: "jwks",
      sortBy: { field: "createdAt", direction: "desc" },
      limit: 1,
    });
    const previous = newestRows[0] ?? null;

    const { publicWebKey, privateWebKey } = await generateExportedKeyPair({
      jwks: { keyPairConfig: { alg: "RS256" } },
    });
    const encryptedPrivateKey = JSON.stringify(
      await symmetricEncrypt({
        key: authContext.secretConfig,
        data: JSON.stringify(privateWebKey),
      }),
    );

    // Signing order is decided by `createdAt`, so a same-millisecond insert
    // could leave the outgoing key still winning the tie. Step past it.
    let createdAt = new Date();
    const previousCreatedAtMs = jwksTimeMs(previous?.createdAt);
    if (
      previousCreatedAtMs !== null &&
      previousCreatedAtMs >= createdAt.getTime()
    ) {
      createdAt = new Date(previousCreatedAtMs + 1);
    }

    const created = await adapter.create<{
      id: string;
      publicKey: string;
      privateKey: string;
      createdAt: Date;
    }>({
      model: "jwks",
      data: {
        publicKey: JSON.stringify(publicWebKey),
        privateKey: encryptedPrivateKey,
        createdAt,
      },
    });

    // Only stamp a key that has never been retired. Re-stamping would slide
    // an older key's grace window forward every rotation and keep a retired
    // signer publishable indefinitely.
    if (previous && jwksTimeMs(previous.expiresAt) === null) {
      await adapter.update({
        model: "jwks",
        where: [{ field: "id", value: previous.id }],
        update: { expiresAt: new Date() },
      });
    }

    // Identifiers only. Key material must never leave this action.
    return {
      rotated: true,
      newKeyId: created.id,
      previousKeyId: previous?.id ?? null,
    };
  },
});

export const getLatestJwks = internalAction({
  args: {},
  handler: async (ctx) => {
    const auth = createAuth(ctx);
    return await auth.api.getLatestJwks();
  },
});

export const isSessionRevokedInternal = internalQuery({
  args: { ownerId: v.string(), sessionId: v.union(v.string(), v.null()) },
  returns: v.boolean(),
  handler: async (ctx, args) =>
    await isSessionRevokedInDb(ctx, args.ownerId, args.sessionId, Date.now()),
});

/** Write the tombstones for a set of just-killed sessions. */
export const recordRevokedSessionsInternal = internalMutation({
  args: {
    ownerId: v.string(),
    sessionIds: v.array(v.string()),
    expiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const sessionId of args.sessionIds) {
      const existing = await ctx.db
        .query("auth_revoked_sessions")
        .withIndex("by_ownerId_and_sessionId", (q) =>
          q.eq("ownerId", args.ownerId).eq("sessionId", sessionId),
        )
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, {
          revokedAt: now,
          expiresAt: args.expiresAt,
        });
        continue;
      }
      await ctx.db.insert("auth_revoked_sessions", {
        ownerId: args.ownerId,
        sessionId,
        revokedAt: now,
        expiresAt: args.expiresAt,
      });
    }
    return null;
  },
});

/** Drop tombstones whose covered JWTs have expired. */
export const purgeExpiredRevokedSessions = internalMutation({
  args: { batchSize: v.optional(v.number()) },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    const limit = args.batchSize ?? 200;
    const stale = await ctx.db
      .query("auth_revoked_sessions")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", Date.now()))
      .take(limit);
    for (const row of stale) {
      await ctx.db.delete(row._id);
    }
    return { deleted: stale.length };
  },
});

/**
 * Sign out every device on this account.
 *
 * Deletes the Better Auth session rows — that is the actual revocation, since
 * `/api/auth/convex/token` refuses to mint once the session is gone — and
 * tombstones their ids so JWTs already in flight are rejected for the
 * remainder of their (short) lifetime.
 *
 * This is an action, not a mutation, because it has to reach the Better Auth
 * adapter. The previous mutation only wrote an `iat` floor and revoked
 * nothing: a cookie holder called `/convex/token`, got a token stamped with
 * the current second, and sailed straight past the check.
 */
export const revokeActiveSessions = action({
  args: {},
  returns: v.object({ revokedCount: v.number(), expiresAt: v.number() }),
  handler: async (
    ctx,
  ): Promise<{ revokedCount: number; expiresAt: number }> => {
    const identity = await requireSensitiveUserIdentityAction(ctx);
    const ownerId = identity.tokenIdentifier;
    // Sensitive op: kills every session on the account. A hijacked session
    // shouldn't be able to churn this either.
    await enforceActionRateLimit(
      ctx,
      "auth_revoke_active_sessions",
      ownerId,
      RATE_SENSITIVE,
      "Too many session revocation requests. Please wait a minute and try again.",
    );

    const auth = createAuth(ctx);
    const authCtx = await auth.$context;
    const userId = identity.subject;

    // List before deleting — afterwards there is nothing left to enumerate.
    const sessions = await authCtx.internalAdapter.listSessions(userId);
    const sessionIds = sessions
      .map((session: { id?: unknown }) =>
        typeof session.id === "string" ? session.id : null,
      )
      .filter((id: string | null): id is string => id !== null);

    // Cover the current token too when it names a session the adapter no
    // longer lists (e.g. it expired between mint and now).
    const currentSessionId = readSessionIdClaim(identity);
    if (currentSessionId !== null && !sessionIds.includes(currentSessionId)) {
      sessionIds.push(currentSessionId);
    }

    const expiresAt = Date.now() + JWT_EXPIRATION_SECONDS * 1000;
    if (sessionIds.length > 0) {
      await ctx.runMutation(internal.auth.recordRevokedSessionsInternal, {
        ownerId,
        sessionIds,
        expiresAt,
      });
    }

    // The real revocation.
    await authCtx.internalAdapter.deleteSessions(userId);

    return { revokedCount: sessionIds.length, expiresAt };
  },
});

export const isAnonymousIdentity = (identity: unknown): boolean =>
  Boolean(
    identity &&
      typeof identity === "object" &&
      (identity as Record<string, unknown>).isAnonymous === true,
  );

/**
 * An operational source-owner migration row, or its minimized digest successor,
 * is a permanent revocation fence for the anonymous identity that was linked.
 * Status is deliberately irrelevant: pending/running/failed fence partial
 * transfers, and complete/minimized rows still stop valid anonymous JWTs from
 * recreating source-owned state after residue audit.
 */
export const hasOwnerMigrationSourceFence = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
): Promise<boolean> => {
  const sourceOwnerDigest = await ownershipMigrationSourceDigest(ownerId);
  const [rows, tombstones] = await Promise.all([
    ctx.db
      .query("auth_owner_migrations")
      .withIndex("by_fromOwnerId_and_updatedAt", (q) =>
        q.eq("fromOwnerId", ownerId),
      )
      .take(1),
    ctx.db
      .query("auth_owner_migration_tombstones")
      .withIndex("by_sourceOwnerDigest", (q) =>
        q.eq("sourceOwnerDigest", sourceOwnerDigest),
      )
      .take(1),
  ]);
  return (
    tombstones.length > 0 || ownerMigrationSourceFenceActive(ownerId, rows)
  );
};

const hasOwnerMigrationDestinationFence = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
): Promise<boolean> => {
  const rows = await Promise.all(
    (["pending", "running", "failed"] as const).map(
      async (status) =>
        await ctx.db
          .query("auth_owner_migrations")
          .withIndex("by_toOwnerId_and_status_and_updatedAt", (q) =>
            q.eq("toOwnerId", ownerId).eq("status", status),
          )
          .take(1),
    ),
  );
  return rows.some((page) => page.length > 0);
};

export const hasOwnerMigrationWriteFence = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
): Promise<boolean> =>
  (await hasOwnerMigrationSourceFence(ctx, ownerId)) ||
  (await hasOwnerMigrationDestinationFence(ctx, ownerId));

export const hasOwnerMigrationSourceFenceInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) =>
    await hasOwnerMigrationSourceFence(ctx, args.ownerId),
});

export const hasOwnerMigrationWriteFenceInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) =>
    await hasOwnerMigrationWriteFence(ctx, args.ownerId),
});

const throwMigratedAnonymousIdentity = (): never => {
  throw new ConvexError({
    code: "OWNERSHIP_MIGRATED",
    message:
      "This anonymous session was linked to an account. Refresh authentication and retry.",
  });
};

type ActionIdentityCtx = Pick<ActionCtx, "auth" | "runQuery">;

const identityWriteFence = async (
  ctx: QueryCtx | MutationCtx | ActionIdentityCtx,
  identity: NonNullable<
    Awaited<ReturnType<QueryCtx["auth"]["getUserIdentity"]>>
  >,
): Promise<"migration" | null> => {
  if ("db" in ctx) {
    const databaseCtx = ctx as QueryCtx | MutationCtx;
    await assertOwnerDataWriteAllowed(databaseCtx, identity.tokenIdentifier);
    return isAnonymousIdentity(identity) &&
      (await hasOwnerMigrationSourceFence(
        databaseCtx,
        identity.tokenIdentifier,
      ))
      ? "migration"
      : null;
  }
  const actionCtx = ctx as ActionIdentityCtx;
  await assertOwnerDataAccessActive(actionCtx, identity.tokenIdentifier);
  return (await actionCtx.runQuery(
    internal.auth.hasOwnerMigrationWriteFenceInternal,
    { ownerId: identity.tokenIdentifier },
  ))
    ? "migration"
    : null;
};

export const requireUserIdentity = async (
  ctx: QueryCtx | MutationCtx | ActionCtx,
) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new ConvexError({
      code: "UNAUTHENTICATED",
      message: "Authentication required",
    });
  }
  const fence = await identityWriteFence(ctx, identity);
  if (fence === "migration") throwMigratedAnonymousIdentity();
  return identity;
};

export const requireUserId = async (
  ctx: QueryCtx | MutationCtx | ActionCtx,
) => {
  const identity = await requireUserIdentity(ctx);
  return identity.tokenIdentifier;
};

/**
 * Atomic mutation-side guard for internal writers that receive an owner id
 * rather than authenticating directly. The indexed read participates in the
 * same transaction as the caller's writes, so marker insertion races retry
 * instead of committing source-owned rows after the migration audit.
 */
export const assertOwnerMigrationWriteAllowed = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  expectedGeneration?: string,
): Promise<{ generation: string }> => {
  if (await hasOwnerMigrationWriteFence(ctx, ownerId)) {
    throwMigratedAnonymousIdentity();
  }
  return await assertOwnerDataWriteAllowed(ctx, ownerId, expectedGeneration);
};

export const getUserIdentityOrNull = async (ctx: QueryCtx | MutationCtx) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  try {
    if (await identityWriteFence(ctx, identity)) return null;
  } catch {
    return null;
  }
  return identity;
};

export const getUserIdentityOrNullAction = async (ctx: ActionIdentityCtx) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  try {
    if (await identityWriteFence(ctx, identity)) return null;
  } catch {
    return null;
  }
  return identity;
};

export const requireConnectedUserIdentity = async (
  ctx: QueryCtx | MutationCtx,
) => {
  const identity = await requireUserIdentity(ctx);
  if (isAnonymousIdentity(identity)) {
    throw new ConvexError({
      code: "UNAUTHORIZED",
      message: "Sign in with an account to use this feature.",
    });
  }
  return identity;
};

export const requireConnectedUserIdentityAction = async (ctx: ActionCtx) => {
  const identity = await requireUserIdentity(ctx);
  if (isAnonymousIdentity(identity)) {
    throw new ConvexError({
      code: "UNAUTHORIZED",
      message: "Sign in with an account to use this feature.",
    });
  }
  return identity;
};

export const requireConnectedUserId = async (ctx: QueryCtx | MutationCtx) => {
  const identity = await requireConnectedUserIdentity(ctx);
  return identity.tokenIdentifier;
};

export const getConnectedUserIdOrNull = async (ctx: QueryCtx | MutationCtx) => {
  const identity = await getUserIdentityOrNull(ctx);
  if (!identity || isAnonymousIdentity(identity)) {
    return null;
  }
  return identity.tokenIdentifier;
};

/**
 * Read-side helper: returns the caller's owner id (anonymous or connected),
 * or `null` if no identity is attached. Use this in `query` handlers that
 * back UI subscriptions so a transient signed-out / anonymous render between
 * sessions returns empty data instead of throwing UNAUTHENTICATED into the
 * React error boundary. Mutations and actions should keep using
 * `requireUserId` / `requireConnectedUserId` to enforce auth strictly.
 */
export const getUserIdOrNull = async (ctx: QueryCtx | MutationCtx) => {
  const identity = await getUserIdentityOrNull(ctx);
  return identity?.tokenIdentifier ?? null;
};

export const requireConnectedUserIdAction = async (ctx: ActionCtx) => {
  const identity = await requireConnectedUserIdentityAction(ctx);
  return identity.tokenIdentifier;
};

export const requireSensitiveUserIdentity = async (
  ctx: QueryCtx | MutationCtx,
) => {
  const identity = await requireUserIdentity(ctx);
  await assertSensitiveSessionPolicy(ctx, identity);
  return identity;
};

export const requireSensitiveUserIdentityAction = async (ctx: ActionCtx) => {
  const identity = await requireUserIdentity(ctx);
  await assertSensitiveSessionPolicyAction(ctx, identity);
  return identity;
};

/**
 * Browser profile control is both account-only and session-sensitive. Keep
 * this combined helper explicit so a new caller cannot accidentally accept an
 * anonymous identity or skip the account-wide revocation marker.
 */
export const requireSensitiveConnectedUserIdentity = async (
  ctx: QueryCtx | MutationCtx,
) => {
  const identity = await requireConnectedUserIdentity(ctx);
  await assertSensitiveSessionPolicy(ctx, identity);
  return identity;
};

export const requireSensitiveConnectedUserIdentityAction = async (
  ctx: ActionCtx,
) => {
  const identity = await requireConnectedUserIdentityAction(ctx);
  await assertSensitiveSessionPolicyAction(ctx, identity);
  return identity;
};

export const requireSensitiveUserId = async (ctx: QueryCtx | MutationCtx) => {
  const identity = await requireSensitiveUserIdentity(ctx);
  return identity.tokenIdentifier;
};

export const requireSensitiveUserIdAction = async (ctx: ActionCtx) => {
  const identity = await requireSensitiveUserIdentityAction(ctx);
  return identity.tokenIdentifier;
};

export const requireSensitiveConnectedUserId = async (
  ctx: QueryCtx | MutationCtx,
) => {
  const identity = await requireSensitiveConnectedUserIdentity(ctx);
  return identity.tokenIdentifier;
};

export const requireSensitiveConnectedUserIdAction = async (ctx: ActionCtx) => {
  const identity = await requireSensitiveConnectedUserIdentityAction(ctx);
  return identity.tokenIdentifier;
};

const loadConversation = async (
  ctx: QueryCtx | MutationCtx,
  conversationId: Id<"conversations">,
) => {
  return await ctx.db.get(conversationId);
};

const loadConversationAction = async (
  ctx: ActionCtx,
  conversationId: Id<"conversations">,
) => {
  return await ctx.runQuery(internal.conversations.getById, {
    id: conversationId,
  });
};

/**
 * Non-throwing variant: returns the conversation if the current user owns it,
 * or null when the conversation doesn't exist / belongs to someone else.
 * Use this in queries/mutations that intentionally return null for unauthorized access
 * instead of throwing (e.g. polling endpoints, optional lookups).
 */
export const tryLoadOwnedConversation = async (
  ctx: QueryCtx | MutationCtx,
  conversationId: Id<"conversations">,
) => {
  const ownerId = await requireUserId(ctx);
  const conversation = await loadConversation(ctx, conversationId);
  if (!conversation || conversation.ownerId !== ownerId) {
    return null;
  }
  return conversation;
};

export const requireConversationOwner = async (
  ctx: QueryCtx | MutationCtx,
  conversationId: Id<"conversations">,
) => {
  const ownerId = await requireUserId(ctx);
  const conversation = await loadConversation(ctx, conversationId);
  if (!conversation || conversation.ownerId !== ownerId) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Conversation not found",
    });
  }
  return conversation;
};

export const requireConversationOwnerAction = async (
  ctx: ActionCtx,
  conversationId: Id<"conversations">,
) => {
  const ownerId = await requireUserId(ctx);
  const conversation = await loadConversationAction(ctx, conversationId);
  if (!conversation || conversation.ownerId !== ownerId) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Conversation not found",
    });
  }
  return conversation;
};
