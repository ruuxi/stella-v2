import { GatewayError } from "./errors.js";
import { sha256Hex, stableJson } from "./protocol.js";

export const SESSION_TRANSFER_ALGORITHM =
  "x25519-hkdf-sha256-aes-256-gcm-v1" as const;
export const MAX_SESSION_TRANSFER_PLAINTEXT_BYTES = 32 * 1024;
const X25519_PUBLIC_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;

export type SessionTransferBinding = Readonly<{
  capabilityId: string;
  interactionId: string;
  interactionRevision: number;
  displayOrigin: string;
}>;

export type EncryptedSessionTransfer = Readonly<{
  schemaVersion: 1;
  algorithm: typeof SESSION_TRANSFER_ALGORITHM;
  capabilityId: string;
  clientPublicKey: string;
  iv: string;
  ciphertext: string;
}>;

const ownedBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

export const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
};

const fromBase64Url = (value: string, maximum: number): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > maximum * 2) {
    throw new GatewayError("verification_failed", 409);
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + padding);
  } catch {
    throw new GatewayError("verification_failed", 409);
  }
  if (binary.length > maximum) {
    throw new GatewayError("verification_failed", 409);
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const transferAad = (binding: SessionTransferBinding): Uint8Array =>
  new TextEncoder().encode(
    stableJson({
      schemaVersion: 1,
      purpose: "stella-cloud-browser-session-transfer",
      ...binding,
    }),
  );

const deriveTransferKey = async (args: {
  privateKeyPkcs8: Uint8Array;
  peerPublicKey: Uint8Array;
  binding: SessionTransferBinding;
}): Promise<CryptoKey> => {
  try {
    const [privateKey, publicKey] = await Promise.all([
      crypto.subtle.importKey(
        "pkcs8",
        ownedBuffer(args.privateKeyPkcs8),
        { name: "X25519" },
        false,
        ["deriveBits"],
      ),
      crypto.subtle.importKey(
        "raw",
        ownedBuffer(args.peerPublicKey),
        { name: "X25519" },
        false,
        [],
      ),
    ]);
    const sharedSecret = await crypto.subtle.deriveBits(
      { name: "X25519", public: publicKey },
      privateKey,
      256,
    );
    const aad = transferAad(args.binding);
    const saltHex = await sha256Hex(aad);
    const hkdfKey = await crypto.subtle.importKey(
      "raw",
      sharedSecret,
      "HKDF",
      false,
      ["deriveKey"],
    );
    return await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: ownedBuffer(new TextEncoder().encode(saltHex)),
        info: ownedBuffer(aad),
      },
      hkdfKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
  } catch {
    throw new GatewayError("verification_failed", 409);
  }
};

export const createSessionTransferKeyPair = async (): Promise<{
  publicKey: string;
  privateKeyPkcs8: string;
}> => {
  try {
    const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const [publicKey, privateKey] = await Promise.all([
      crypto.subtle.exportKey("raw", pair.publicKey),
      crypto.subtle.exportKey("pkcs8", pair.privateKey),
    ]);
    return {
      publicKey: toBase64Url(new Uint8Array(publicKey)),
      privateKeyPkcs8: toBase64Url(new Uint8Array(privateKey)),
    };
  } catch {
    throw new GatewayError("internal_error", 500);
  }
};

export const decryptSessionTransfer = async (args: {
  transfer: EncryptedSessionTransfer;
  privateKeyPkcs8: string;
  binding: SessionTransferBinding;
}): Promise<unknown> => {
  if (
    args.transfer.schemaVersion !== 1 ||
    args.transfer.algorithm !== SESSION_TRANSFER_ALGORITHM ||
    args.transfer.capabilityId !== args.binding.capabilityId
  ) {
    throw new GatewayError("verification_failed", 409);
  }
  const clientPublicKey = fromBase64Url(
    args.transfer.clientPublicKey,
    X25519_PUBLIC_KEY_BYTES,
  );
  const iv = fromBase64Url(args.transfer.iv, GCM_IV_BYTES);
  const ciphertext = fromBase64Url(
    args.transfer.ciphertext,
    MAX_SESSION_TRANSFER_PLAINTEXT_BYTES + 32,
  );
  if (
    clientPublicKey.byteLength !== X25519_PUBLIC_KEY_BYTES ||
    iv.byteLength !== GCM_IV_BYTES ||
    ciphertext.byteLength < 18
  ) {
    throw new GatewayError("verification_failed", 409);
  }
  const aad = transferAad(args.binding);
  const key = await deriveTransferKey({
    privateKeyPkcs8: fromBase64Url(args.privateKeyPkcs8, 96),
    peerPublicKey: clientPublicKey,
    binding: args.binding,
  });
  try {
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: ownedBuffer(iv),
          additionalData: ownedBuffer(aad),
        },
        key,
        ownedBuffer(ciphertext),
      ),
    );
    if (
      plaintext.byteLength < 2 ||
      plaintext.byteLength > MAX_SESSION_TRANSFER_PLAINTEXT_BYTES
    ) {
      throw new Error("invalid transfer size");
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
    ) as unknown;
  } catch {
    throw new GatewayError("verification_failed", 409);
  }
};
