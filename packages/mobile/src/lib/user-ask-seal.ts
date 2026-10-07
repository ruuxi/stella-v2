import { gcm } from "@noble/ciphers/aes.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { getRandomBytes } from "expo-crypto";
import {
  USER_ASK_SEAL_ALGORITHM,
  USER_ASK_SEAL_IV_BYTES,
  USER_ASK_SEAL_MAX_PLAINTEXT_BYTES,
  USER_ASK_SEAL_PUBLIC_KEY_BYTES,
  userAskSealKdfInputs,
  type UserAskRecipientKey,
  type UserAskSealedValue,
} from "@stella/contracts/user-ask";
import { base64UrlToBytes, bytesToBase64Url } from "./base64url";

const sha256Hex = (bytes: Uint8Array): string => bytesToHex(sha256(bytes));

export const canSealUserAskValue = (
  recipientKey: UserAskRecipientKey | undefined,
): recipientKey is UserAskRecipientKey => {
  if (!recipientKey) return false;
  if (recipientKey.algorithm !== USER_ASK_SEAL_ALGORITHM) return false;
  if (!recipientKey.keyId || !recipientKey.publicKey) return false;
  try {
    return (
      base64UrlToBytes(recipientKey.publicKey).byteLength ===
      USER_ASK_SEAL_PUBLIC_KEY_BYTES
    );
  } catch {
    return false;
  }
};

export class UserAskSealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserAskSealError";
  }
}

export const sealUserAskValue = (args: {
  askId: string;
  fieldId: string;
  value: string;
  recipientKey: UserAskRecipientKey;
}): UserAskSealedValue => {
  if (!canSealUserAskValue(args.recipientKey)) {
    throw new UserAskSealError("No usable recipient key for this ask.");
  }
  const plaintext = utf8ToBytes(args.value);
  if (plaintext.byteLength > USER_ASK_SEAL_MAX_PLAINTEXT_BYTES) {
    throw new UserAskSealError("That value is too large to send.");
  }
  const secretKey = getRandomBytes(USER_ASK_SEAL_PUBLIC_KEY_BYTES);
  const clientPublicKey = x25519.getPublicKey(secretKey);
  const sharedSecret = x25519.getSharedSecret(
    secretKey,
    base64UrlToBytes(args.recipientKey.publicKey),
  );
  const { aad, salt, info, keyLengthBytes } = userAskSealKdfInputs({
    binding: {
      askId: args.askId,
      keyId: args.recipientKey.keyId,
      fieldId: args.fieldId,
    },
    sha256Hex,
  });
  const key = hkdf(sha256, sharedSecret, salt, info, keyLengthBytes);
  const iv = getRandomBytes(USER_ASK_SEAL_IV_BYTES);
  return {
    algorithm: USER_ASK_SEAL_ALGORITHM,
    keyId: args.recipientKey.keyId,
    clientPublicKey: bytesToBase64Url(clientPublicKey),
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(gcm(key, iv, aad).encrypt(plaintext)),
  };
};
