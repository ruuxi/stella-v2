import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Attaching replaces the pairing code, and it must replace it exactly: the
 * same SecureStore keys, the same paired-ids bookkeeping, the same preferred
 * desktop. What it must NOT do is imply that the computer agreed to run
 * anything — the pair secret is this phone's transport key, and consent is a
 * separate fact this route never touches.
 */

// Expo's module setup runs on import and expects the RN global.
(globalThis as Record<string, unknown>).__DEV__ = false;

const store = new Map<string, string>();

mock.module("expo-secure-store", () => ({
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value);
  },
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    store.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    store.delete(key);
  },
}));

mock.module("react-native", () => ({ Platform: { OS: "ios" } }));

mock.module("../backend", () => ({
  getBackendClient: () => ({ call: async () => ({}) }),
}));

type Post = { path: string; body: unknown; options: unknown };
let posts: Post[] = [];
let postResponse: (post: Post) => unknown = () => ({});
mock.module("../http", () => ({
  backendOrigin: () => "https://backend.example",
  postJson: async (path: string, body: unknown, options: unknown) => {
    const post = { path, body, options };
    posts.push(post);
    const answer = postResponse(post);
    if (answer instanceof Error) throw answer;
    return answer;
  },
}));

const {
  attachPhoneAccess,
  ensurePhoneAccess,
  getPreferredPhoneAccess,
  getStoredPhoneAccess,
  listStoredPairedPhoneAccess,
} = await import("../phone-access");

const ACCESS_PREFIX = "stella-mobile_phone-access.desktop.";
const PREFERRED_KEY = "stella-mobile_phone-access.preferred-desktop-device-id";
const PAIRED_IDS_KEY = "stella-mobile_phone-access.paired-desktop-ids";
const MOBILE_ID_KEY = "stella-mobile_phone-access.mobile-device-id";

beforeEach(() => {
  store.clear();
  store.set(MOBILE_ID_KEY, "phone-a");
  posts = [];
  postResponse = () => ({
    desktopDeviceId: "desktop-fresh",
    approvedAt: 42,
    pairSecret: "attached-secret",
  });
});

describe("attaching this phone to a computer without a pairing code", () => {
  test("posts to the codeless route on the account's authority alone", async () => {
    const access = await attachPhoneAccess("desktop-fresh");

    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe("/api/mobile/pairing/attach");
    expect(posts[0]!.body).toEqual({
      desktopDeviceId: "desktop-fresh",
      mobileDeviceId: "phone-a",
      platform: "iPhone",
    });
    expect(posts[0]!.options).toEqual({ origin: "https://backend.example" });
    expect(access).toEqual({
      desktopDeviceId: "desktop-fresh",
      mobileDeviceId: "phone-a",
      pairSecret: "attached-secret",
      approvedAt: 42,
    });
  });

  test("grants reach and says nothing about remote execution", async () => {
    await attachPhoneAccess("desktop-fresh");

    // No consent field goes out, and nothing about consent comes back to be
    // stored: the only state this writes is the transport credential.
    expect(posts[0]!.body).not.toHaveProperty("enabled");
    expect(posts[0]!.body).not.toHaveProperty("remoteExecution");
    expect(posts.map((post) => post.path)).toEqual([
      "/api/mobile/pairing/attach",
    ]);
    const stored = await getStoredPhoneAccess("desktop-fresh");
    expect(Object.keys(stored ?? {}).sort()).toEqual([
      "approvedAt",
      "desktopDeviceId",
      "mobileDeviceId",
      "pairSecret",
    ]);
  });

  test("adds a second computer without displacing the first", async () => {
    postResponse = (post) => ({
      desktopDeviceId: (post.body as { desktopDeviceId: string })
        .desktopDeviceId,
      approvedAt: 43,
      pairSecret: "secret",
    });
    await attachPhoneAccess("desktop-one");
    await attachPhoneAccess("desktop-two");

    const paired = await listStoredPairedPhoneAccess();
    expect(paired.map((entry) => entry.desktopDeviceId)).toEqual([
      "desktop-one",
      "desktop-two",
    ]);
    expect(store.get(PREFERRED_KEY)).toBe("desktop-two");
  });
});

describe("the credential a dispatch needs", () => {
  test("uses stored access when this phone already has it", async () => {
    store.set(
      `${ACCESS_PREFIX}desktop-known`,
      JSON.stringify({
        desktopDeviceId: "desktop-known",
        mobileDeviceId: "phone-a",
        pairSecret: "existing-secret",
        approvedAt: 10,
      }),
    );
    store.set(PAIRED_IDS_KEY, JSON.stringify(["desktop-known"]));

    const access = await ensurePhoneAccess("desktop-known");
    expect(access.pairSecret).toBe("existing-secret");
    // Nothing is re-minted, and no request goes out at all.
    expect(posts).toHaveLength(0);
  });

  test("attaches when it does not, and keeps the refusal classifiable", async () => {
    const access = await ensurePhoneAccess("desktop-fresh");
    expect(access.pairSecret).toBe("attached-secret");
    expect(posts.map((post) => post.path)).toEqual([
      "/api/mobile/pairing/attach",
    ]);

    store.clear();
    store.set(MOBILE_ID_KEY, "phone-a");
    postResponse = () =>
      new Error("That computer is not signed in to this account.");
    await expect(ensurePhoneAccess("desktop-stranger")).rejects.toThrow(
      /not paired with this phone\. That computer is not signed in/,
    );
  });
});
