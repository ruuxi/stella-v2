/**
 * Signed OAuth `state` for flows whose callback lands on this Worker (X,
 * GitHub App installs, integration connects). The token is the routing
 * index: `<payload>.<sig>`, where `payload` is base64url JSON of
 * `{ownerId, kind, nonce, exp, extra?}` and `sig` an HMAC-SHA256 over it
 * keyed by `OAUTH_STATE_SECRET`.
 *
 * The signature proves this Worker issued the state for that owner; it does
 * not make it single-use. Each flow records `nonce` in the owner's object
 * when it signs, and the callback consumes it there exactly once, so a
 * replayed or stale state is refused by the owner object, not here.
 */

export type OAuthState = {
  ownerId: string;
  /** Which flow issued it, e.g. `x`, `github_install`. Callbacks check it. */
  kind: string;
  /** Recorded in the owner object at sign time; consumed once by the callback. */
  nonce: string;
  /** Epoch milliseconds after which the state is refused. */
  exp: number;
  /** Small flow-specific values (no secrets: the payload is readable). */
  extra?: Record<string, string>;
};

const MAX_TOKEN_LENGTH = 1_024;

const encoder = new TextEncoder();

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};

const fromBase64Url = (value: string): string => {
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
};

const secretOf = (env: Cloudflare.Env): string => {
  const value = (env as unknown as Record<string, unknown>).OAUTH_STATE_SECRET;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("OAUTH_STATE_SECRET is not configured.");
  }
  return value.trim();
};

const sign = async (secret: string, message: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message))));
};

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** Sign a state. Throws when `OAUTH_STATE_SECRET` is missing. */
export const signOAuthState = async (env: Cloudflare.Env, state: OAuthState): Promise<string> => {
  const payload = base64Url(
    encoder.encode(
      JSON.stringify({
        ownerId: state.ownerId,
        kind: state.kind,
        nonce: state.nonce,
        exp: state.exp,
        ...(state.extra ? { extra: state.extra } : {}),
      }),
    ),
  );
  return `${payload}.${await sign(secretOf(env), payload)}`;
};

/** The state when its signature holds and it has not expired; otherwise null. */
export const verifyOAuthState = async (
  env: Cloudflare.Env,
  token: string,
  now = Date.now(),
): Promise<OAuthState | null> => {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  let secret: string;
  try {
    secret = secretOf(env);
  } catch {
    return null;
  }
  if (!constantTimeEqual(await sign(secret, payload), signature)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(payload));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.ownerId !== "string" ||
    !record.ownerId ||
    typeof record.kind !== "string" ||
    typeof record.nonce !== "string" ||
    !record.nonce ||
    typeof record.exp !== "number" ||
    record.exp <= now
  ) {
    return null;
  }
  const extra =
    record.extra && typeof record.extra === "object" && !Array.isArray(record.extra)
      ? Object.fromEntries(
          Object.entries(record.extra as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;
  return {
    ownerId: record.ownerId,
    kind: record.kind,
    nonce: record.nonce,
    exp: record.exp,
    ...(extra ? { extra } : {}),
  };
};
