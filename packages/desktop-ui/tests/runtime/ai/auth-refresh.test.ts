import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isUnauthorizedProviderError,
  requestWithAuthRefresh,
} from "@stella/runtime/ai/providers/auth-refresh";
import { streamSimpleOpenAIResponses } from "@stella/runtime/ai/providers/openai-responses";
import { buildBaseOptions } from "@stella/runtime/ai/providers/simple-options";
import type { Model } from "@stella/runtime/ai/types";

const model = {
  id: "test-model",
  name: "Test model",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} satisfies Model<"openai-responses">;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("provider auth refresh", () => {
  it("preserves the refresh callback through simple provider options", () => {
    const refreshApiKey = vi.fn(async () => "fresh-token");

    expect(buildBaseOptions(model, { refreshApiKey }).refreshApiKey).toBe(
      refreshApiKey,
    );
  });

  it("refreshes once and retries a 401 before returning the response", async () => {
    const request = vi
      .fn<(apiKey: string) => Promise<string>>()
      .mockRejectedValueOnce(
        Object.assign(new Error("401 Unauthorized"), { status: 401 }),
      )
      .mockResolvedValueOnce("ok");
    const refreshApiKey = vi.fn(async () => "fresh-token");

    await expect(
      requestWithAuthRefresh({
        apiKey: "stale-token",
        refreshApiKey,
        request,
      }),
    ).resolves.toBe("ok");
    expect(refreshApiKey).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenNthCalledWith(1, "stale-token");
    expect(request).toHaveBeenNthCalledWith(2, "fresh-token");
  });

  it("does not refresh non-auth failures", async () => {
    const failure = Object.assign(new Error("rate limited"), { status: 429 });
    const request = vi.fn(async () => {
      throw failure;
    });
    const refreshApiKey = vi.fn(async () => "fresh-token");

    await expect(
      requestWithAuthRefresh({
        apiKey: "current-token",
        refreshApiKey,
        request,
      }),
    ).rejects.toBe(failure);
    expect(refreshApiKey).not.toHaveBeenCalled();
    expect(isUnauthorizedProviderError(failure)).toBe(false);
  });

  it("wires the refreshed credential into an OpenAI-compatible retry", async () => {
    const authorizationHeaders: Array<string | null> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      authorizationHeaders.push(request.headers.get("authorization"));
      return new Response(
        JSON.stringify({ error: { message: "401 Unauthorized" } }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;
    const refreshApiKey = vi.fn(async () => "fresh-token");

    const result = await streamSimpleOpenAIResponses(
      model,
      { messages: [] },
      { apiKey: "stale-token", refreshApiKey },
    ).result();

    expect(result.stopReason).toBe("error");
    expect(refreshApiKey).toHaveBeenCalledTimes(1);
    expect(authorizationHeaders).toEqual([
      "Bearer stale-token",
      "Bearer fresh-token",
    ]);
  });
});
