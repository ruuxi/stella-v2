import { describe, expect, it } from "vitest";
import {
  isUnauthorizedProviderError,
  requestWithAuthRefresh,
} from "../ai/providers/auth-refresh.js";

describe("provider authorization failures", () => {
  it("recognizes bounded nested errors without accepting malformed status carriers", () => {
    expect(
      isUnauthorizedProviderError({
        cause: { response: { error: { status: 401 } } },
      }),
    ).toBe(true);
    expect(
      isUnauthorizedProviderError({
        cause: { cause: { cause: { cause: { status: 401 } } } },
      }),
    ).toBe(false);
    expect(
      isUnauthorizedProviderError({ status: 500, cause: { status: 401 } }),
    ).toBe(false);
    expect(
      isUnauthorizedProviderError({
        status: Infinity,
        response: { status: 401 },
      }),
    ).toBe(true);
    expect(isUnauthorizedProviderError({ status: NaN })).toBe(false);
    expect(isUnauthorizedProviderError({ status: "401" })).toBe(false);
    expect(
      isUnauthorizedProviderError(Object.assign([], { status: 401 })),
    ).toBe(false);
    expect(isUnauthorizedProviderError(new Error("Unauthorized request"))).toBe(
      true,
    );
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(isUnauthorizedProviderError(cyclic)).toBe(false);
  });

  it("refreshes a rejected credential once before exposing a result", async () => {
    const keys: string[] = [];
    let refreshes = 0;
    const result = await requestWithAuthRefresh({
      apiKey: "old",
      refreshApiKey: async () => {
        refreshes++;
        return " fresh ";
      },
      request: async (key) => {
        keys.push(key);
        if (key === "old") throw { response: { status: 401 } };
        return "reply";
      },
    });
    expect(result).toBe("reply");
    expect(keys).toEqual(["old", "fresh"]);
    expect(refreshes).toBe(1);
  });

  it("preserves the original failure if credential renewal fails", async () => {
    const failure = new Error("401");
    await expect(
      requestWithAuthRefresh({
        apiKey: "old",
        refreshApiKey: async () => {
          throw new Error("renewal failed");
        },
        request: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });
});
