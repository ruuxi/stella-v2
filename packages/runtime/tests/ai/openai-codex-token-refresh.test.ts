import { afterEach, describe, expect, it, vi } from "vitest";

import { isUnauthorizedProviderError } from "@stella/runtime/ai/providers/auth-refresh";
import { streamOpenAICodexResponses } from "@stella/runtime/ai/providers/openai-codex-responses";
import type { Model } from "@stella/runtime/ai/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const accessTokenFor = (accountId: string): string => {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `header.${payload}.signature`;
};

const model: Model<"openai-codex-responses"> = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 SOL",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 400_000,
  maxTokens: 128_000,
};

// OpenAI's verbatim 401 body for a lapsed ChatGPT OAuth access token.
const TOKEN_EXPIRED_BODY = JSON.stringify({
  error: {
    code: "token_expired",
    message:
      "Provided authentication token is expired. Please try signing in again.",
  },
});

describe("OpenAI Codex ChatGPT token refresh", () => {
  it("recognizes ChatGPT's token_expired verdict as an auth failure", () => {
    expect(
      isUnauthorizedProviderError(
        new Error(
          "Codex error (token_expired): Provided authentication token is expired. Please try signing in again.",
        ),
      ),
    ).toBe(true);
    expect(
      isUnauthorizedProviderError(new Error("Provided authentication token is expired (token_expired)")),
    ).toBe(true);
    expect(isUnauthorizedProviderError(new Error("usage limit reached"))).toBe(false);
  });

  it("refreshes the credential once on 401 and retries with the new bearer", async () => {
    const staleToken = accessTokenFor("account-stale");
    const freshToken = accessTokenFor("account-fresh");
    const requests: Request[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      if (requests.length === 1) {
        return new Response(TOKEN_EXPIRED_BODY, {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      // Stop the stream deterministically after the retried request lands.
      return new Response(
        JSON.stringify({ error: { message: "usage limit: intentional test stop" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const refreshApiKey = vi.fn(async () => freshToken);

    const result = await streamOpenAICodexResponses(
      model,
      { messages: [] },
      { apiKey: staleToken, transport: "sse", refreshApiKey },
    ).result();

    expect(refreshApiKey).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${staleToken}`);
    expect(requests[0]?.headers.get("chatgpt-account-id")).toBe("account-stale");
    expect(requests[1]?.headers.get("authorization")).toBe(`Bearer ${freshToken}`);
    expect(requests[1]?.headers.get("chatgpt-account-id")).toBe("account-fresh");
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("usage limit");
  });

  it("surfaces the 401 without network retries when no refresh is available", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(TOKEN_EXPIRED_BODY, {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchSpy as typeof fetch;

    const result = await streamOpenAICodexResponses(
      model,
      { messages: [] },
      { apiKey: accessTokenFor("account-stale"), transport: "sse" },
    ).result();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(
      "Provided authentication token is expired. Please try signing in again. (token_expired)",
    );
  });

  it("keeps the original 401 when the refresh yields nothing", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(TOKEN_EXPIRED_BODY, {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchSpy as typeof fetch;
    const refreshApiKey = vi.fn(async () => undefined);

    const result = await streamOpenAICodexResponses(
      model,
      { messages: [] },
      { apiKey: accessTokenFor("account-stale"), transport: "sse", refreshApiKey },
    ).result();

    expect(refreshApiKey).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.errorMessage).toContain("token_expired");
  });
});
