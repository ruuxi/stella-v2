import { beforeEach, describe, expect, mock, test } from "bun:test";

(globalThis as Record<string, unknown>).__DEV__ = false;

const store = new Map<string, string>();

mock.module("expo-secure-store", () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    store.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    store.delete(key);
  },
}));

mock.module("react-native", () => ({ Platform: { OS: "ios" } }));

mock.module("../bridge-crypto", () => ({
  createBridgeProofChallenge: () => "challenge",
  createMobileBridgePairProof: () => ({ issuedAt: 1, proof: "proof" }),
}));

let bridgeResponse: unknown = null;
mock.module("../http", () => ({
  getJson: async () => bridgeResponse,
  postJson: async () => ({}),
}));

const {
  getDesktopBridgeStatus,
  getPreferredPhoneAccess,
  listStoredPairedPhoneAccess,
} = await import("../phone-access");

const ACCESS_PREFIX = "stella-mobile_phone-access.desktop.";
const PREFERRED_KEY = "stella-mobile_phone-access.preferred-desktop-device-id";
const PAIRED_IDS_KEY = "stella-mobile_phone-access.paired-desktop-ids";

const OLD_ID = "desktop-retired";
const NEW_ID = "desktop-current";

const seedPairing = (desktopDeviceId: string) => {
  store.set(
    `${ACCESS_PREFIX}${desktopDeviceId}`,
    JSON.stringify({
      desktopDeviceId,
      mobileDeviceId: "phone-a",
      pairSecret: "pair-secret",
      approvedAt: 10,
    }),
  );
  store.set(PAIRED_IDS_KEY, JSON.stringify([desktopDeviceId]));
  store.set(PREFERRED_KEY, desktopDeviceId);
};

const bridgePayload = (desktopDeviceId: string) => ({
  available: true,
  baseUrls: ["https://desktop.example.com"],
  platform: "Mac",
  updatedAt: 20,
  lastKnownRegistration: {
    desktopDeviceId,
    baseUrls: ["https://desktop.example.com"],
    platform: "Mac",
    desktopPublicKey: "key",
    updatedAt: 20,
  },
});

beforeEach(() => {
  store.clear();
});

describe("desktop device id succession on the phone", () => {
  test("re-files the pairing under the desktop's current id", async () => {
    seedPairing(OLD_ID);
    bridgeResponse = bridgePayload(NEW_ID);

    await getDesktopBridgeStatus(OLD_ID);

    expect(store.has(`${ACCESS_PREFIX}${OLD_ID}`)).toBe(false);
    const preferred = await getPreferredPhoneAccess();
    expect(preferred?.desktopDeviceId).toBe(NEW_ID);

    expect(preferred?.pairSecret).toBe("pair-secret");
    expect(store.get(PREFERRED_KEY)).toBe(NEW_ID);
  });

  test("leaves a single entry in the paired desktop list", async () => {
    seedPairing(OLD_ID);
    bridgeResponse = bridgePayload(NEW_ID);

    await getDesktopBridgeStatus(OLD_ID);

    const paired = await listStoredPairedPhoneAccess();
    expect(paired.map((entry) => entry.desktopDeviceId)).toEqual([NEW_ID]);
  });

  test("does nothing when the id is unchanged", async () => {
    seedPairing(OLD_ID);
    bridgeResponse = bridgePayload(OLD_ID);

    await getDesktopBridgeStatus(OLD_ID);

    expect(store.has(`${ACCESS_PREFIX}${OLD_ID}`)).toBe(true);
    expect(store.get(PREFERRED_KEY)).toBe(OLD_ID);
  });

  test("does not re-file when no specific desktop was requested", async () => {
    seedPairing(OLD_ID);

    bridgeResponse = bridgePayload("some-other-desktop");

    await getDesktopBridgeStatus();

    expect(store.has(`${ACCESS_PREFIX}${OLD_ID}`)).toBe(true);
    expect(store.get(PREFERRED_KEY)).toBe(OLD_ID);
  });
});
