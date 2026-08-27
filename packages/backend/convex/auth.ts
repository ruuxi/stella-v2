import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { requireActionCtx } from "@convex-dev/better-auth/utils";
import { Resend } from "@convex-dev/resend";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { anonymous, bearer, magicLink, oneTimeToken } from "better-auth/plugins";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { components, internal } from "./_generated/api";
import type { DataModel, Id } from "./_generated/dataModel";
import authConfig from "./auth.config";
import { ConvexError, v } from "convex/values";
import betterAuthSchema from "./betterAuth/schema";
import {
  buildMagicLinkEmail,
  getMagicLinkSubject,
} from "./lib/email_templates";
import {
  enforceActionRateLimit,
  RATE_SENSITIVE,
} from "./lib/rate_limits";
import { expoOAuthProxy } from "./lib/expo_oauth_proxy";
import { nativeOttRedirect } from "./lib/native_ott_redirect";
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
  // origin. That screen is gone. The tunnel itself is still used by the
  // desktop bridge, but that transport authenticates with a Convex JWT
  // bearer and never touches Better Auth, so it needs no trusted origin.
];

/** Matches `EXPO_PUBLIC_STELLA_MOBILE_SCHEME` for native OAuth callbacks. */
const getMobileDeepLinkOrigins = () => {
  const scheme =
    process.env.EXPO_PUBLIC_STELLA_MOBILE_SCHEME?.trim()
    || process.env.STELLA_MOBILE_SCHEME?.trim()
    || "stella-mobile";
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
  const multiplier =
    unit.startsWith("d") ? 86400
    : unit.startsWith("h") ? 3600
    : unit.startsWith("m") ? 60
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

export const authComponent = createClient<DataModel, typeof betterAuthSchema>(
  components.betterAuth,
  {
    local: {
      schema: betterAuthSchema,
    },
  },
);
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

export const createAuthOptions = (ctx: GenericCtx<DataModel>) => {
  const siteUrl = getRequiredEnv("SITE_URL");
  const authBaseUrl = getAuthBaseUrl();
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
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          const actionCtx = requireActionCtx(ctx);
          await actionCtx.runAction(internal.account_deletion.purgeOwnerCloudData, {
            ownerId: tokenIdentifierForBetterAuthUserId(user.id),
          });
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
      // The first-party OTT plugin below carries only a short-lived exchange
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
          await actionCtx.scheduler.runAfter(
            0,
            internal.auth_migration.migrateOwnership,
            {
              fromOwnerId: tokenIdentifierForBetterAuthUserId(anonymousUser.user.id),
              toOwnerId: tokenIdentifierForBetterAuthUserId(newUser.user.id),
            },
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

export const rotateKeys = internalAction({
  args: {},
  handler: async (ctx) => {
    const auth = createAuth(ctx);
    await auth.api.rotateKeys();
    return null;
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
    isSessionRevokedInDb(ctx, args.ownerId, args.sessionId, Date.now()),
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
  handler: async (ctx): Promise<{ revokedCount: number; expiresAt: number }> => {
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
  return identity;
};

export const requireUserId = async (
  ctx: QueryCtx | MutationCtx | ActionCtx,
) => {
  const identity = await requireUserIdentity(ctx);
  return identity.tokenIdentifier;
};

export const isAnonymousIdentity = (identity: unknown): boolean =>
  Boolean(
    identity
    && typeof identity === "object"
    && (identity as Record<string, unknown>).isAnonymous === true,
  );

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

export const requireConnectedUserIdentityAction = async (
  ctx: ActionCtx,
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

export const requireConnectedUserId = async (
  ctx: QueryCtx | MutationCtx,
) => {
  const identity = await requireConnectedUserIdentity(ctx);
  return identity.tokenIdentifier;
};

export const getConnectedUserIdOrNull = async (
  ctx: QueryCtx | MutationCtx,
) => {
  const identity = await ctx.auth.getUserIdentity();
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
export const getUserIdOrNull = async (
  ctx: QueryCtx | MutationCtx,
) => {
  const identity = await ctx.auth.getUserIdentity();
  return identity?.tokenIdentifier ?? null;
};

export const requireConnectedUserIdAction = async (
  ctx: ActionCtx,
) => {
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

export const requireSensitiveUserIdentityAction = async (
  ctx: ActionCtx,
) => {
  const identity = await requireUserIdentity(ctx);
  await assertSensitiveSessionPolicyAction(ctx, identity);
  return identity;
};

export const requireSensitiveUserId = async (
  ctx: QueryCtx | MutationCtx,
) => {
  const identity = await requireSensitiveUserIdentity(ctx);
  return identity.tokenIdentifier;
};

export const requireSensitiveUserIdAction = async (
  ctx: ActionCtx,
) => {
  const identity = await requireSensitiveUserIdentityAction(ctx);
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
