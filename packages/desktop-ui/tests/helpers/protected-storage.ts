import { setProtectedStorageProviderOverride } from "@stella/runtime/kernel/shared/protected-storage";

const TEST_MASK = 0xa5;
const TEST_PREFIX = "test-safe-storage:";

const transform = (input: Buffer): Buffer =>
  Buffer.from(input.map((value) => value ^ TEST_MASK));

export const installTestSafeStorage = (): void => {
  setProtectedStorageProviderOverride({
    isEncryptionAvailable: () => true,
    encryptString: (plaintext) =>
      transform(Buffer.from(`${TEST_PREFIX}${plaintext}`, "utf8")),
    decryptString: (ciphertext) => {
      const value = transform(ciphertext).toString("utf8");
      if (!value.startsWith(TEST_PREFIX)) {
        throw new Error("Invalid test ciphertext.");
      }
      return value.slice(TEST_PREFIX.length);
    },
  });
};

export const resetTestSafeStorage = (): void => {
  setProtectedStorageProviderOverride(null);
};
