import { afterAll, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AppIntegrityProof } from "@stella/contracts/app-integrity";

const originalDevDescriptor = Object.getOwnPropertyDescriptor(globalThis, "__DEV__");
Object.defineProperty(globalThis, "__DEV__", {
  value: false,
  configurable: true,
  writable: true,
});

let platform: "android" | "ios" = "ios";
const secureStore = new Map<string, string>();
const attestCalls: { keyId: string; challenge: string }[] = [];
const assertionCalls: { keyId: string; challenge: string }[] = [];
const requestHashes: string[] = [];
let generatedKeyCount = 0;
let providerPrepareCount = 0;
let integrityRequestFailures = 0;

mock.module("react-native", () => ({
  Platform: {
    get OS() {
      return platform;
    },
  },
}));

mock.module("expo-secure-store", () => ({
  getItem: (key: string) => secureStore.get(key) ?? null,
  setItem: (key: string, value: string) => {
    secureStore.set(key, value);
  },
  getItemAsync: async (key: string) => secureStore.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    secureStore.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    secureStore.delete(key);
  },
}));

mock.module("@expo/app-integrity", () => ({
  isSupported: true,
  generateKeyAsync: async () => {
    generatedKeyCount += 1;
    return "a2V5LTE=";
  },
  attestKeyAsync: async (keyId: string, challenge: string) => {
    attestCalls.push({ keyId, challenge });
    return "YXR0ZXN0YXRpb24=";
  },
  generateAssertionAsync: async (keyId: string, challenge: string) => {
    assertionCalls.push({ keyId, challenge });
    return "YXNzZXJ0aW9u";
  },
  prepareIntegrityTokenProviderAsync: async (projectNumber: string) => {
    expect(projectNumber).toBe("1234567890");
    providerPrepareCount += 1;
  },
  requestIntegrityCheckAsync: async (requestHash: string) => {
    requestHashes.push(requestHash);
    if (integrityRequestFailures > 0) {
      integrityRequestFailures -= 1;
      throw new Error("provider expired");
    }
    return "play-integrity-token";
  },
}));

mock.module("../../config/env", () => ({
  env: {
    convexSiteUrl: "https://convex.example",
    playIntegrityProjectNumber: "1234567890",
  },
}));

const originalFetch = globalThis.fetch;
let nonceSequence = 0;
globalThis.fetch = Object.assign(
  async () => {
    nonceSequence += 1;
    return new Response(
      JSON.stringify({
        nonce: `nonce-${String(nonceSequence).padStart(16, "0")}`,
        expiresAt: Date.now() + 60_000,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  },
  { preconnect: originalFetch.preconnect },
);

const {
  getAppIntegrityProof,
  isIntegrityKeyUnknown,
  requestWithAppIntegrity,
} = await import("../app-integrity");
const {
  appIntegrityChallengeString,
  decodeAppIntegrityProof,
} = await import("@stella/contracts/app-integrity");

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalDevDescriptor) {
    Object.defineProperty(globalThis, "__DEV__", originalDevDescriptor);
  } else {
    delete (globalThis as Record<string, unknown>).__DEV__;
  }
  mock.restore();
});

describe("mobile app integrity", () => {
  test("attests on iOS first use, asserts afterwards, re-attests unknown keys, and hashes Android requests", async () => {
    platform = "ios";

    const firstProof = decodeAppIntegrityProof(
      await getAppIntegrityProof("anonymous-sign-in"),
    );
    expect(firstProof).toEqual({
      platform: "ios",
      purpose: "anonymous-sign-in",
      nonce: "nonce-0000000000000001",
      keyId: "a2V5LTE=",
      attestation: "YXR0ZXN0YXRpb24=",
    });
    expect(generatedKeyCount).toBe(1);
    expect(attestCalls).toEqual([
      {
        keyId: "a2V5LTE=",
        challenge: appIntegrityChallengeString(
          "anonymous-sign-in",
          "nonce-0000000000000001",
        ),
      },
    ]);

    const secondProof = decodeAppIntegrityProof(
      await getAppIntegrityProof("magic-link"),
    );
    expect(secondProof).toEqual({
      platform: "ios",
      purpose: "magic-link",
      nonce: "nonce-0000000000000002",
      keyId: "a2V5LTE=",
      assertion: "YXNzZXJ0aW9u",
    });

    const attemptedProofs: AppIntegrityProof[] = [];
    const retryResult = await requestWithAppIntegrity({
      purpose: "anonymous-sign-in",
      request: async (encodedProof) => {
        const proof = decodeAppIntegrityProof(encodedProof);
        if (!proof) throw new Error("expected an integrity proof");
        attemptedProofs.push(proof);
        return attemptedProofs.length === 1
          ? { error: { code: "integrity_key_unknown" } }
          : { ok: true };
      },
      isIntegrityKeyUnknown: (result) => isIntegrityKeyUnknown(result),
    });
    expect(retryResult).toEqual({ ok: true });
    expect(attemptedProofs).toEqual([
      {
        platform: "ios",
        purpose: "anonymous-sign-in",
        nonce: "nonce-0000000000000003",
        keyId: "a2V5LTE=",
        assertion: "YXNzZXJ0aW9u",
      },
      {
        platform: "ios",
        purpose: "anonymous-sign-in",
        nonce: "nonce-0000000000000004",
        keyId: "a2V5LTE=",
        attestation: "YXR0ZXN0YXRpb24=",
      },
    ]);

    platform = "android";
    integrityRequestFailures = 1;
    const androidProof = decodeAppIntegrityProof(
      await getAppIntegrityProof("magic-link"),
    );
    expect(androidProof).toEqual({
      platform: "android",
      purpose: "magic-link",
      nonce: "nonce-0000000000000005",
      token: "play-integrity-token",
    });
    const androidChallenge = appIntegrityChallengeString(
      "magic-link",
      "nonce-0000000000000005",
    );
    const expectedRequestHash = createHash("sha256")
      .update(androidChallenge, "utf8")
      .digest("base64url");
    expect(requestHashes).toEqual([expectedRequestHash, expectedRequestHash]);
    expect(providerPrepareCount).toBe(2);
  });
});
