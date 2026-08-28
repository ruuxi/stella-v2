import { describe, expect, test } from "bun:test";
import {
  decryptStorageState,
  encryptStorageState,
  type ProfileAad,
} from "../src/profile-crypto.js";
import { TEST_KEK } from "./fixtures.js";

const aad: ProfileAad = {
  schemaVersion: 1,
  keyVersion: "v1",
  ownerDigest: "1".repeat(64),
  profileDigest: "2".repeat(64),
  profileEpoch: 1,
  snapshotRevision: 1,
};

describe("profile envelope encryption", () => {
  test("round-trips cookies, local storage, and IndexedDB without plaintext", async () => {
    const marker = "private-cookie-and-indexeddb-marker";
    const state = {
      cookies: [{ name: "session", value: marker }],
      origins: [
        {
          origin: "https://app.example",
          localStorage: [{ name: "theme", value: "dark" }],
          indexedDB: [{ name: "auth", data: [{ value: marker }] }],
        },
      ],
    };
    const first = await encryptStorageState({
      storageState: state,
      aad,
      kekV1: TEST_KEK,
    });
    const second = await encryptStorageState({
      storageState: state,
      aad,
      kekV1: TEST_KEK,
    });
    expect(new TextDecoder().decode(first.bytes)).not.toContain(marker);
    expect(first.objectSha256).not.toBe(second.objectSha256);
    await expect(
      decryptStorageState({
        bytes: first.bytes,
        aad,
        kekV1: TEST_KEK,
        expectedObjectSha256: first.objectSha256,
      }),
    ).resolves.toEqual(state);
  });

  test("fails closed for tampering and an epoch mismatch", async () => {
    const encrypted = await encryptStorageState({
      storageState: { cookies: [], origins: [] },
      aad,
      kekV1: TEST_KEK,
    });
    const tampered = encrypted.bytes.slice();
    tampered[tampered.length - 3] ^= 1;
    await expect(
      decryptStorageState({ bytes: tampered, aad, kekV1: TEST_KEK }),
    ).rejects.toThrow();
    await expect(
      decryptStorageState({
        bytes: encrypted.bytes,
        aad: { ...aad, profileEpoch: 2 },
        kekV1: TEST_KEK,
      }),
    ).rejects.toThrow();
  });
});
