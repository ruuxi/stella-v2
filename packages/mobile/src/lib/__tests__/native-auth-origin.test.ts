import { describe, expect, mock, test } from "bun:test";

(globalThis as Record<string, unknown>).__DEV__ = false;

mock.module("react-native", () => ({ Platform: { OS: "ios" } }));

mock.module("expo-secure-store", () => ({
  getItem: () => null,
  setItem: () => {},
  deleteItemAsync: async () => {},
  getItemAsync: async () => null,
  setItemAsync: async () => {},
}));

mock.module("expo-linking", () => ({
  createURL: (path: string, options?: { scheme?: string }) =>
    `${options?.scheme ?? "stella-mobile"}://${path.replace(/^\//, "")}`,
}));

mock.module("../verify-one-time-token", () => ({
  verifyOneTimeToken: async () => null,
}));

const { nativeBearerClient } = await import("../native-auth-client");

type AnyOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
};

/**
 * Replicates better-fetch's `initializePlugins` loop. Every plugin's `init` is
 * called with the ORIGINAL options object and only the LAST return value is
 * kept, so a sibling plugin that mutates and returns that original silently
 * discards anything an earlier plugin handed back in a copy. `mutatingSibling`
 * stands in for any such plugin (Better Auth's cross-domain client is the
 * shipped example) so the test fails if our plugin stops mutating in place.
 */
const runPluginChain = async (url: string, original: AnyOptions) => {
  // bun's mock.module registry is global; re-assert before the import-time
  // bindings are exercised in case a sibling test file replaced the stub.
  mock.module("expo-secure-store", () => ({
    getItem: () => null,
    setItem: () => {},
    deleteItemAsync: async () => {},
    getItemAsync: async () => null,
    setItemAsync: async () => {},
  }));
  const ours = nativeBearerClient({ scheme: "stella-mobile" }).fetchPlugins[0];
  const mutatingSibling = {
    init: async (siblingUrl: string, options: AnyOptions | undefined) => {
      const opts = options ?? {};
      opts.credentials = "omit";
      opts.headers = { ...opts.headers, "better-auth-cookie": "stored" };
      return { url: siblingUrl, options: opts };
    },
  };
  let winner: AnyOptions = original;
  for (const plugin of [ours, mutatingSibling]) {
    const result = await plugin.init?.(url, original);
    winner = (result?.options as AnyOptions) ?? winner;
  }
  return winner;
};

describe("native auth client through the better-fetch plugin chain", () => {
  test("expo-origin survives for a native idToken sign-in", async () => {
    const final = await runPluginChain(
      "https://example.convex.site/api/auth/sign-in/social",
      { body: { provider: "apple", idToken: { token: "t", nonce: "n" } } },
    );
    expect(final.headers?.["expo-origin"]).toBe("stella-mobile://");
    expect(final.headers?.["better-auth-cookie"]).toBe("stored");
  });

  test("callbackURL is rewritten to the deep link for browser OAuth", async () => {
    const final = await runPluginChain(
      "https://example.convex.site/api/auth/sign-in/social",
      { body: { provider: "google", callbackURL: "/chat" } },
    );
    expect(final.headers?.["expo-origin"]).toBe("stella-mobile://");
    expect((final.body as { callbackURL?: string }).callbackURL).toBe(
      "stella-mobile://chat",
    );
  });
});
