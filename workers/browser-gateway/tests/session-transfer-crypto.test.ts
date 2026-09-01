import { describe, expect, test } from "bun:test";
import { stableJson } from "../src/protocol.js";
import {
  SESSION_TRANSFER_ALGORITHM,
  createSessionTransferKeyPair,
  decryptSessionTransfer,
  toBase64Url,
} from "../src/session-transfer-crypto.js";

const fromBase64Url = (value: string): Uint8Array => {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const ownedBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

export const encryptAsClient = async (args: {
  publicKey: string;
  binding: {
    capabilityId: string;
    interactionId: string;
    interactionRevision: number;
    displayOrigin: string;
  };
  payload: unknown;
}) => {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const serverPublicKey = await crypto.subtle.importKey(
    "raw",
    ownedBuffer(fromBase64Url(args.publicKey)),
    { name: "X25519" },
    false,
    [],
  );
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "X25519", public: serverPublicKey },
    pair.privateKey,
    256,
  );
  const aad = new TextEncoder().encode(
    stableJson({
      schemaVersion: 1,
      purpose: "stella-cloud-browser-session-transfer",
      ...args.binding,
    }),
  );
  const saltDigest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", ownedBuffer(aad)),
  );
  const saltHex = Array.from(saltDigest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    sharedSecret,
    "HKDF",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(saltHex),
      info: aad,
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    new TextEncoder().encode(stableJson(args.payload)),
  );
  return {
    schemaVersion: 1 as const,
    algorithm: SESSION_TRANSFER_ALGORITHM,
    capabilityId: args.binding.capabilityId,
    clientPublicKey: toBase64Url(
      new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    ),
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
  };
};

describe("cloud browser session transfer crypto", () => {
  test("decrypts only the exact interaction-bound client envelope", async () => {
    const keys = await createSessionTransferKeyPair();
    const binding = {
      capabilityId: "00000000-0000-4000-8000-000000000001",
      interactionId: "00000000-0000-4000-8000-000000000002",
      interactionRevision: 1,
      displayOrigin: "https://app.example",
    };
    const payload = {
      cookies: [
        {
          name: "session",
          value: "private-cookie",
          domain: "app.example",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [],
    };
    const transfer = await encryptAsClient({
      publicKey: keys.publicKey,
      binding,
      payload,
    });
    await expect(
      decryptSessionTransfer({
        transfer,
        privateKeyPkcs8: keys.privateKeyPkcs8,
        binding,
      }),
    ).resolves.toEqual(payload);
    await expect(
      decryptSessionTransfer({
        transfer,
        privateKeyPkcs8: keys.privateKeyPkcs8,
        binding: { ...binding, displayOrigin: "https://evil.example" },
      }),
    ).rejects.toMatchObject({ code: "verification_failed" });
  });
});
