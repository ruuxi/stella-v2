import { describe, expect, it, vi } from "vitest";
import {
  importDpopPublicKey,
  verifyDpopInput,
} from "@stella/contracts/gateway/dpop";
import {
  createDeviceKeyManager,
  type DeviceKeyStore,
  type StoredDeviceKey,
} from "@/platform/ai/device-key";

describe("browser device key manager", () => {
  it("reuses a non-extractable private CryptoKey from persistent storage", async () => {
    let stored: StoredDeviceKey | undefined;
    const save = vi.fn(async (key: StoredDeviceKey) => {
      stored = key;
    });
    const store: DeviceKeyStore = {
      load: async () => stored,
      save,
    };

    const first = await createDeviceKeyManager(store).getSigner();
    const second = await createDeviceKeyManager(store).getSigner();

    expect(save).toHaveBeenCalledTimes(1);
    expect(stored?.privateKey.extractable).toBe(false);
    expect(second.alg).toBe(first.alg);
    expect(Array.from(second.rawPublicKey)).toEqual(
      Array.from(first.rawPublicKey),
    );

    const input = "stella-device-key-persistence-test";
    const publicKey = await importDpopPublicKey(first.alg, first.rawPublicKey);
    await expect(
      verifyDpopInput(first.alg, publicKey, await second.sign(input), input),
    ).resolves.toBe(true);
  });
});
