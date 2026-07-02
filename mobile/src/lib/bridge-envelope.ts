/**
 * Pure envelope core for the mobile↔desktop bridge: AES-GCM envelopes with
 * optional pre-encryption deflate, an anti-replay window, and the binary
 * frame lane. No Expo/React Native imports — randomness is injected — so the
 * whole protocol surface is testable under `bun test` and mirrors
 * `desktop/electron/services/mobile-bridge/crypto.ts` byte-for-byte.
 */
import { gcm } from "@noble/ciphers/aes.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { deflateSync, inflateSync } from "fflate";

export const BRIDGE_CRYPTO_PROTOCOL = "x25519-hkdf-sha256-aes-256-gcm-v1";

/**
 * Optional bridge features negotiated above the base protocol. The desktop
 * advertises its set in the `mobile:hello` response; the phone advertises its
 * own in the `X-Stella-Bridge-Features` header. All additive — a peer missing
 * one keeps the legacy path.
 */
export const BRIDGE_FEATURE_HELLO = "hello-v1";
export const BRIDGE_FEATURE_DEFLATE = "envelope-deflate";
export const BRIDGE_FEATURE_BINARY_FILE = "binary-file-lane";
export const BRIDGE_FEATURE_BINARY_UPLOAD = "binary-upload";
export const BRIDGE_FEATURE_LOCAL_CHAT_PUSH = "localchat-push";

/** Features this phone build supports receiving, sent on every request. */
export const MOBILE_SUPPORTED_BRIDGE_FEATURES = [
  BRIDGE_FEATURE_DEFLATE,
] as const;

export type BridgeCryptoDirection = "m2d" | "d2m";

export type BridgeEncryptedEnvelope = {
  v: 1;
  alg: typeof BRIDGE_CRYPTO_PROTOCOL;
  sid: string;
  seq: number;
  iv: string;
  ct: string;
  /** 1 = plaintext was raw-deflated before encryption (feature-gated). */
  z?: 1;
};

export type BridgeCryptoSession = {
  sessionId: string;
  key: Uint8Array;
  txSeq: number;
  /** Anti-replay window over received envelope/binary seqs (lazy). */
  rx?: BridgeReplayGuard;
};

export type RandomBytesFn = (byteLength: number) => Uint8Array;

const BASE64_URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64_URL_LOOKUP = new Map(
  [...BASE64_URL_ALPHABET].map((char, index) => [char, index]),
);

export const bytesToBase64Url = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += BASE64_URL_ALPHABET[(n >> 18) & 63];
    out += BASE64_URL_ALPHABET[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += BASE64_URL_ALPHABET[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += BASE64_URL_ALPHABET[n & 63];
  }
  return out;
};

export const base64UrlToBytes = (value: string) => {
  let buffer = 0;
  let bits = 0;
  const out: number[] = [];
  for (const char of value) {
    const next = BASE64_URL_LOOKUP.get(char);
    if (next === undefined) {
      throw new Error("Invalid base64url value");
    }
    buffer = (buffer << 6) | next;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
};

const STANDARD_BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const STANDARD_BASE64_LOOKUP = new Map(
  [...STANDARD_BASE64_ALPHABET].map((char, index) => [char, index]),
);

/** Decode standard (`+/`, padded) base64 — the flavor data URLs use. */
export const standardBase64ToBytes = (value: string) => {
  let buffer = 0;
  let bits = 0;
  const out: number[] = [];
  for (const char of value) {
    if (char === "=" || char === "\n" || char === "\r") continue;
    const next = STANDARD_BASE64_LOOKUP.get(char);
    if (next === undefined) {
      throw new Error("Invalid base64 value");
    }
    buffer = (buffer << 6) | next;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
};

/** Split a `data:<mime>;base64,<payload>` URL. Returns null when not one. */
export const parseBase64DataUrl = (
  url: string,
): { mimeType: string; base64: string } | null => {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
  if (!match) return null;
  return { mimeType: match[1] ?? "application/octet-stream", base64: match[2] ?? "" };
};

export const bytesToUtf8 = (bytes: Uint8Array): string => {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8").decode(bytes);
  }
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  try {
    return decodeURIComponent(escape(out));
  } catch {
    return out;
  }
};

export const isBridgeEncryptedEnvelope = (
  value: unknown,
): value is BridgeEncryptedEnvelope => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    record.alg === BRIDGE_CRYPTO_PROTOCOL &&
    typeof record.sid === "string" &&
    typeof record.seq === "number" &&
    typeof record.iv === "string" &&
    typeof record.ct === "string"
  );
};

// ── Anti-replay window ──────────────────────────────────────────────────
// Strict monotonic rejection would break legitimate traffic (concurrent HTTP
// responses complete out of order), so — as in DTLS/IPsec — accept any unseen
// seq newer than `maxSeen - window`, reject duplicates and stale ones.

export type BridgeReplayGuard = {
  /** Throws on a replayed or too-old sequence number; records fresh ones. */
  check: (seq: number) => void;
};

export const BRIDGE_REPLAY_WINDOW = 128;

export const createBridgeReplayGuard = (
  windowSize = BRIDGE_REPLAY_WINDOW,
): BridgeReplayGuard => {
  let maxSeen = 0;
  const seen = new Set<number>();
  return {
    check: (seq: number) => {
      if (!Number.isInteger(seq) || seq <= 0) {
        throw new Error("Bridge envelope replay rejected (invalid seq)");
      }
      if (seq <= maxSeen - windowSize) {
        throw new Error("Bridge envelope replay rejected (stale seq)");
      }
      if (seen.has(seq)) {
        throw new Error("Bridge envelope replay rejected (duplicate seq)");
      }
      seen.add(seq);
      if (seq > maxSeen) {
        maxSeen = seq;
        for (const value of seen) {
          if (value <= maxSeen - windowSize) {
            seen.delete(value);
          }
        }
      }
    },
  };
};

export const getSessionReplayGuard = (
  session: BridgeCryptoSession,
): BridgeReplayGuard => {
  if (!session.rx) {
    session.rx = createBridgeReplayGuard();
  }
  return session.rx;
};

// ── JSON envelope lane ──────────────────────────────────────────────────

const envelopeAad = (
  sessionId: string,
  direction: BridgeCryptoDirection,
  seq: number,
) =>
  utf8ToBytes(
    [BRIDGE_CRYPTO_PROTOCOL, sessionId, direction, String(seq)].join("\n"),
  );

export const encryptBridgePayloadCore = (
  session: BridgeCryptoSession,
  direction: BridgeCryptoDirection,
  payload: unknown,
  randomBytes: RandomBytesFn,
  options?: {
    /**
     * Deflate the JSON plaintext before encryption. Only pass true when the
     * peer advertised BRIDGE_FEATURE_DEFLATE — an old peer would decrypt to
     * binary garbage. Skipped automatically when it doesn't shrink.
     */
    compress?: boolean;
  },
): BridgeEncryptedEnvelope => {
  const seq = ++session.txSeq;
  const iv = randomBytes(12);
  const json = utf8ToBytes(JSON.stringify(payload));
  let plaintext = json;
  let compressed = false;
  if (options?.compress) {
    const deflated = deflateSync(json);
    if (deflated.length < json.length) {
      plaintext = deflated;
      compressed = true;
    }
  }
  const ciphertext = gcm(
    session.key,
    iv,
    envelopeAad(session.sessionId, direction, seq),
  ).encrypt(plaintext);
  return {
    v: 1,
    alg: BRIDGE_CRYPTO_PROTOCOL,
    sid: session.sessionId,
    seq,
    iv: bytesToBase64Url(iv),
    ct: bytesToBase64Url(ciphertext),
    ...(compressed ? { z: 1 as const } : {}),
  };
};

export const decryptBridgePayloadCore = (
  session: BridgeCryptoSession,
  direction: BridgeCryptoDirection,
  envelope: BridgeEncryptedEnvelope,
  replayGuard?: BridgeReplayGuard,
): unknown => {
  if (envelope.sid !== session.sessionId) {
    throw new Error("Bridge envelope session mismatch");
  }
  const plaintext = gcm(
    session.key,
    base64UrlToBytes(envelope.iv),
    envelopeAad(session.sessionId, direction, envelope.seq),
  ).decrypt(base64UrlToBytes(envelope.ct));
  // Only trust the compression flag after authenticated decryption succeeded.
  replayGuard?.check(envelope.seq);
  const json = envelope.z === 1 ? inflateSync(plaintext) : plaintext;
  return JSON.parse(bytesToUtf8(json)) as unknown;
};

// ── Binary frame lane ───────────────────────────────────────────────────
// Raw file bytes encrypted directly (no JSON, no base64); seq/iv ride HTTP
// headers. The `bin` AAD marker keeps binary ciphertexts and JSON envelopes
// mutually non-replayable. Deliberately NOT compressed — the payloads are
// already-entropy-coded formats (images, PDFs, media).

const binaryAad = (
  sessionId: string,
  direction: BridgeCryptoDirection,
  seq: number,
) =>
  utf8ToBytes(
    [BRIDGE_CRYPTO_PROTOCOL, sessionId, direction, "bin", String(seq)].join(
      "\n",
    ),
  );

export type BridgeBinaryFrame = {
  seq: number;
  /** base64url, 12 bytes. */
  iv: string;
  /** Raw ciphertext (plaintext length + 16-byte GCM tag). */
  ciphertext: Uint8Array;
};

export const encryptBridgeBytesCore = (
  session: BridgeCryptoSession,
  direction: BridgeCryptoDirection,
  bytes: Uint8Array,
  randomBytes: RandomBytesFn,
): BridgeBinaryFrame => {
  const seq = ++session.txSeq;
  const iv = randomBytes(12);
  const ciphertext = gcm(
    session.key,
    iv,
    binaryAad(session.sessionId, direction, seq),
  ).encrypt(bytes);
  return { seq, iv: bytesToBase64Url(iv), ciphertext };
};

export const decryptBridgeBytesCore = (
  session: BridgeCryptoSession,
  direction: BridgeCryptoDirection,
  frame: BridgeBinaryFrame,
  replayGuard?: BridgeReplayGuard,
): Uint8Array => {
  const plaintext = gcm(
    session.key,
    base64UrlToBytes(frame.iv),
    binaryAad(session.sessionId, direction, frame.seq),
  ).decrypt(frame.ciphertext);
  replayGuard?.check(frame.seq);
  return plaintext;
};

/** True when the invoked bridge channel doesn't exist on the peer desktop. */
export const isUnknownBridgeChannelError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    message.includes("Unknown IPC channel") ||
    message.includes("Disallowed IPC channel")
  );
};
