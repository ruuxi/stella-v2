import { GatewayError } from "./errors.js";
import { sha256Hex, stableJson } from "./protocol.js";

export const PROFILE_ENVELOPE_SCHEMA_VERSION = 1;
export const PROFILE_KEY_VERSION = "v1";
export const MAX_STORAGE_STATE_BYTES = 8 * 1024 * 1024;
const AES_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;

const ownedBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

export type ProfileAad = Readonly<{
  schemaVersion: 1;
  keyVersion: "v1";
  ownerDigest: string;
  profileDigest: string;
  profileEpoch: number;
  snapshotRevision: number;
}>;

export type EncryptedProfileEnvelope = Readonly<{
  schemaVersion: 1;
  keyVersion: "v1";
  aadSha256: string;
  wrapIv: string;
  wrappedDek: string;
  contentIv: string;
  ciphertext: string;
}>;

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
};

const fromBase64Url = (value: string, maximum: number): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > maximum * 2) {
    throw new GatewayError("snapshot_unavailable", 409);
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + padding);
  } catch {
    throw new GatewayError("snapshot_unavailable", 409);
  }
  if (binary.length > maximum) {
    throw new GatewayError("snapshot_unavailable", 409);
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const importAesKey = (bytes: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    ownedBuffer(bytes),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

export const decodeKekV1 = (encoded: string): Uint8Array => {
  const bytes = fromBase64Url(encoded.trim(), AES_KEY_BYTES);
  if (bytes.byteLength !== AES_KEY_BYTES) {
    throw new GatewayError("internal_error", 500);
  }
  return bytes;
};

const randomBytes = (
  length: number,
  entropy?: (bytes: Uint8Array) => Uint8Array,
): Uint8Array => {
  const bytes = entropy
    ? entropy(new Uint8Array(length))
    : crypto.getRandomValues(new Uint8Array(length));
  if (bytes.byteLength !== length) {
    throw new GatewayError("internal_error", 500);
  }
  return bytes;
};

const assertAad = (aad: ProfileAad): void => {
  if (
    aad.schemaVersion !== 1 ||
    aad.keyVersion !== PROFILE_KEY_VERSION ||
    !/^[a-f0-9]{64}$/u.test(aad.ownerDigest) ||
    !/^[a-f0-9]{64}$/u.test(aad.profileDigest) ||
    !Number.isSafeInteger(aad.profileEpoch) ||
    aad.profileEpoch < 1 ||
    !Number.isSafeInteger(aad.snapshotRevision) ||
    aad.snapshotRevision < 1
  ) {
    throw new GatewayError("internal_error", 500);
  }
};

export const encryptStorageState = async (args: {
  storageState: unknown;
  aad: ProfileAad;
  kekV1: string;
  entropy?: (bytes: Uint8Array) => Uint8Array;
}): Promise<{ bytes: Uint8Array; objectSha256: string }> => {
  assertAad(args.aad);
  const plaintext = new TextEncoder().encode(stableJson(args.storageState));
  if (
    plaintext.byteLength < 2 ||
    plaintext.byteLength > MAX_STORAGE_STATE_BYTES
  ) {
    throw new GatewayError("snapshot_unavailable", 409);
  }
  const aadBytes = new TextEncoder().encode(stableJson(args.aad));
  const kek = await importAesKey(decodeKekV1(args.kekV1));
  const dekBytes = randomBytes(AES_KEY_BYTES, args.entropy);
  const dek = await importAesKey(dekBytes);
  const wrapIv = randomBytes(GCM_IV_BYTES, args.entropy);
  const contentIv = randomBytes(GCM_IV_BYTES, args.entropy);

  const [wrappedDek, ciphertext, aadSha256] = await Promise.all([
    crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: ownedBuffer(wrapIv),
        additionalData: ownedBuffer(aadBytes),
      },
      kek,
      ownedBuffer(dekBytes),
    ),
    crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: ownedBuffer(contentIv),
        additionalData: ownedBuffer(aadBytes),
      },
      dek,
      ownedBuffer(plaintext),
    ),
    sha256Hex(aadBytes),
  ]);

  const envelope: EncryptedProfileEnvelope = {
    schemaVersion: PROFILE_ENVELOPE_SCHEMA_VERSION,
    keyVersion: PROFILE_KEY_VERSION,
    aadSha256,
    wrapIv: toBase64Url(wrapIv),
    wrappedDek: toBase64Url(new Uint8Array(wrappedDek)),
    contentIv: toBase64Url(contentIv),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
  };
  const bytes = new TextEncoder().encode(stableJson(envelope));
  return { bytes, objectSha256: await sha256Hex(bytes) };
};

const parseEnvelope = (bytes: Uint8Array): EncryptedProfileEnvelope => {
  if (bytes.byteLength < 64 || bytes.byteLength > MAX_STORAGE_STATE_BYTES * 2) {
    throw new GatewayError("snapshot_unavailable", 409);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new GatewayError("snapshot_unavailable", 409);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GatewayError("snapshot_unavailable", 409);
  }
  const envelope = value as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "keyVersion",
    "aadSha256",
    "wrapIv",
    "wrappedDek",
    "contentIv",
    "ciphertext",
  ];
  if (
    Object.keys(envelope).length !== keys.length ||
    keys.some((key) => !(key in envelope)) ||
    envelope.schemaVersion !== 1 ||
    envelope.keyVersion !== PROFILE_KEY_VERSION ||
    typeof envelope.aadSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(envelope.aadSha256) ||
    typeof envelope.wrapIv !== "string" ||
    typeof envelope.wrappedDek !== "string" ||
    typeof envelope.contentIv !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new GatewayError("snapshot_unavailable", 409);
  }
  return envelope as EncryptedProfileEnvelope;
};

export const decryptStorageState = async (args: {
  bytes: Uint8Array;
  aad: ProfileAad;
  kekV1: string;
  expectedObjectSha256?: string;
}): Promise<unknown> => {
  assertAad(args.aad);
  if (
    args.expectedObjectSha256 &&
    (await sha256Hex(args.bytes)) !== args.expectedObjectSha256
  ) {
    throw new GatewayError("snapshot_unavailable", 409);
  }
  const envelope = parseEnvelope(args.bytes);
  const aadBytes = new TextEncoder().encode(stableJson(args.aad));
  if ((await sha256Hex(aadBytes)) !== envelope.aadSha256) {
    throw new GatewayError("snapshot_unavailable", 409);
  }
  const wrapIv = fromBase64Url(envelope.wrapIv, GCM_IV_BYTES);
  const contentIv = fromBase64Url(envelope.contentIv, GCM_IV_BYTES);
  if (
    wrapIv.byteLength !== GCM_IV_BYTES ||
    contentIv.byteLength !== GCM_IV_BYTES
  ) {
    throw new GatewayError("snapshot_unavailable", 409);
  }
  try {
    const kek = await importAesKey(decodeKekV1(args.kekV1));
    const dekBytes = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ownedBuffer(wrapIv),
        additionalData: ownedBuffer(aadBytes),
      },
      kek,
      ownedBuffer(fromBase64Url(envelope.wrappedDek, AES_KEY_BYTES + 32)),
    );
    if (dekBytes.byteLength !== AES_KEY_BYTES) {
      throw new Error("invalid wrapped key");
    }
    const dek = await importAesKey(new Uint8Array(dekBytes));
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: ownedBuffer(contentIv),
          additionalData: ownedBuffer(aadBytes),
        },
        dek,
        ownedBuffer(
          fromBase64Url(envelope.ciphertext, MAX_STORAGE_STATE_BYTES + 32),
        ),
      ),
    );
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
    );
  } catch {
    throw new GatewayError("snapshot_unavailable", 409);
  }
};
