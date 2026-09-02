/**
 * Human-presence challenge (Cloudflare Turnstile) on account creation and on
 * step-up at the model gateway.
 *
 * Better Auth's captcha plugin reads the token from `x-captcha-response` on
 * the endpoints listed below. The gateway's session-capability exchange takes
 * the same token in its JSON body (`turnstileToken`) when Convex has marked
 * the owner `challenged` or the caller's network class requires step-up.
 *
 * Web and desktop clients obtain a token from the Turnstile widget (website,
 * Electron hidden window) using the public site key; the secret key lives in
 * Convex env only. Mobile presents an app-integrity proof instead.
 */

export const AUTH_CAPTCHA_HEADER = "x-captcha-response" as const;

/** Better Auth endpoint suffixes (after the `/api/auth` base) that require a token. */
export const AUTH_CAPTCHA_ENDPOINTS = [
  "/sign-in/anonymous",
  "/sign-in/magic-link",
] as const;

/** Hosted challenge page on the Stella site; Electron and mobile load it in a window. */
export const AUTH_CHALLENGE_PAGE_PATH = "/challenge" as const;

/**
 * Query the challenge page accepts: `client` selects how the token is handed
 * back (`desktop` = deep link `${authProtocol}://turnstile?token=…`, `web` =
 * `postMessage` to the same-origin opener). `state` is echoed back untouched
 * so the receiver can match it. Mobile never uses this page: native apps
 * prove integrity with App Attest / Play Integrity (see app-integrity.ts).
 */
export type AuthChallengeClient = "desktop" | "web";
export const AUTH_CHALLENGE_DEEP_LINK_HOST = "turnstile" as const;
export const AUTH_CHALLENGE_TOKEN_PARAM = "token" as const;
export const AUTH_CHALLENGE_STATE_PARAM = "state" as const;

/** Turnstile tokens are single-use and expire five minutes after issuance. */
export const AUTH_CHALLENGE_TOKEN_TTL_MS = 5 * 60_000;
