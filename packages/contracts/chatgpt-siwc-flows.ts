/**
 * The Sign in with ChatGPT calls: discovery, code exchange, ID-token
 * validation, refresh, revocation and the model list. A host runs them for
 * its own credentials: Electron main for this computer, the owner store for
 * the owner's cloud. Web Crypto and `fetch` only, so Node, Electron and
 * Workers share it.
 */

import {
  CHATGPT_SIWC,
  ChatGptError,
  chatGptErrorFrom,
  chatGptTokenSet,
  hasChatGptPlanUsage,
  parseChatGptModels,
  type ChatGptCallback,
  type ChatGptIdentity,
  type ChatGptModel,
  type ChatGptRegistration,
  type ChatGptTokenSet,
} from "./chatgpt-siwc.js";
import { createPkce } from "./oauth-pkce.js";

type FetchOptions = { fetch?: typeof fetch; signal?: AbortSignal };

const REQUEST_TIMEOUT_MS = 30_000;
/** Allowed clock skew when checking an ID token's times. */
const CLOCK_SKEW_S = 5;

const timedFetch = async (
  options: FetchOptions,
  url: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> => {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    return await (options.fetch ?? globalThis.fetch)(url, { ...init, signal, redirect: "manual" });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ChatGptError("network_error", "Couldn't reach ChatGPT. Check your connection and try again.", true);
  }
};

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

// --- Discovery ------------------------------------------------------------------

export type ChatGptDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint?: string;
};

let discoveryCache: Promise<ChatGptDiscovery> | null = null;

/** OpenAI's OpenID configuration, checked to stay on the issuer's origin. */
export const chatGptDiscovery = (options: FetchOptions = {}): Promise<ChatGptDiscovery> => {
  discoveryCache ??= (async () => {
    const response = await timedFetch(options, CHATGPT_SIWC.discoveryUrl, {
      headers: { accept: "application/json" },
    });
    const body = (await readJson(response)) as Record<string, unknown> | undefined;
    const sameOrigin = (value: unknown) => {
      if (typeof value !== "string") return false;
      try {
        return new URL(value).origin === CHATGPT_SIWC.issuer;
      } catch {
        return false;
      }
    };
    if (
      !response.ok ||
      !body ||
      body.issuer !== CHATGPT_SIWC.issuer ||
      !sameOrigin(body.authorization_endpoint) ||
      !sameOrigin(body.token_endpoint) ||
      !sameOrigin(body.jwks_uri) ||
      (body.revocation_endpoint !== undefined && !sameOrigin(body.revocation_endpoint))
    ) {
      throw new ChatGptError(
        "discovery_failed",
        "ChatGPT sign-in is temporarily unavailable. Try again shortly.",
        true,
      );
    }
    return body as unknown as ChatGptDiscovery;
  })().catch((error: unknown) => {
    discoveryCache = null;
    throw error;
  });
  return discoveryCache;
};

// --- A sign-in attempt ---------------------------------------------------------------

/** What one authorization attempt keeps until its callback arrives. */
export type ChatGptPendingSignIn = {
  state: string;
  nonce: string;
  verifier: string;
  challenge: string;
};

const randomToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

/** Fresh state, nonce and PKCE for one attempt. */
export const createChatGptPendingSignIn = async (): Promise<ChatGptPendingSignIn> => {
  const { verifier, challenge } = await createPkce();
  return { state: randomToken(), nonce: randomToken(), verifier, challenge };
};

const postForm = async (
  body: Record<string, string>,
  options: FetchOptions,
): Promise<Record<string, unknown>> => {
  const discovery = await chatGptDiscovery(options);
  const response = await timedFetch(options, discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  const json = await readJson(response);
  if (!response.ok) throw chatGptErrorFrom(json, response.status);
  if (!json || typeof json !== "object") {
    throw new ChatGptError("invalid_token_response", "ChatGPT returned an unexpected response. Try again.", true);
  }
  return json as Record<string, unknown>;
};

/**
 * Exchange the callback's code (with the issued client id) and validate the
 * result: the ID token's signature, issuer, audience, expiry and this
 * attempt's nonce, and, when signing a saved account in again, that it is
 * still the same account. Plan usage is whether its scope was granted.
 */
export const completeChatGptSignIn = async (
  args: {
    callback: ChatGptCallback;
    verifier: string;
    nonce: string;
    redirectUri: string;
    /** The saved account's subject when reauthorizing it. */
    expectedSubject?: string;
  },
  options: FetchOptions = {},
): Promise<ChatGptRegistration> => {
  const json = await postForm(
    {
      grant_type: "authorization_code",
      client_id: args.callback.clientId,
      code: args.callback.code,
      code_verifier: args.verifier,
      redirect_uri: args.redirectUri,
      resource: CHATGPT_SIWC.resource,
    },
    options,
  );
  const tokens = chatGptTokenSet(json);
  if (!tokens.idToken) {
    throw new ChatGptError("invalid_id_token", "ChatGPT didn't return a verifiable identity. Sign in again.");
  }
  const identity = await verifyChatGptIdToken(
    tokens.idToken,
    { clientId: args.callback.clientId, nonce: args.nonce },
    options,
  );
  if (args.expectedSubject && identity.subject !== args.expectedSubject) {
    throw new ChatGptError(
      "account_mismatch",
      "That's a different ChatGPT account. Sign in with the original account, or add this one separately.",
    );
  }
  return {
    ...identity,
    clientId: args.callback.clientId,
    idToken: tokens.idToken,
    tokens,
    planUsage: hasChatGptPlanUsage(tokens.scopes),
  };
};

/**
 * Renew with the rotating refresh token. The caller stores the whole
 * replacement (access, refresh, expiry, scopes) together and serializes
 * refreshes of one session. A returned ID token must still name the account.
 */
export const refreshChatGptTokens = async (
  args: { clientId: string; refreshToken: string; scopes: readonly string[]; subject: string },
  options: FetchOptions = {},
): Promise<ChatGptTokenSet> => {
  const json = await postForm(
    {
      grant_type: "refresh_token",
      client_id: args.clientId,
      refresh_token: args.refreshToken,
      resource: CHATGPT_SIWC.resource,
    },
    options,
  );
  const tokens = chatGptTokenSet(json, Date.now(), args.scopes);
  if (tokens.idToken) {
    const identity = await verifyChatGptIdToken(tokens.idToken, { clientId: args.clientId }, options);
    if (identity.subject !== args.subject) {
      throw new ChatGptError("account_mismatch", "The refreshed ChatGPT identity changed. Sign in again.");
    }
  }
  return tokens;
};

/**
 * End the renewable session. Resolves whether the revocation was confirmed;
 * a network failure or 5xx is retried once.
 */
export const revokeChatGptRefreshToken = async (
  args: { clientId: string; refreshToken: string },
  options: FetchOptions = {},
): Promise<boolean> => {
  let endpoint: string | undefined;
  try {
    endpoint = (await chatGptDiscovery(options)).revocation_endpoint;
  } catch {
    return false;
  }
  if (!endpoint) return false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await timedFetch(
        options,
        endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: args.refreshToken,
            token_type_hint: "refresh_token",
            client_id: args.clientId,
          }).toString(),
        },
        10_000,
      );
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 200) return true;
      if (response.status < 500) return false;
    } catch {
      // Retried once below.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
};

/** The selected account's models (`visibility: "list"`), for a picker. */
export const listChatGptModels = async (
  accessToken: string,
  options: FetchOptions = {},
): Promise<ChatGptModel[]> => {
  const response = await timedFetch(options, CHATGPT_SIWC.modelsUrl, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  const json = await readJson(response);
  if (!response.ok) throw chatGptErrorFrom(json, response.status);
  return parseChatGptModels(json);
};

// --- ID tokens -----------------------------------------------------------------------------

/** The RSA signing keys OpenAI publishes. */
type Jwk = { kty?: string; kid?: string; n?: string; e?: string };

let jwksCache: { uri: string; keys: Promise<Jwk[]> } | null = null;

const fetchJwks = (uri: string, options: FetchOptions, refresh: boolean): Promise<Jwk[]> => {
  if (!refresh && jwksCache?.uri === uri) return jwksCache.keys;
  const keys = (async () => {
    const response = await timedFetch(options, uri, { headers: { accept: "application/json" } });
    const body = (await readJson(response)) as { keys?: unknown } | undefined;
    if (!response.ok || !Array.isArray(body?.keys)) {
      throw new ChatGptError(
        "identity_verification_unavailable",
        "ChatGPT identity verification is temporarily unavailable. Try again shortly.",
        true,
      );
    }
    return body.keys as Jwk[];
  })();
  jwksCache = { uri, keys };
  keys.catch(() => {
    if (jwksCache?.keys === keys) jwksCache = null;
  });
  return keys;
};

const decodeSegment = (segment: string): Uint8Array<ArrayBuffer> => {
  const padded = segment.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
};

const invalidIdToken = () =>
  new ChatGptError("invalid_id_token", "ChatGPT's identity couldn't be verified. Sign in again.");

/**
 * Verify an ID token against OpenAI's published keys (RS256): signature,
 * issuer, audience (the issued client id), expiry, and the attempt's nonce.
 */
export const verifyChatGptIdToken = async (
  idToken: string,
  expected: { clientId: string; nonce?: string; now?: number },
  options: FetchOptions = {},
): Promise<ChatGptIdentity> => {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw invalidIdToken();
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(decodeSegment(headerPart))) as Record<string, unknown>;
    claims = JSON.parse(new TextDecoder().decode(decodeSegment(payloadPart))) as Record<string, unknown>;
  } catch {
    throw invalidIdToken();
  }
  if (header.alg !== "RS256") throw invalidIdToken();
  const discovery = await chatGptDiscovery(options);
  const findKey = (keys: Jwk[]) =>
    keys.find(
      (key) =>
        key.kty === "RSA" &&
        typeof key.n === "string" &&
        typeof key.e === "string" &&
        (header.kid === undefined || key.kid === header.kid),
    );
  let jwk = findKey(await fetchJwks(discovery.jwks_uri, options, false));
  // An unfamiliar key id: the key set may have rotated.
  if (!jwk) jwk = findKey(await fetchJwks(discovery.jwks_uri, options, true));
  if (!jwk) throw invalidIdToken();
  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decodeSegment(signaturePart),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
  } catch {
    valid = false;
  }
  if (!valid) throw invalidIdToken();

  const now = Math.floor((expected.now ?? Date.now()) / 1000);
  const audience = claims.aud;
  const audiences = Array.isArray(audience) ? audience : [audience];
  if (
    claims.iss !== discovery.issuer ||
    !audiences.includes(expected.clientId) ||
    (claims.azp !== undefined && claims.azp !== expected.clientId) ||
    (audiences.length > 1 && claims.azp !== expected.clientId) ||
    typeof claims.exp !== "number" ||
    claims.exp + CLOCK_SKEW_S < now ||
    typeof claims.iat !== "number" ||
    claims.iat - CLOCK_SKEW_S > now ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    (expected.nonce !== undefined && claims.nonce !== expected.nonce)
  ) {
    throw invalidIdToken();
  }
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, 320) : undefined;
  const email = text(claims.email);
  const name = text(claims.name);
  return {
    subject: claims.sub,
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
  };
};
