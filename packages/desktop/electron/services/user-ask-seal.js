import {
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomUUID,
} from "node:crypto";
import {
  USER_ASK_SEAL_ALGORITHM,
  USER_ASK_SEAL_IV_BYTES,
  USER_ASK_SEAL_MAX_PLAINTEXT_BYTES,
  USER_ASK_SEAL_PUBLIC_KEY_BYTES,
  USER_ASK_SEAL_TAG_BYTES,
  userAskSealKdfInputs,
} from "@stella/contracts/user-ask";
const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const sha256Hex = (bytes) =>
    createHash("sha256").update(Buffer.from(bytes)).digest("hex");
const toBase64Url = (bytes) => Buffer.from(bytes).toString("base64url");
const fromBase64Url = (value, maximumBytes) => {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error("Sealed answer is malformed.");
    }
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length === 0 || bytes.length > maximumBytes) {
        throw new Error("Sealed answer is malformed.");
    }
    return bytes;
};
export const createUserAskRecipientKey = () => {
    const { publicKey, privateKey } = generateKeyPairSync("x25519");
    const rawPublicKey = publicKey
        .export({ type: "spki", format: "der" })
        .subarray(-USER_ASK_SEAL_PUBLIC_KEY_BYTES);
    return {
        privateKey,
        recipientKey: {
            algorithm: USER_ASK_SEAL_ALGORITHM,
            keyId: randomUUID(),
            publicKey: toBase64Url(rawPublicKey),
        },
    };
};
export const openUserAskSealedValue = ({ sealed, privateKey, recipientKey, askId, fieldId, }) => {
    if (!privateKey || !recipientKey) {
        throw new Error("This ask cannot accept a sealed answer.");
    }
    if (!sealed ||
        sealed.algorithm !== USER_ASK_SEAL_ALGORITHM ||
        sealed.keyId !== recipientKey.keyId) {
        throw new Error("Sealed answer does not match this ask.");
    }
    const clientPublicKey = fromBase64Url(sealed.clientPublicKey, USER_ASK_SEAL_PUBLIC_KEY_BYTES);
    const iv = fromBase64Url(sealed.iv, USER_ASK_SEAL_IV_BYTES);
    const payload = fromBase64Url(sealed.ciphertext, USER_ASK_SEAL_MAX_PLAINTEXT_BYTES + USER_ASK_SEAL_TAG_BYTES);
    if (clientPublicKey.length !== USER_ASK_SEAL_PUBLIC_KEY_BYTES ||
        iv.length !== USER_ASK_SEAL_IV_BYTES ||
        payload.length <= USER_ASK_SEAL_TAG_BYTES) {
        throw new Error("Sealed answer is malformed.");
    }
    const sharedSecret = diffieHellman({
        privateKey,
        publicKey: createPublicKey({
            key: Buffer.concat([SPKI_X25519_PREFIX, clientPublicKey]),
            format: "der",
            type: "spki",
        }),
    });
    const { aad, salt, info, keyLengthBytes } = userAskSealKdfInputs({
        binding: { askId, keyId: recipientKey.keyId, fieldId },
        sha256Hex,
    });
    const key = Buffer.from(hkdfSync("sha256", sharedSecret, salt, info, keyLengthBytes));
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(payload.subarray(payload.length - USER_ASK_SEAL_TAG_BYTES));
    const plaintext = Buffer.concat([
        decipher.update(payload.subarray(0, payload.length - USER_ASK_SEAL_TAG_BYTES)),
        decipher.final(),
    ]);
    if (plaintext.length === 0 ||
        plaintext.length > USER_ASK_SEAL_MAX_PLAINTEXT_BYTES) {
        throw new Error("Sealed answer is malformed.");
    }
    return plaintext.toString("utf8");
};
