import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  buildMobilePairingProofMessage,
  mobilePairingProofHeaders,
} from "@stella/contracts/turn-plane/pairing-proof";
import type { StoredPhoneAccess } from "./phone-access";

/** Lowercase hex SHA-256 of a UTF-8 string. */
export const sha256HexUtf8 = (value: string): string =>
  bytesToHex(sha256(utf8ToBytes(value)));

/**
 * The pairing proof in the contract's exact scheme: HMAC-SHA256 keyed by the
 * lowercase-hex sha256 of the pairing secret over the contract's message. The
 * digest is @noble rather than the contract's own WebCrypto signer because
 * React Native has no `crypto.subtle`.
 */
export const signPhonePairingProof = (
  access: StoredPhoneAccess,
  challenge: string,
): { issuedAt: number; proof: string } => {
  const issuedAt = Date.now();
  const pairingKey = sha256HexUtf8(access.pairSecret);
  return {
    issuedAt,
    proof: bytesToHex(
      hmac(
        sha256,
        utf8ToBytes(pairingKey),
        utf8ToBytes(
          buildMobilePairingProofMessage({
            desktopDeviceId: access.desktopDeviceId,
            mobileDeviceId: access.mobileDeviceId,
            challenge,
            issuedAt,
          }),
        ),
      ),
    ),
  };
};

/** The proof's headers, ready to spread into a request. */
export const phonePairingProofHeaders = (
  access: StoredPhoneAccess,
  challenge: string,
): Record<string, string> =>
  mobilePairingProofHeaders({
    mobileDeviceId: access.mobileDeviceId,
    desktopDeviceId: access.desktopDeviceId,
    challenge,
    ...signPhonePairingProof(access, challenge),
  });
