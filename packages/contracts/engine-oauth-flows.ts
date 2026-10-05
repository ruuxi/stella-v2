/**
 * The Anthropic calls behind Claude sign-in and token refresh. Only the
 * owner's own devices import this (Electron main, the runtime's loopback
 * flow, the mobile app), so every exchange, profile lookup and refresh leaves
 * from the user's own network. Stella's server never makes them.
 */

import {
  ANTHROPIC_OAUTH,
  anthropicIdentity,
  tokensFromResponse,
  type EngineAccountIdentity,
  type EngineTokenResponse,
  type EngineTokens,
} from "./engine-oauth.js";

type FetchOptions = {
  /** Defaults to the global `fetch`, read at call time. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
};

const TOKEN_TIMEOUT_MS = 30_000;

/** Anthropic refused a refresh token: the account must sign in again. */
export class EngineRefreshRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineRefreshRejectedError";
  }
}

/**
 * `fetch` with a deadline on the response headers. Hand-rolled because React
 * Native has neither `AbortSignal.timeout` nor `AbortSignal.any`.
 */
const timedFetch = async (
  options: FetchOptions,
  timeoutMs: number,
  url: string,
  init: RequestInit,
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forward = () => controller.abort();
  options.signal?.addEventListener("abort", forward, { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    return await (options.fetch ?? globalThis.fetch)(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forward);
  }
};

/** The token endpoint takes JSON, as Claude Code sends it. */
const postToken = (body: Record<string, string>, options: FetchOptions): Promise<Response> =>
  timedFetch(options, TOKEN_TIMEOUT_MS, ANTHROPIC_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });

export type EngineSignIn = {
  tokens: EngineTokens;
  identity: EngineAccountIdentity;
};

/**
 * Exchange a Claude authorization code, then read the OAuth profile for the
 * plan. The profile is best effort; it never blocks signing in.
 */
export const exchangeAnthropicCode = async (
  args: { code: string; state: string; verifier: string; redirectUri: string },
  options: FetchOptions = {},
): Promise<EngineSignIn> => {
  const response = await postToken(
    {
      grant_type: "authorization_code",
      client_id: ANTHROPIC_OAUTH.clientId,
      code: args.code,
      state: args.state,
      redirect_uri: args.redirectUri,
      code_verifier: args.verifier,
    },
    options,
  );
  if (!response.ok) {
    throw new Error(`Claude rejected the sign-in (${response.status}). Start again.`);
  }
  const json = (await response.json()) as EngineTokenResponse;
  const tokens = tokensFromResponse(json);
  let profile: Parameters<typeof anthropicIdentity>[1] = null;
  try {
    const profileResponse = await timedFetch(options, 5_000, ANTHROPIC_OAUTH.profileUrl, {
      headers: {
        authorization: `Bearer ${tokens.access}`,
        "anthropic-beta": "oauth-2025-04-20",
        accept: "application/json",
      },
    });
    if (profileResponse.ok) profile = (await profileResponse.json()) as typeof profile;
  } catch {
    // Signed in without the plan.
  }
  return { tokens, identity: anthropicIdentity(json, profile) };
};

/**
 * Trade a Claude refresh token for new tokens. Refresh tokens rotate: the one
 * passed in stops working once this succeeds, so only the device holding the
 * account's refresh lease may call it. Throws `EngineRefreshRejectedError`
 * when Anthropic refused the token itself (sign in again), any other error
 * when the attempt could be retried.
 */
export const refreshAnthropicTokens = async (
  refreshToken: string,
  options: FetchOptions = {},
): Promise<EngineTokens> => {
  const response = await postToken(
    {
      grant_type: "refresh_token",
      client_id: ANTHROPIC_OAUTH.clientId,
      refresh_token: refreshToken,
    },
    options,
  );
  if (response.status === 400 || response.status === 401) {
    throw new EngineRefreshRejectedError("Claude refused to refresh this sign-in. Sign in again.");
  }
  if (!response.ok) throw new Error(`Claude token refresh failed (${response.status}).`);
  return tokensFromResponse((await response.json()) as EngineTokenResponse);
};
