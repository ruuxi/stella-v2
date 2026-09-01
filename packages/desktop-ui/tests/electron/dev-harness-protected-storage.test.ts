import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  configureDevHarnessProtectedStorage,
  createDevHarnessSafeStorage,
} from "@stella/desktop/electron/bootstrap/dev-harness-protected-storage.js";
import {
  protectValue,
  setProtectedStorageProviderOverride,
  unprotectValue,
} from "@stella/runtime/kernel/shared/protected-storage";

const encodedKey = () => randomBytes(32).toString("base64url");

describe("development harness protected storage", () => {
  it("encrypts authenticated ciphertext with a per-run key", () => {
    const storage = createDevHarnessSafeStorage(encodedKey());
    const ciphertext = storage.encryptString("secret value");

    expect(ciphertext.toString("utf8")).not.toContain("secret value");
    expect(storage.decryptString(ciphertext)).toBe("secret value");

    const tampered = Buffer.from(ciphertext);
    tampered[tampered.length - 1] ^= 1;
    expect(() => storage.decryptString(tampered)).toThrow();
  });

  it("installs only for an unpackaged, explicit harness and consumes the key", () => {
    const env = {
      STELLA_DEV_HARNESS: "1",
      STELLA_DEV_HARNESS_STORAGE_KEY: encodedKey(),
    };

    try {
      expect(
        configureDevHarnessProtectedStorage({ env, isPackaged: false }),
      ).toBe(true);
      expect(env.STELLA_DEV_HARNESS_STORAGE_KEY).toBeUndefined();

      const protectedValue = protectValue("harness-test", "round trip");
      expect(protectedValue).not.toContain("round trip");
      expect(unprotectValue("harness-test", protectedValue)).toBe("round trip");
    } finally {
      setProtectedStorageProviderOverride(null);
    }
  });

  it("does not install for packaged or ordinary development runs", () => {
    expect(
      configureDevHarnessProtectedStorage({
        env: {
          STELLA_DEV_HARNESS: "1",
          STELLA_DEV_HARNESS_STORAGE_KEY: encodedKey(),
        },
        isPackaged: true,
      }),
    ).toBe(false);
    expect(
      configureDevHarnessProtectedStorage({
        env: { STELLA_DEV_HARNESS_STORAGE_KEY: encodedKey() },
        isPackaged: false,
      }),
    ).toBe(false);
  });
});
