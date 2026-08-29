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

const initFor = async (body: Record<string, unknown>) => {
  // bun's mock.module registry is global, so sibling test files can replace
  // the expo-secure-store stub; re-assert ours immediately before the call.
  mock.module("expo-secure-store", () => ({
    getItem: () => null,
    setItem: () => {},
    deleteItemAsync: async () => {},
    getItemAsync: async () => null,
    setItemAsync: async () => {},
  }));
  const client = nativeBearerClient({ scheme: "stella-mobile" });
  const plugin = client.fetchPlugins[0];
  const result = await plugin.init?.("https://example.convex.site/api/auth", {
    body,
  });
  const headers = (result?.options?.headers ?? {}) as Record<string, string>;
  return headers;
};

describe("native auth client origin header", () => {
  test("sends expo-origin for a native idToken sign-in", async () => {
    // Regression: dropping this header on idToken flows made the server
    // reject native Google/Apple sign-in with MISSING_OR_NULL_ORIGIN.
    const headers = await initFor({ idToken: "apple-id-token" });
    expect(headers["expo-origin"]).toBe("stella-mobile://");
  });

  test("sends expo-origin for a non-idToken request", async () => {
    const headers = await initFor({ email: "someone@example.com" });
    expect(headers["expo-origin"]).toBe("stella-mobile://");
  });
});
