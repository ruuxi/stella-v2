/**
 * Stella's identity provider: Better Auth on D1, served at `/api/auth/*`.
 *
 * - Sessions are long-lived opaque bearers (desktop and mobile keep them on
 *   disk); `GET /api/auth/token` mints the 15-minute RS256 JWT every other
 *   route verifies (`iss` = this worker's URL, `aud` = "stella", `sub` = the
 *   user id, which is the owner id; claims `sid`, `anon`, `idl`), and
 *   `GET /api/auth/jwks` publishes its public keys. The private keys are in
 *   D1's `jwks` table, encrypted under BETTER_AUTH_SECRET: rotating that
 *   secret means deleting those rows so new keys are minted.
 * - Anonymous users, magic links (Resend), Google and Apple, one-time tokens
 *   for browser-to-app returns, and the `stellaHandoff` endpoints.
 * - Mobile integrity and web Turnstile guard anonymous sign-in and magic
 *   links (src/auth/integrity.ts).
 * - Deleting a user closes its owner object first (`OwnerGate.closeOwner`).
 *
 * One instance per isolate.
 */

import { APP_INTEGRITY_HEADER } from "@stella/contracts/app-integrity";
import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { anonymous, bearer, captcha, jwt, magicLink, oneTimeToken } from "better-auth/plugins";
import { expo } from "@better-auth/expo";
import { importPKCS8, SignJWT } from "jose";
import { isDisposableEmail } from "./disposable-email-domains.js";
import { buildMagicLinkEmail, getMagicLinkSubject } from "./email-templates.js";
import { stellaHandoff, type HandoffApi } from "./handoff.js";
import {
  integrityErrorMessage,
  integrityPurposeForPath,
  turnstileSecret,
  verifyAuthRequestProof,
} from "./integrity.js";

type AuthEnv = Cloudflare.Env;

const DAY_SECONDS = 24 * 60 * 60;
const APPLE_CLIENT_SECRET_TTL_SECONDS = 180 * DAY_SECONDS;
const TEST_ACCOUNT_EMAIL_SUFFIX = "@test.stella.local";
const DEFAULT_WEBSITE_URL = "https://stella.sh";

const configured = (env: unknown, name: string): string | undefined => {
  const value = (env as Record<string, unknown>)[name];
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
};

const required = (env: unknown, name: string): string => {
  const value = configured(env, name);
  if (!value) throw new Error(`Missing required auth secret: ${name}`);
  return value;
};

/** This worker's public origin: the JWT issuer and Better Auth's base URL. */
export const backendUrl = (env: Pick<AuthEnv, "CLOUD_BUILDER_PUBLIC_URL">): string =>
  (env.CLOUD_BUILDER_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");

export const websiteUrl = (env: unknown): string =>
  (configured(env, "STELLA_WEBSITE_URL") ?? DEFAULT_WEBSITE_URL).replace(/\/+$/, "");

/** Dev only: test accounts exist and their magic links are logged, not sent. */
export const testAccountsEnabled = (env: unknown): boolean => configured(env, "STELLA_TEST_ACCOUNTS") === "1";

/** Browser origins allowed to call `/api/auth/*` and to be redirect targets. */
export const trustedOrigins = (env: AuthEnv): string[] => {
  const scheme = configured(env, "STELLA_MOBILE_SCHEME") ?? "stella-mobile";
  return Array.from(
    new Set([
      backendUrl(env),
      websiteUrl(env),
      DEFAULT_WEBSITE_URL,
      // The website's dev server.
      "http://localhost:3000",
      // The Vite dev server, and the origin the Electron main process declares
      // on every auth request (DESKTOP_AUTH_ORIGIN in auth-service.ts).
      "http://localhost:57314",
      "http://127.0.0.1:57314",
      "stella-app://desktop",
      // Native callbacks; platforms serialize the empty path with two or three slashes.
      `${scheme}://`,
      `${scheme}:///`,
      "https://appleid.apple.com",
    ]),
  );
};

const appleProvider = async (env: AuthEnv) => {
  const clientId = configured(env, "APPLE_CLIENT_ID");
  const teamId = configured(env, "APPLE_TEAM_ID");
  const keyId = configured(env, "APPLE_KEY_ID");
  const privateKey = configured(env, "APPLE_PRIVATE_KEY");
  const enabled = Boolean(clientId && teamId && keyId && privateKey);
  let clientSecret = "";
  if (enabled) {
    const key = await importPKCS8(privateKey!.replace(/\\n/g, "\n"), "ES256");
    const now = Math.floor(Date.now() / 1000);
    clientSecret = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: keyId! })
      .setIssuer(teamId!)
      .setSubject(clientId!)
      .setAudience("https://appleid.apple.com")
      .setIssuedAt(now)
      .setExpirationTime(now + APPLE_CLIENT_SECRET_TTL_SECONDS)
      .sign(key);
  }
  return {
    clientId: clientId ?? "",
    clientSecret,
    appBundleIdentifier: configured(env, "APPLE_APP_BUNDLE_IDENTIFIER") ?? "com.stella.mobile",
    enabled,
  };
};

const escapeHtmlAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const sendMagicLinkEmail = async (env: AuthEnv, email: string, url: string): Promise<void> => {
  if (isDisposableEmail(email)) {
    throw new APIError("BAD_REQUEST", { message: "That email provider isn't supported. Use a different address." });
  }
  if (testAccountsEnabled(env) && email.endsWith(TEST_ACCOUNT_EMAIL_SUFFIX)) {
    console.log(JSON.stringify({ event: "auth_magic_link_test_account", email, url }));
    return;
  }
  const logo = configured(env, "STELLA_EMAIL_LOGO_URL") ?? `${websiteUrl(env)}/stella-logo.png`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${required(env, "RESEND_API_KEY")}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: required(env, "RESEND_FROM"),
      to: email,
      subject: getMagicLinkSubject(undefined),
      html: buildMagicLinkEmail(escapeHtmlAttribute(logo), escapeHtmlAttribute(url), undefined),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Resend refused the magic link (${response.status}).`);
};

/**
 * Turnstile on anonymous sign-in for browsers. A native app sends an
 * integrity proof instead, which the before-hook verifies, so the plugin
 * stands aside for those requests.
 */
const webCaptcha = (secretKey: string): BetterAuthPlugin => {
  const plugin = captcha({ provider: "cloudflare-turnstile", secretKey, endpoints: ["/sign-in/anonymous"] });
  return {
    ...plugin,
    onRequest: async (request, ctx) =>
      request.headers.has(APP_INTEGRITY_HEADER) ? undefined : await plugin.onRequest!(request, ctx),
  };
};

/**
 * Keep Expo's authorization proxy and origin handling without its after-hook,
 * which puts the session cookie in the native callback URL. The one-time
 * token below carries the native return instead.
 */
const expoOAuthProxy = (): BetterAuthPlugin => {
  const { hooks: _cookieRedirect, ...proxy } = expo();
  return proxy as BetterAuthPlugin;
};

/**
 * Move Better Auth's short-lived `set-ott` header into the redirect URL of a
 * browser-followed callback, where a native app or the handoff routes can
 * read it. The session credential stays out of the URL. Must follow
 * `oneTimeToken()`.
 */
const nativeOttRedirect = (): BetterAuthPlugin => ({
  id: "stella-native-ott-redirect",
  hooks: {
    after: [
      {
        matcher: (ctx) =>
          Boolean(
            ctx.path?.startsWith("/callback") ||
              ctx.path?.startsWith("/oauth2/callback") ||
              ctx.path?.startsWith("/magic-link/verify"),
          ),
        handler: createAuthMiddleware(async (ctx) => {
          const token = ctx.context.responseHeaders?.get("set-ott")?.trim();
          const redirectTo = ctx.context.responseHeaders?.get("location");
          if (!token || !redirectTo) return;
          const redirectUrl = new URL(redirectTo);
          redirectUrl.searchParams.set("ott", token);
          ctx.context.responseHeaders?.delete("set-ott");
          throw ctx.redirect(redirectUrl.toString());
        }),
      },
    ],
  },
});

/**
 * Signing out everywhere (`/revoke-sessions`) also refuses the JWTs already
 * minted, through the owner's `account.sessionsRevoked` floor; their
 * 15-minute expiry bounds anything that slips past. A plugin hook, after
 * `bearer()`, so the caller's bearer has become its session.
 */
const revokedTokenFloor = (env: AuthEnv): BetterAuthPlugin => ({
  id: "stella-revoked-token-floor",
  hooks: {
    before: [
      {
        matcher: (ctx) => ctx.path === "/revoke-sessions",
        handler: createAuthMiddleware(async (ctx) => {
          const session = await getSessionFromCtx(ctx).catch(() => null);
          if (!session) return;
          const gate = env.OWNER_GATES.getByName(session.user.id);
          const { ownerGeneration } = await gate.snapshot();
          await gate.ownerInternal({
            name: "account.sessionsRevoked",
            args: { minIatMs: Date.now() },
            ownerGeneration,
          });
        }),
      },
    ],
  },
});

/**
 * A magic link sent with an anonymous bearer for an unused email (see
 * `stellaHandoff`) upgrades that anonymous user when it is opened: the user
 * takes the email, so the verification signs in to it with a fresh session.
 */
const upgradeAnonymousOnMagicLink = async (env: AuthEnv, ctx: {
  query?: Record<string, unknown>;
  context: { internalAdapter: { findVerificationValue(identifier: string): Promise<{ value: string; expiresAt: Date } | null>; findUserByEmail(email: string): Promise<unknown>; updateUser(id: string, data: Record<string, unknown>): Promise<unknown> } };
}): Promise<void> => {
  const token = typeof ctx.query?.token === "string" ? ctx.query.token : "";
  const callback = typeof ctx.query?.callbackURL === "string" ? ctx.query.callbackURL : "";
  if (!token || !callback || !env.DB) return;
  let requestId: string | null = null;
  try {
    const url = new URL(decodeURIComponent(callback), backendUrl(env));
    if (url.origin === backendUrl(env) && url.pathname === "/api/auth/link/verify") {
      requestId = url.searchParams.get("requestId");
    }
  } catch {
    return;
  }
  if (!requestId) return;
  const row = await env.DB
    .prepare("SELECT email, from_user_id AS fromUserId FROM auth_link_requests WHERE request_id = ? AND status = 'pending'")
    .bind(requestId)
    .first<{ email: string; fromUserId: string | null }>();
  if (!row?.fromUserId) return;
  const verification = await ctx.context.internalAdapter.findVerificationValue(token);
  if (!verification || verification.expiresAt < new Date()) return;
  let email = "";
  try {
    email = String((JSON.parse(verification.value) as { email?: unknown }).email ?? "").toLowerCase();
  } catch {
    return;
  }
  if (email !== row.email || (await ctx.context.internalAdapter.findUserByEmail(email))) return;
  const anonymousUser = await env.DB
    .prepare('SELECT "isAnonymous" FROM "user" WHERE "id" = ?')
    .bind(row.fromUserId)
    .first<{ isAnonymous: number | null }>();
  if (anonymousUser?.isAnonymous !== 1) return;
  await ctx.context.internalAdapter.updateUser(row.fromUserId, {
    email,
    emailVerified: true,
    isAnonymous: false,
    identityLevel: 1,
  });
};

const buildOptions = (env: AuthEnv) => {
  const backend = backendUrl(env);
  if (!backend) throw new Error("CLOUD_BUILDER_PUBLIC_URL is required for auth.");
  if (!env.DB) throw new Error("D1 is not bound.");
  const secret = required(env, "BETTER_AUTH_SECRET");
  const googleClientSecret = configured(env, "GOOGLE_CLIENT_SECRET");
  const turnstile = turnstileSecret(env);
  const api = (): HandoffApi => (createAuth(env) as unknown as { api: HandoffApi }).api;

  return {
    appName: "Stella",
    secret,
    baseURL: backend,
    basePath: "/api/auth",
    database: env.DB,
    trustedOrigins: trustedOrigins(env),
    telemetry: { enabled: false },
    // The session token is the credential desktop and mobile keep on disk;
    // in-use sessions slide forward daily.
    session: { expiresIn: 7 * DAY_SECONDS, updateAge: DAY_SECONDS },
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: {
        "/link/send": { window: 60 * 60, max: 10 },
        "/link/status": { window: 60, max: 60 },
        "/link/claim": { window: 60, max: 10 },
        "/desktop-social/start": { window: 60, max: 3 },
        "/browser-social/start": { window: 60, max: 3 },
        "/integrity/challenge": { window: 60, max: 30 },
      },
    },
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    user: {
      additionalFields: {
        // The identity ladder: 0 anonymous, 1 email, 2 social. Paying (3) is
        // the billing ledger's to say, not the user row's.
        identityLevel: { type: "number", required: false, defaultValue: 0, input: false },
      },
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          const closed = await env.OWNER_GATES.getByName(user.id).closeOwner();
          console.log(JSON.stringify({ event: "auth_user_owner_closed", pending: closed.pending }));
        },
      },
    },
    account: {
      // Desktop starts Google in the app and finishes in the system browser,
      // and the website sends no cookies, so the state cookie never comes
      // back. State is still checked against the verification table.
      storeStateStrategy: "database",
      skipStateCookieCheck: true,
      // An anonymous user links a provider account whose email is not its
      // placeholder address.
      accountLinking: { enabled: true, allowDifferentEmails: true },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/magic-link/verify") {
          await upgradeAnonymousOnMagicLink(env, ctx as never);
          return;
        }
        const purpose = integrityPurposeForPath(ctx.path);
        if (!purpose || !ctx.request) return;
        const result = await verifyAuthRequestProof({
          env,
          request: ctx.request,
          purpose,
          captchaVerified: ctx.path === "/sign-in/anonymous" && turnstile !== undefined,
        });
        if (!result.ok) {
          throw new APIError(result.code === "integrity_required" ? "BAD_REQUEST" : "FORBIDDEN", {
            code: result.code,
            message: integrityErrorMessage(result.code),
          });
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            const social = ctx?.path?.startsWith("/callback") === true;
            const identityLevel = (user as { isAnonymous?: boolean }).isAnonymous ? 0 : social ? 2 : 1;
            return { data: { ...user, identityLevel } };
          },
        },
      },
      account: {
        create: {
          // A provider account makes the user a social account, including an
          // anonymous user linking one in place.
          after: async (account, ctx) => {
            if (account.providerId !== "google" && account.providerId !== "apple") return;
            await ctx?.context.internalAdapter.updateUser(account.userId, { isAnonymous: false, identityLevel: 2 });
          },
        },
      },
    },
    socialProviders: {
      google: {
        clientId: configured(env, "GOOGLE_CLIENT_ID") ?? "",
        clientSecret: googleClientSecret ?? "",
        enabled: Boolean(googleClientSecret),
      },
      apple: () => appleProvider(env),
    },
    plugins: [
      expoOAuthProxy(),
      bearer({ requireSignature: true }),
      revokedTokenFloor(env),
      oneTimeToken({ storeToken: "hashed", expiresIn: 3, disableClientRequest: true, setOttHeaderOnNewSession: true }),
      nativeOttRedirect(),
      anonymous({ emailDomainName: "anon.stella.local", disableDeleteAnonymousUser: true }),
      magicLink({ sendMagicLink: ({ email, url }) => sendMagicLinkEmail(env, email, url) }),
      ...(turnstile ? [webCaptcha(turnstile)] : []),
      jwt({
        jwks: { keyPairConfig: { alg: "RS256", modulusLength: 2048 } },
        jwt: {
          issuer: backend,
          audience: "stella",
          expirationTime: "15m",
          definePayload: ({ user, session }) => ({
            sid: session.id,
            anon: user.isAnonymous === true,
            idl: typeof user.identityLevel === "number" ? user.identityLevel : 0,
          }),
        },
      }),
      stellaHandoff({ env, backendUrl: backend, websiteUrl: websiteUrl(env), secret, api }),
    ],
  } satisfies BetterAuthOptions;
};

const makeAuth = (env: AuthEnv) => betterAuth(buildOptions(env));

export type Auth = ReturnType<typeof makeAuth>;

let instance: Auth | undefined;

/** The isolate's Better Auth instance. */
export const createAuth = (env: AuthEnv): Auth => (instance ??= makeAuth(env));

