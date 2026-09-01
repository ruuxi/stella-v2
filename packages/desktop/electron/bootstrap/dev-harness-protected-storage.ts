import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { setProtectedStorageProviderOverride } from "@stella/runtime/kernel/shared/protected-storage";

const HARNESS_STORAGE_KEY_ENV = "STELLA_DEV_HARNESS_STORAGE_KEY";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT_VERSION = 1;

type SafeStorageLike = {
  isEncryptionAvailable: () => boolean;
  encryptString: (plaintext: string) => Buffer;
  decryptString: (ciphertext: Buffer) => string;
};

const decodeKey = (encoded: string): Buffer => {
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${HARNESS_STORAGE_KEY_ENV} must contain exactly ${KEY_BYTES} bytes.`,
    );
  }
  return key;
};

export const createDevHarnessSafeStorage = (
  encodedKey: string,
): SafeStorageLike => {
  const key = decodeKey(encodedKey);
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext) => {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([
        Buffer.from([FORMAT_VERSION]),
        iv,
        cipher.getAuthTag(),
        encrypted,
      ]);
    },
    decryptString: (ciphertext) => {
      if (
        ciphertext.length < 1 + IV_BYTES + TAG_BYTES ||
        ciphertext[0] !== FORMAT_VERSION
      ) {
        throw new Error("Invalid development harness ciphertext.");
      }
      const ivStart = 1;
      const tagStart = ivStart + IV_BYTES;
      const encryptedStart = tagStart + TAG_BYTES;
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        ciphertext.subarray(ivStart, tagStart),
      );
      decipher.setAuthTag(ciphertext.subarray(tagStart, encryptedStart));
      return Buffer.concat([
        decipher.update(ciphertext.subarray(encryptedStart)),
        decipher.final(),
      ]).toString("utf8");
    },
  };
};

export const configureDevHarnessProtectedStorage = ({
  env = process.env,
  isPackaged,
}: {
  env?: NodeJS.ProcessEnv;
  isPackaged: boolean;
}): boolean => {
  if (isPackaged || env.STELLA_DEV_HARNESS !== "1") return false;

  const encodedKey = env[HARNESS_STORAGE_KEY_ENV]?.trim();
  if (!encodedKey) {
    throw new Error(
      `${HARNESS_STORAGE_KEY_ENV} is required when STELLA_DEV_HARNESS=1.`,
    );
  }

  setProtectedStorageProviderOverride(createDevHarnessSafeStorage(encodedKey));
  delete env[HARNESS_STORAGE_KEY_ENV];
  return true;
};
