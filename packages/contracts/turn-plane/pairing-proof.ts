/**
 * The mobile pairing proof a phone attaches to a placement submit.
 *
 * A paired phone has no Stella device key of its own that the cloud can
 * verify; what it has is the pairing secret the desktop showed it once. Both
 * sides keep only `sha256(pairSecret)` — the *pairing key* — and the phone
 * proves possession by HMAC-ing a canonical message with it. The owner
 * snapshot carries that key as `pairedDevices[].mobilePublicKey`, so the
 * cloud-builder can verify a submit without a Convex round trip.
 *
 * The scheme is byte-for-byte the one Convex's `/api/mobile/execution/submit`
 * used, so the phone, the worker, and Convex can all import this module and
 * agree without a second implementation:
 *
 *   pairingKey = lowercase-hex sha256(pairSecret)
 *   challenge  = "execution-placement-v1:{idempotencyKey}:{conversationId}
 *                 :{payloadHash}:{kind}:{subject}"                  (6 parts)
 *              + ":{targetMode}:{targetDeviceId}"  when a destination was named
 *   message    = "stella-mobile-bridge-pair-proof-v1\n{desktopDeviceId}
 *                 \n{mobileDeviceId}\n{challenge}\n{mobilePublicKey}
 *                 \n{issuedAt}"
 *   proof      = lowercase-hex HMAC-SHA256(key = utf8(pairingKey),
 *                                          message = utf8(message))
 *
 * `mobilePublicKey` inside the message is the phone's *bridge* x25519 key (an
 * unrelated value, empty when the phone has none); the HMAC key is always the
 * pairing key. Both are bound so a proof minted for one bridge session cannot
 * be replayed under another.
 *
 * Everything here is WebCrypto only: no node builtins, no third-party hashes,
 * so the same file runs in the worker, in Convex, and in React Native.
 */

import type { DispatchPayload } from "./placement.js";

export const MOBILE_PAIRING_PROOF_VERSION =
  "stella-mobile-bridge-pair-proof-v1" as const;

/** Prefix of the placement challenge the proof signs. */
export const MOBILE_PAIRING_CHALLENGE_VERSION =
  "execution-placement-v1" as const;

/** A proof older or newer than this is refused outright. */
export const MOBILE_PAIRING_PROOF_MAX_SKEW_MS = 5 * 60_000;

/** Headers a mobile submit carries. Lowercase: `Headers` is case-insensitive. */
export const MOBILE_PAIRING_HEADERS = {
  mobileDeviceId: "x-stella-mobile-device-id",
  /** The paired desktop this proof is scoped to (the grant). */
  desktopDeviceId: "x-stella-mobile-desktop-device-id",
  proof: "x-stella-mobile-pair-proof",
  issuedAt: "x-stella-mobile-pair-proof-issued-at",
  challenge: "x-stella-mobile-pair-proof-challenge",
  /** Optional bridge public key bound into the proof. */
  mobilePublicKey: "x-stella-mobile-public-key",
} as const;

export const MOBILE_PAIRING_LIMITS = {
  deviceId: 256,
  challenge: 512,
  publicKey: 128,
  proof: 128,
} as const;

export type MobilePairingChallengeInput = {
  idempotencyKey: string;
  conversationId: string;
  /** Lowercase hex sha256 of the exact payload JSON bytes. */
  payloadHash: string;
  kind: "chat" | "agent";
  subject: "portable" | "computer" | "cloud";
  /**
   * Destination intent. Omit both to sign the six-field challenge; naming
   * either appends `targetMode` and `targetDeviceId` (empty when absent), so
   * a phone can never have its destination rewritten under a signed proof.
   */
  targetMode?: "automatic" | "cloud" | "device";
  targetDeviceId?: string;
};

export const buildMobilePairingChallenge = (
  input: MobilePairingChallengeInput,
): string => {
  const parts: string[] = [
    MOBILE_PAIRING_CHALLENGE_VERSION,
    input.idempotencyKey,
    input.conversationId,
    input.payloadHash,
    input.kind,
    input.subject,
  ];
  if (input.targetMode !== undefined || input.targetDeviceId) {
    parts.push(input.targetMode ?? "automatic", input.targetDeviceId ?? "");
  }
  return parts.join(":");
};

export type MobilePairingProofMessageInput = {
  desktopDeviceId: string;
  mobileDeviceId: string;
  challenge: string;
  /** The phone's bridge public key, when it has one. */
  mobilePublicKey?: string;
  issuedAt: number;
};

/** A tuple joined by newlines: no key ordering to disagree about. */
export const buildMobilePairingProofMessage = (
  input: MobilePairingProofMessageInput,
): string =>
  [
    MOBILE_PAIRING_PROOF_VERSION,
    input.desktopDeviceId,
    input.mobileDeviceId,
    input.challenge,
    input.mobilePublicKey ?? "",
    String(input.issuedAt),
  ].join("\n");

// ---------------------------------------------------------------------------
// WebCrypto primitives
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Lowercase hex SHA-256 of a UTF-8 string. */
export const sha256Hex = async (value: string): Promise<string> =>
  toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));

/** Lowercase hex HMAC-SHA256; the key is the UTF-8 bytes of `key`. */
export const hmacSha256Hex = async (
  key: string,
  message: string,
): Promise<string> => {
  const imported = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", imported, encoder.encode(message)),
    ),
  );
};

/**
 * The verifiable half of a pairing secret. The phone and Convex both store
 * only this; the raw secret never leaves the pairing exchange.
 */
export const deriveMobilePairingKey = (pairSecret: string): Promise<string> =>
  sha256Hex(pairSecret);

/** Length-checked first, then constant time over the compared bytes. */
export const constantTimeEqualHex = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
};

// ---------------------------------------------------------------------------
// Signing (phones and tests) and verification (the worker)
// ---------------------------------------------------------------------------

export type MobilePairingProofFields = {
  mobileDeviceId: string;
  desktopDeviceId: string;
  challenge: string;
  proof: string;
  issuedAt: number;
  mobilePublicKey?: string;
};

export const signMobilePairingProof = async (
  input: Omit<MobilePairingProofFields, "proof" | "issuedAt"> & {
    pairingKey: string;
    issuedAt?: number;
  },
): Promise<{ issuedAt: number; proof: string }> => {
  const issuedAt = input.issuedAt ?? Date.now();
  return {
    issuedAt,
    proof: await hmacSha256Hex(
      input.pairingKey,
      buildMobilePairingProofMessage({
        desktopDeviceId: input.desktopDeviceId,
        mobileDeviceId: input.mobileDeviceId,
        challenge: input.challenge,
        ...(input.mobilePublicKey !== undefined
          ? { mobilePublicKey: input.mobilePublicKey }
          : {}),
        issuedAt,
      }),
    ),
  };
};

/** The headers a signed proof travels in, ready to spread into a fetch init. */
export const mobilePairingProofHeaders = (
  fields: MobilePairingProofFields,
): Record<string, string> => ({
  [MOBILE_PAIRING_HEADERS.mobileDeviceId]: fields.mobileDeviceId,
  [MOBILE_PAIRING_HEADERS.desktopDeviceId]: fields.desktopDeviceId,
  [MOBILE_PAIRING_HEADERS.challenge]: fields.challenge,
  [MOBILE_PAIRING_HEADERS.proof]: fields.proof,
  [MOBILE_PAIRING_HEADERS.issuedAt]: String(fields.issuedAt),
  ...(fields.mobilePublicKey
    ? { [MOBILE_PAIRING_HEADERS.mobilePublicKey]: fields.mobilePublicKey }
    : {}),
});

const bounded = (value: string | null, max: number): string => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : "";
};

/** True when a request even claims to be a mobile submit. */
export const hasMobilePairingProofHeaders = (headers: Headers): boolean =>
  Boolean(
    headers.get(MOBILE_PAIRING_HEADERS.proof)?.trim() ||
      headers.get(MOBILE_PAIRING_HEADERS.mobileDeviceId)?.trim(),
  );

/**
 * Pull the proof out of a request's headers. Returns `null` when a required
 * field is missing or out of bounds — never a partially trusted object.
 */
export const readMobilePairingProofHeaders = (
  headers: Headers,
): MobilePairingProofFields | null => {
  const mobileDeviceId = bounded(
    headers.get(MOBILE_PAIRING_HEADERS.mobileDeviceId),
    MOBILE_PAIRING_LIMITS.deviceId,
  );
  const desktopDeviceId = bounded(
    headers.get(MOBILE_PAIRING_HEADERS.desktopDeviceId),
    MOBILE_PAIRING_LIMITS.deviceId,
  );
  const challenge = bounded(
    headers.get(MOBILE_PAIRING_HEADERS.challenge),
    MOBILE_PAIRING_LIMITS.challenge,
  );
  const proof = bounded(
    headers.get(MOBILE_PAIRING_HEADERS.proof),
    MOBILE_PAIRING_LIMITS.proof,
  );
  const rawIssuedAt = headers.get(MOBILE_PAIRING_HEADERS.issuedAt)?.trim() ?? "";
  const issuedAt = Number(rawIssuedAt);
  if (
    !mobileDeviceId ||
    !desktopDeviceId ||
    !challenge ||
    !proof ||
    !rawIssuedAt ||
    !Number.isFinite(issuedAt)
  ) {
    return null;
  }
  const mobilePublicKeyRaw = bounded(
    headers.get(MOBILE_PAIRING_HEADERS.mobilePublicKey),
    MOBILE_PAIRING_LIMITS.publicKey,
  );
  const mobilePublicKey = /^[A-Za-z0-9_-]+$/.test(mobilePublicKeyRaw)
    ? mobilePublicKeyRaw
    : "";
  return {
    mobileDeviceId,
    desktopDeviceId,
    challenge,
    proof,
    issuedAt,
    ...(mobilePublicKey ? { mobilePublicKey } : {}),
  };
};

export type MobilePairingProofRejection =
  | "missing"
  | "malformed"
  | "expired"
  | "challenge_mismatch"
  | "unpaired"
  | "signature";

export type MobilePairingProofResult =
  | {
      ok: true;
      mobileDeviceId: string;
      desktopDeviceId: string;
      challenge: string;
      issuedAt: number;
    }
  | { ok: false; reason: MobilePairingProofRejection };

/**
 * Verify a phone's proof. `publicKey` is the pairing key the owner snapshot
 * carries for this (mobile, desktop) pair — absent means "not paired", which
 * is refused before any HMAC work so an unpaired phone learns nothing.
 *
 * `expectedChallenge` is the challenge the *server* derived from the request
 * it is about to act on. Passing it is what stops a proof minted for one
 * payload from authorizing another; omitting it verifies only that the phone
 * holds the pairing key.
 */
export const verifyMobilePairingProof = async (input: {
  headers?: Headers;
  fields?: MobilePairingProofFields | null;
  publicKey?: string | null;
  expectedChallenge?: string;
  now?: number;
  maxSkewMs?: number;
}): Promise<MobilePairingProofResult> => {
  const fields =
    input.fields ??
    (input.headers ? readMobilePairingProofHeaders(input.headers) : null);
  if (!fields) {
    return {
      ok: false,
      reason:
        input.headers && hasMobilePairingProofHeaders(input.headers)
          ? "malformed"
          : "missing",
    };
  }
  const pairingKey = input.publicKey?.trim() ?? "";
  if (!pairingKey) return { ok: false, reason: "unpaired" };
  const now = input.now ?? Date.now();
  const skew = input.maxSkewMs ?? MOBILE_PAIRING_PROOF_MAX_SKEW_MS;
  if (!(fields.issuedAt > 0) || Math.abs(now - fields.issuedAt) > skew) {
    return { ok: false, reason: "expired" };
  }
  if (
    input.expectedChallenge !== undefined &&
    input.expectedChallenge !== fields.challenge
  ) {
    return { ok: false, reason: "challenge_mismatch" };
  }
  const expected = await hmacSha256Hex(
    pairingKey,
    buildMobilePairingProofMessage({
      desktopDeviceId: fields.desktopDeviceId,
      mobileDeviceId: fields.mobileDeviceId,
      challenge: fields.challenge,
      ...(fields.mobilePublicKey !== undefined
        ? { mobilePublicKey: fields.mobilePublicKey }
        : {}),
      issuedAt: fields.issuedAt,
    }),
  );
  if (!constantTimeEqualHex(expected, fields.proof.toLowerCase())) {
    return { ok: false, reason: "signature" };
  }
  return {
    ok: true,
    mobileDeviceId: fields.mobileDeviceId,
    desktopDeviceId: fields.desktopDeviceId,
    challenge: fields.challenge,
    issuedAt: fields.issuedAt,
  };
};

// ---------------------------------------------------------------------------
// What the challenge commits to
// ---------------------------------------------------------------------------

/**
 * The exact payload bytes a dispatch carries. The proof signs a hash of this
 * string, and the owner gate stores and hands over these same bytes, so every
 * side has to serialize a payload the same way: declaration order, absent
 * optionals omitted rather than written as `null`.
 */
export const canonicalDispatchPayloadJson = (
  payload: DispatchPayload,
): string =>
  JSON.stringify({
    schemaVersion: 1,
    prompt: payload.prompt,
    conversationId: payload.conversationId,
    clientMsgId: payload.clientMsgId,
    ...(payload.userMessageEventId
      ? { userMessageEventId: payload.userMessageEventId }
      : {}),
    ...(payload.locale ? { locale: payload.locale } : {}),
    ...(payload.attachments && payload.attachments.length > 0
      ? { attachments: payload.attachments }
      : {}),
    ...(payload.execution
      ? {
          execution: {
            engine: payload.execution.engine,
            provider: payload.execution.provider,
            model: payload.execution.model,
            reasoningEffort: payload.execution.reasoningEffort,
          },
        }
      : {}),
    ...(payload.description ? { description: payload.description } : {}),
  });

/** Lowercase hex sha256 of `canonicalDispatchPayloadJson`. */
export const dispatchPayloadHash = (payload: DispatchPayload): Promise<string> =>
  sha256Hex(canonicalDispatchPayloadJson(payload));
