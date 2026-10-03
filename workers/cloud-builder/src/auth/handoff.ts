/**
 * `stellaHandoff()`: the browser-to-app sign-in handoffs and the app
 * integrity challenge, as Better Auth plugin endpoints under `/api/auth`.
 *
 *   POST /link/send               email a magic link; returns {requestId}
 *   GET  /link/status             {status: pending | completed | expired}
 *   POST /link/claim              {requestId, claimSecret} → {token}, once
 *   GET  /link/verify             magic-link landing; ?ott= exchanged here
 *   POST /desktop-social/start    {claimHash} → {requestId, callbackURL, url?}
 *   GET  /desktop-social/verify   social landing; ?ott= exchanged here
 *   POST /browser-social/start    {returnTo} → {callbackURL, url?}
 *   GET  /browser-social/verify   social landing; ?ott= moved into a fragment
 *   POST /integrity/challenge     {purpose} → {nonce, expiresAt}
 *
 * The app never sees a session credential in a URL: it sends SHA-256 of a
 * claim secret, the server exchanges the one-time token for the session token
 * and stores it encrypted under BETTER_AUTH_SECRET, and only the holder of the
 * secret can claim it.
 *
 * Anonymous upgrade happens in place. A magic link sent with an anonymous
 * session's bearer for an email nobody uses gives that user the email when
 * the link is opened (the `/magic-link/verify` before-hook in auth.ts). A
 * social start with an anonymous bearer links the provider account to the
 * anonymous user (`linkSocialAccount`); the claim then returns the same,
 * now connected, session. When the email or provider account already belongs
 * to someone, it is an ordinary sign-in and the anonymous data is abandoned.
 */

import { isAppIntegrityPurpose } from "@stella/contracts/app-integrity";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { isDisposableEmail } from "./disposable-email-domains.js";
import { issueIntegrityNonce } from "./integrity.js";

/** The slice of `auth.api` the handoffs call back into. */
export type HandoffApi = {
  signInMagicLink(input: { body: { email: string; callbackURL: string }; headers: Headers }): Promise<unknown>;
  verifyOneTimeToken(input: {
    body: { token: string };
    headers: Headers;
    returnHeaders: true;
  }): Promise<{ headers: Headers; response: { user?: { id?: unknown } } }>;
  linkSocialAccount(input: {
    body: { provider: "google"; callbackURL: string; errorCallbackURL: string; disableRedirect: true };
    headers: Headers;
  }): Promise<{ url?: string }>;
  signInSocial(input: {
    body: { provider: "google"; callbackURL: string; disableRedirect: true };
    headers: Headers;
  }): Promise<{ url?: string }>;
};

export type HandoffConfig = {
  env: Pick<Cloudflare.Env, "DB">;
  backendUrl: string;
  websiteUrl: string;
  secret: string;
  api: () => HandoffApi;
};

const MAGIC_LINK_EXPIRY_MS = 10 * 60_000;
/** How long after completion a handoff may still be claimed. */
const CLAIM_WINDOW_MS = 3 * 60_000;
const BROWSER_SOCIAL_HANDOFF_EXPIRY_MS = 3 * 60_000;
/** Wrong-secret attempts before the row is destroyed. */
const MAX_CLAIM_ATTEMPTS = 5;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** base64url(SHA-256(claimSecret)), unpadded. */
const CLAIM_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CLAIM_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;
const OTT_PATTERN = /^[A-Za-z0-9._~-]{8,2048}$/;

type LinkRow = {
  request_id: string;
  email: string;
  status: string;
  from_user_id: string | null;
  claim_hash: string;
  token_enc: string | null;
  to_user_id: string | null;
  claim_attempts: number;
  expires_at: number;
  completed_at: number | null;
};

const noStore = {
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
};

const reply = (body: unknown, status = 200): Response => Response.json(body, { status, headers: noStore });
const fail = (status: number, error: string): Response => reply({ error }, status);

const bridgeResponse = (status: number, location?: string): Response =>
  new Response(null, {
    status,
    headers: {
      ...noStore,
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      ...(location ? { location } : {}),
    },
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** base64url(SHA-256(value)), unpadded. Matches what clients send. */
const sha256Base64Url = async (value: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

/** Comparison over a fixed window, so neither length nor prefix leaks through timing. */
const hashesMatch = (a: string, b: string): boolean => {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let index = 0; index < 64; index += 1) diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return diff === 0;
};

/** Browser auth returns only to an https (or loopback) URL on the caller's exact origin. */
const normalizeReturnTarget = (rawReturnTo: string, requestOrigin: string): string | null => {
  if (!rawReturnTo || !requestOrigin || requestOrigin === "null") return null;
  try {
    const target = new URL(rawReturnTo);
    const origin = new URL(requestOrigin);
    if (origin.pathname !== "/" || origin.search || origin.hash) return null;
    if (target.origin !== origin.origin) return null;
    if (target.username || target.password || target.search || target.hash) return null;
    const loopback =
      target.protocol === "http:" && (target.hostname === "localhost" || target.hostname === "127.0.0.1");
    if (target.protocol !== "https:" && !loopback) return null;
    return target.toString();
  } catch {
    return null;
  }
};

type Endpoint = Parameters<typeof getSessionFromCtx>[0] & {
  body?: unknown;
  query?: Record<string, unknown>;
  request?: Request;
  headers?: Headers;
};

/**
 * The anonymous user a request may upgrade: from its own bearer, never from
 * anything in the body. A bearer that does not verify is refused outright.
 */
const anonymousCaller = async (
  ctx: Endpoint,
  requireAnonymous: boolean,
): Promise<{ userId?: string; bearer?: string } | Response> => {
  const authorization = ctx.headers?.get("authorization")?.trim() ?? "";
  const bearer = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
  if (authorization && !bearer) return fail(401, "The anonymous session could not be verified.");
  const session = bearer ? await getSessionFromCtx(ctx).catch(() => null) : null;
  if (bearer && !session) return fail(401, "The anonymous session could not be verified.");
  const anonymous = session?.user && (session.user as { isAnonymous?: unknown }).isAnonymous === true;
  if (requireAnonymous && !anonymous) {
    return fail(401, "An authenticated anonymous session is required to preserve this conversation.");
  }
  return anonymous && session ? { userId: session.user.id, ...(bearer ? { bearer } : {}) } : {};
};

const sessionTokenOf = (result: { headers: Headers; response: { user?: { id?: unknown } } }) => ({
  token: result.headers.get("set-auth-token")?.trim() ?? "",
  userId: typeof result.response?.user?.id === "string" ? result.response.user.id : "",
});

export const stellaHandoff = (config: HandoffConfig) => {
  const db = (): D1Database => {
    if (!config.env.DB) throw new Error("D1 is not bound.");
    return config.env.DB;
  };
  const encrypt = (token: string) => symmetricEncrypt({ key: config.secret, data: token });
  const doneRedirect = () => bridgeResponse(302, `${config.websiteUrl}/auth/callback?done=true`);

  const linkRow = (requestId: string) =>
    db().prepare("SELECT * FROM auth_link_requests WHERE request_id = ?").bind(requestId).first<LinkRow>();

  const insertLinkRequest = async (row: {
    requestId: string;
    email: string;
    fromUserId?: string;
    claimHash: string;
    tokenEnc?: string;
  }) => {
    const now = Date.now();
    await db()
      .prepare(
        `INSERT INTO auth_link_requests
           (request_id, email, status, from_user_id, claim_hash, token_enc, expires_at, created_at)
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.requestId,
        row.email,
        row.fromUserId ?? null,
        row.claimHash,
        row.tokenEnc ?? null,
        now + MAGIC_LINK_EXPIRY_MS,
        now,
      )
      .run();
  };

  const completeLinkRequest = async (requestId: string, token: string, toUserId: string) => {
    const tokenEnc = await encrypt(token);
    await db()
      .prepare(
        `UPDATE auth_link_requests SET status = 'completed', token_enc = ?, to_user_id = ?, completed_at = ?
          WHERE request_id = ? AND status = 'pending' AND expires_at > ?`,
      )
      .bind(tokenEnc, toUserId, Date.now(), requestId, Date.now())
      .run();
  };

  /** Exchange the one-time token Better Auth appended for the session token. */
  const exchangeOtt = async (ott: string) => {
    try {
      return sessionTokenOf(
        await config.api().verifyOneTimeToken({ body: { token: ott }, headers: new Headers(), returnHeaders: true }),
      );
    } catch {
      // Never log the thrown value: it may echo the one-time credential.
      console.error("[auth] Server-side OTT verification failed");
      return { token: "", userId: "" };
    }
  };

  /** An in-place link failed (the account belongs to someone else): sign in normally instead. */
  const fallBackToSignIn = async (callbackURL: string): Promise<Response> => {
    const started = await config.api().signInSocial({
      body: { provider: "google", callbackURL, disableRedirect: true },
      headers: new Headers({ origin: config.backendUrl }),
    });
    return started.url ? bridgeResponse(302, started.url) : bridgeResponse(400);
  };

  /** Start a social sign-in that links to the anonymous caller, or none without one. */
  const linkSocial = async (bearer: string | undefined, callbackURL: string): Promise<string | undefined> => {
    if (!bearer) return undefined;
    const linked = await config.api().linkSocialAccount({
      body: { provider: "google", callbackURL, errorCallbackURL: `${callbackURL}&fallback=1`, disableRedirect: true },
      headers: new Headers({ authorization: `Bearer ${bearer}`, origin: config.backendUrl }),
    });
    return linked.url;
  };

  const userIsAnonymous = async (userId: string): Promise<boolean> => {
    const row = await db().prepare('SELECT "isAnonymous" FROM "user" WHERE "id" = ?').bind(userId).first<{ isAnonymous: number | null }>();
    return row?.isAnonymous === 1;
  };

  return {
    id: "stella-handoff",
    endpoints: {
      linkSend: createAuthEndpoint("/link/send", { method: "POST" }, async (ctx) => {
        const body = isRecord(ctx.body) ? ctx.body : null;
        if (!body) return fail(400, "Invalid JSON body");
        const email = text(body.email).toLowerCase();
        if (!email || !EMAIL_PATTERN.test(email)) return fail(400, "A valid email is required.");
        if (isDisposableEmail(email)) return reply({ error: "email_not_supported" }, 400);
        const claimHash = text(body.claimHash);
        if (!CLAIM_HASH_PATTERN.test(claimHash)) return fail(400, "A valid claimHash is required");
        if (body.requireAnonymousOwner !== undefined && typeof body.requireAnonymousOwner !== "boolean") {
          return fail(400, "requireAnonymousOwner must be a boolean.");
        }
        const caller = await anonymousCaller(ctx as Endpoint, body.requireAnonymousOwner === true);
        if (caller instanceof Response) return caller;
        // Upgrade in place only into an email nobody uses; otherwise this is
        // an ordinary sign-in to the account that has it.
        const taken = await ctx.context.internalAdapter.findUserByEmail(email);
        const requestId = crypto.randomUUID();
        await insertLinkRequest({
          requestId,
          email,
          ...(caller.userId && !taken ? { fromUserId: caller.userId } : {}),
          claimHash,
        });
        try {
          await config.api().signInMagicLink({
            body: { email, callbackURL: `${config.backendUrl}/api/auth/link/verify?requestId=${encodeURIComponent(requestId)}` },
            headers: new Headers({ origin: config.backendUrl }),
          });
        } catch (error) {
          console.error("[auth] Failed to send magic link:", error instanceof Error ? error.message : String(error));
          return fail(500, "Failed to send sign-in email.");
        }
        return reply({ requestId });
      }),

      linkStatus: createAuthEndpoint("/link/status", { method: "GET" }, async (ctx) => {
        const requestId = text(ctx.query?.requestId);
        if (!requestId) return fail(400, "requestId is required");
        const row = REQUEST_ID_PATTERN.test(requestId) ? await linkRow(requestId) : null;
        if (!row) return fail(404, "Request not found");
        if (Date.now() > row.expires_at) return reply({ status: "expired" });
        return reply({ status: row.status === "completed" ? "completed" : "pending" });
      }),

      linkClaim: createAuthEndpoint("/link/claim", { method: "POST" }, async (ctx) => {
        const body = isRecord(ctx.body) ? ctx.body : {};
        const requestId = text(body.requestId);
        const claimSecret = text(body.claimSecret);
        if (!REQUEST_ID_PATTERN.test(requestId) || !CLAIM_SECRET_PATTERN.test(claimSecret)) {
          return fail(400, "Unable to claim sign-in");
        }
        const row = await linkRow(requestId);
        if (!row) return fail(400, "Unable to claim sign-in");
        const attempts = row.claim_attempts + 1;
        if (attempts > MAX_CLAIM_ATTEMPTS) {
          await db().prepare("DELETE FROM auth_link_requests WHERE request_id = ?").bind(requestId).run();
          return fail(400, "Unable to claim sign-in");
        }
        const now = Date.now();
        const fresh =
          row.status === "completed" &&
          row.completed_at !== null &&
          now <= row.completed_at + CLAIM_WINDOW_MS &&
          now <= row.expires_at;
        if (!fresh || !row.token_enc || !hashesMatch(row.claim_hash, await sha256Base64Url(claimSecret))) {
          await db()
            .prepare("UPDATE auth_link_requests SET claim_attempts = ? WHERE request_id = ?")
            .bind(attempts, requestId)
            .run();
          return fail(400, "Unable to claim sign-in");
        }
        // Single use: the handoff dies with the claim.
        const deleted = await db()
          .prepare("DELETE FROM auth_link_requests WHERE request_id = ? AND claim_attempts = ?")
          .bind(requestId, row.claim_attempts)
          .run();
        if ((deleted.meta.changes ?? 0) === 0) return fail(400, "Unable to claim sign-in");
        try {
          const token = await symmetricDecrypt({ key: config.secret, data: row.token_enc });
          if (!token.trim()) throw new Error("empty token");
          return reply({ token });
        } catch {
          console.error("[auth] Sign-in claim decryption failed");
          return fail(500, "Unable to claim sign-in");
        }
      }),

      linkVerify: createAuthEndpoint("/link/verify", { method: "GET" }, async (ctx) => {
        const requestId = text(ctx.query?.requestId);
        const ott = text(ctx.query?.ott);
        if (requestId && ott) {
          const { token, userId } = await exchangeOtt(ott);
          if (token && userId) await completeLinkRequest(requestId, token, userId);
        }
        return doneRedirect();
      }),

      desktopSocialStart: createAuthEndpoint("/desktop-social/start", { method: "POST" }, async (ctx) => {
        const body = isRecord(ctx.body) ? ctx.body : null;
        if (!body) return fail(400, "Invalid JSON body");
        const claimHash = text(body.claimHash);
        if (!CLAIM_HASH_PATTERN.test(claimHash)) return fail(400, "A valid claimHash is required");
        const caller = await anonymousCaller(ctx as Endpoint, false);
        if (caller instanceof Response) return caller;
        const requestId = crypto.randomUUID();
        const callbackURL = `${config.backendUrl}/api/auth/desktop-social/verify?requestId=${encodeURIComponent(requestId)}`;
        const url = caller.userId ? await linkSocial(caller.bearer, callbackURL) : undefined;
        await insertLinkRequest({
          requestId,
          email: "desktop-social:google",
          claimHash,
          // A successful link keeps the anonymous session, now connected:
          // the claim hands back that same session token.
          ...(url && caller.userId && caller.bearer
            ? { fromUserId: caller.userId, tokenEnc: await encrypt(caller.bearer) }
            : {}),
        });
        return reply({ requestId, callbackURL, ...(url ? { url } : {}) });
      }),

      desktopSocialVerify: createAuthEndpoint("/desktop-social/verify", { method: "GET" }, async (ctx) => {
        const requestId = text(ctx.query?.requestId);
        const ott = text(ctx.query?.ott);
        const row = REQUEST_ID_PATTERN.test(requestId) ? await linkRow(requestId) : null;
        if (row && row.status === "pending" && row.expires_at > Date.now()) {
          if (ott) {
            const { token, userId } = await exchangeOtt(ott);
            if (token && userId) await completeLinkRequest(requestId, token, userId);
          } else if (row.from_user_id && ctx.query?.fallback !== undefined) {
            await db()
              .prepare("UPDATE auth_link_requests SET from_user_id = NULL, token_enc = NULL WHERE request_id = ?")
              .bind(requestId)
              .run();
            return await fallBackToSignIn(
              `${config.backendUrl}/api/auth/desktop-social/verify?requestId=${encodeURIComponent(requestId)}`,
            );
          } else if (row.from_user_id && row.token_enc && !(await userIsAnonymous(row.from_user_id))) {
            await db()
              .prepare(
                `UPDATE auth_link_requests SET status = 'completed', to_user_id = from_user_id, completed_at = ?
                  WHERE request_id = ? AND status = 'pending'`,
              )
              .bind(Date.now(), requestId)
              .run();
          }
        }
        return doneRedirect();
      }),

      browserSocialStart: createAuthEndpoint("/browser-social/start", { method: "POST" }, async (ctx) => {
        const origin = ctx.headers?.get("origin") ?? "";
        const body = isRecord(ctx.body) ? ctx.body : null;
        if (!body) return fail(400, "Invalid JSON body");
        const returnTo = normalizeReturnTarget(text(body.returnTo), origin);
        if (!returnTo) return fail(400, "Invalid browser auth return target.");
        const caller = await anonymousCaller(ctx as Endpoint, true);
        if (caller instanceof Response) return caller;
        const requestId = crypto.randomUUID();
        const now = Date.now();
        const callbackURL = `${config.backendUrl}/api/auth/browser-social/verify?requestId=${encodeURIComponent(requestId)}`;
        const url = await linkSocial(caller.bearer, callbackURL);
        await db()
          .prepare(
            `INSERT INTO auth_browser_handoffs
               (request_id, provider, from_user_id, return_origin, return_to, status, expires_at, created_at)
             VALUES (?, 'google', ?, ?, ?, ?, ?, ?)`,
          )
          .bind(requestId, caller.userId ?? "", origin, returnTo, url ? "linking" : "pending", now + BROWSER_SOCIAL_HANDOFF_EXPIRY_MS, now)
          .run();
        return reply({ callbackURL, ...(url ? { url } : {}) });
      }),

      // The provider hook appends the one-time credential as `?ott=`. This
      // no-render route consumes it before any app shell loads and returns to
      // the registered target with the credential in a fragment, once. A
      // completed in-place link returns without one: the browser's session is
      // the same, now connected.
      browserSocialVerify: createAuthEndpoint("/browser-social/verify", { method: "GET" }, async (ctx) => {
        const requestId = text(ctx.query?.requestId);
        const ott = text(ctx.query?.ott);
        if (!REQUEST_ID_PATTERN.test(requestId) || (ott && !OTT_PATTERN.test(ott))) return bridgeResponse(400);
        const callbackURL = `${config.backendUrl}/api/auth/browser-social/verify?requestId=${encodeURIComponent(requestId)}`;
        if (!ott && ctx.query?.fallback !== undefined) {
          const switched = await db()
            .prepare(
              `UPDATE auth_browser_handoffs SET status = 'pending' WHERE request_id = ? AND status = 'linking' AND expires_at > ?`,
            )
            .bind(requestId, Date.now())
            .run();
          return (switched.meta.changes ?? 0) > 0 ? await fallBackToSignIn(callbackURL) : bridgeResponse(410);
        }
        const consumed = await db()
          .prepare(
            `UPDATE auth_browser_handoffs SET status = 'consumed', consumed_at = ?
              WHERE request_id = ? AND status = ? AND expires_at > ?
              RETURNING return_origin AS returnOrigin, return_to AS returnTo`,
          )
          .bind(Date.now(), requestId, ott ? "pending" : "linking", Date.now())
          .first<{ returnOrigin: string; returnTo: string }>();
        if (!consumed) return bridgeResponse(410);
        const returnTo = normalizeReturnTarget(consumed.returnTo, consumed.returnOrigin);
        if (!returnTo) return bridgeResponse(400);
        if (!ott) return bridgeResponse(302, returnTo);
        const target = new URL(returnTo);
        target.hash = new URLSearchParams({ ott }).toString();
        return bridgeResponse(302, target.toString());
      }),

      integrityChallenge: createAuthEndpoint("/integrity/challenge", { method: "POST" }, async (ctx) => {
        const purpose = isRecord(ctx.body) ? ctx.body.purpose : undefined;
        if (!isAppIntegrityPurpose(purpose)) return reply({ error: "invalid_purpose" }, 400);
        return reply(await issueIntegrityNonce(config.env, purpose));
      }),
    },
  } satisfies BetterAuthPlugin;
};
