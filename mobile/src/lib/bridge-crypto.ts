import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { getRandomBytes } from "expo-crypto";
import {
  BRIDGE_CRYPTO_PROTOCOL,
  base64UrlToBytes,
  bytesToBase64Url,
  decryptBridgeBytesCore,
  decryptBridgePayloadCore,
  encryptBridgeBytesCore,
  encryptBridgePayloadCore,
  getSessionReplayGuard,
  isBridgeEncryptedEnvelope,
  type BridgeBinaryFrame,
  type BridgeCryptoDirection,
  type BridgeCryptoSession,
  type BridgeEncryptedEnvelope,
} from "./bridge-envelope";

// The protocol/envelope core lives in `bridge-envelope.ts` (pure, testable —
// no Expo imports); this module binds Expo randomness onto it and owns the
// x25519 key exchange + pairing proofs.
export {
  BRIDGE_CRYPTO_PROTOCOL,
  base64UrlToBytes,
  bytesToBase64Url,
  isBridgeEncryptedEnvelope,
};
export type {
  BridgeBinaryFrame,
  BridgeCryptoDirection,
  BridgeCryptoSession,
  BridgeEncryptedEnvelope,
};

export const MOBILE_BRIDGE_PAIR_PROOF_VERSION =
  "stella-mobile-bridge-pair-proof-v1";

export type BridgeKeyPair = {
  secretKey: Uint8Array;
  publicKey: string;
};

export const createBridgeKeyPair = (): BridgeKeyPair => {
  const secretKey = getRandomBytes(32);
  return {
    secretKey,
    publicKey: bytesToBase64Url(x25519.getPublicKey(secretKey)),
  };
};

export const createBridgeProofChallenge = () =>
  bytesToBase64Url(getRandomBytes(24));

export const buildMobileBridgePairProofMessage = (args: {
  desktopDeviceId: string;
  mobileDeviceId: string;
  challenge: string;
  mobilePublicKey?: string;
  issuedAt: number;
}) =>
  [
    MOBILE_BRIDGE_PAIR_PROOF_VERSION,
    args.desktopDeviceId,
    args.mobileDeviceId,
    args.challenge,
    args.mobilePublicKey ?? "",
    String(args.issuedAt),
  ].join("\n");

export const createMobileBridgePairProof = (args: {
  pairSecret: string;
  desktopDeviceId: string;
  mobileDeviceId: string;
  challenge: string;
  mobilePublicKey?: string;
}) => {
  const issuedAt = Date.now();
  const pairSecretHash = bytesToHex(sha256(utf8ToBytes(args.pairSecret)));
  const message = buildMobileBridgePairProofMessage({
    desktopDeviceId: args.desktopDeviceId,
    mobileDeviceId: args.mobileDeviceId,
    challenge: args.challenge,
    mobilePublicKey: args.mobilePublicKey,
    issuedAt,
  });
  return {
    issuedAt,
    proof: bytesToHex(
      hmac(sha256, utf8ToBytes(pairSecretHash), utf8ToBytes(message)),
    ),
  };
};

export const deriveBridgeCryptoSession = (args: {
  sessionId: string;
  secretKey: Uint8Array;
  peerPublicKey: string;
  mobilePublicKey: string;
  desktopPublicKey: string;
}): BridgeCryptoSession => {
  const sharedSecret = x25519.getSharedSecret(
    args.secretKey,
    base64UrlToBytes(args.peerPublicKey),
  );
  const salt = sha256(
    utf8ToBytes(`stella-mobile-bridge-session-v1:${args.sessionId}`),
  );
  const info = utf8ToBytes(
    [
      "stella-mobile-bridge-session-key-v1",
      args.sessionId,
      args.mobilePublicKey,
      args.desktopPublicKey,
    ].join("\n"),
  );
  return {
    sessionId: args.sessionId,
    key: hkdf(sha256, sharedSecret, salt, info, 32),
    txSeq: 0,
  };
};

export const encryptBridgePayload = (
  session: BridgeCryptoSession,
  direction: BridgeCryptoDirection,
  payload: unknown,
  options?: { compress?: boolean },
): BridgeEncryptedEnvelope =>
  encryptBridgePayloadCore(session, direction, payload, getRandomBytes, options);

export const decryptBridgePayload = (
  session: BridgeCryptoSession,
  direction: BridgeCryptoDirection,
  envelope: BridgeEncryptedEnvelope,
): unknown =>
  decryptBridgePayloadCore(
    session,
    direction,
    envelope,
    getSessionReplayGuard(session),
  );

export const encryptBridgeBytes = (
  session: BridgeCryptoSession,
  direction: BridgeCryptoDirection,
  bytes: Uint8Array,
): BridgeBinaryFrame =>
  encryptBridgeBytesCore(session, direction, bytes, getRandomBytes);

export const decryptBridgeBytes = (
  session: BridgeCryptoSession,
  direction: BridgeCryptoDirection,
  frame: BridgeBinaryFrame,
): Uint8Array =>
  decryptBridgeBytesCore(
    session,
    direction,
    frame,
    getSessionReplayGuard(session),
  );
