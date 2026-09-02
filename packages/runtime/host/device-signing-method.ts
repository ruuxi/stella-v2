import type { DeviceSigner } from "../kernel/home/device.js";

export const HOST_DEVICE_SIGNING_METHOD = "host.auth.signDevice" as const;

export const HOST_DEVICE_SIGNING_PROBE = "stella-device-key-probe";

export const MAX_DEVICE_SIGNING_INPUT_LENGTH = 64 * 1024;

export type HostDeviceSignature = {
  alg: "ed25519";
  rawPublicKey: number[];
  signature: string;
};

const parseHostDeviceSignature = (value: unknown): HostDeviceSignature => {
  if (!value || typeof value !== "object") {
    throw new Error("The Stella host returned an invalid device signature.");
  }
  const result = value as Partial<HostDeviceSignature>;
  if (
    result.alg !== "ed25519" ||
    !Array.isArray(result.rawPublicKey) ||
    result.rawPublicKey.length !== 32 ||
    result.rawPublicKey.some(
      (byte) => !Number.isInteger(byte) || byte < 0 || byte > 255,
    ) ||
    typeof result.signature !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(result.signature)
  ) {
    throw new Error("The Stella host returned an invalid device signature.");
  }
  return {
    alg: result.alg,
    rawPublicKey: result.rawPublicKey,
    signature: result.signature,
  };
};

export const createRemoteDeviceSigner = async (
  requestSignature: (input: string) => Promise<unknown>,
): Promise<DeviceSigner> => {
  const probe = parseHostDeviceSignature(
    await requestSignature(HOST_DEVICE_SIGNING_PROBE),
  );
  const rawPublicKey = new Uint8Array(probe.rawPublicKey);

  return {
    alg: "ed25519",
    rawPublicKey,
    sign: async (input) => {
      if (!input || input.length > MAX_DEVICE_SIGNING_INPUT_LENGTH) {
        throw new Error("Invalid Stella device signing input.");
      }
      const result = parseHostDeviceSignature(await requestSignature(input));
      if (
        result.rawPublicKey.some((byte, index) => byte !== rawPublicKey[index])
      ) {
        throw new Error("The Stella device signing key changed unexpectedly.");
      }
      return result.signature;
    },
  };
};
