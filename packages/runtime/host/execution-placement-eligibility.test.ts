import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { deviceSignerForIdentity } from "../kernel/home/device";
import { isExecutionPlacementEligible } from "./execution-placement-eligibility";

/**
 * The identity a real host handler returns. Electron's
 * `createHostRunnerHandlers.getDeviceIdentity` and the headless host both
 * strip the private key and expose signing through `signDeviceInput`.
 */
const publicOnlyIdentityWithSigner = () => {
  const pair = generateKeyPairSync("ed25519");
  const identity = {
    deviceId: "desktop-public-only",
    publicKey: pair.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    privateKey: pair.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
  };
  const signer = deviceSignerForIdentity(identity);
  const handlers = {
    getDeviceIdentity: async () => ({
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
    }),
    signDeviceInput: async (input: string) => ({
      alg: signer.alg,
      rawPublicKey: Array.from(signer.rawPublicKey),
      signature: await signer.sign(input),
    }),
  };
  return { handlers };
};

const readyHost = async (handlers: {
  getDeviceIdentity: () => Promise<{ deviceId: string; publicKey: string }>;
  signDeviceInput?: unknown;
}) => ({
  started: true,
  hostReady: true,
  deviceIdentity: await handlers.getDeviceIdentity(),
  hasDatabase: true,
  hasConnectedAccount: true,
  cloudSyncEnabled: true,
  authToken: "jwt-host",
  convexUrl: "https://deployment.convex.cloud",
  canSignDeviceInput: typeof handlers.signDeviceInput === "function",
});

describe("execution placement eligibility", () => {
  test("a public-only device identity with a signing delegate is eligible", async () => {
    const { handlers } = publicOnlyIdentityWithSigner();
    const identity = await handlers.getDeviceIdentity();
    expect("privateKey" in identity).toBe(false);
    expect(isExecutionPlacementEligible(await readyHost(handlers))).toBe(true);
  });

  test("without a signing delegate the bridge cannot prove presence", async () => {
    const { handlers } = publicOnlyIdentityWithSigner();
    expect(
      isExecutionPlacementEligible(
        await readyHost({ getDeviceIdentity: handlers.getDeviceIdentity }),
      ),
    ).toBe(false);
  });

  test("every other gate still applies", async () => {
    const { handlers } = publicOnlyIdentityWithSigner();
    const ready = await readyHost(handlers);
    for (const [key, value] of [
      ["started", false],
      ["hostReady", false],
      ["deviceIdentity", null],
      ["deviceIdentity", { deviceId: "", publicKey: ready.deviceIdentity.publicKey }],
      ["hasDatabase", false],
      ["hasConnectedAccount", false],
      ["hasConnectedAccount", undefined],
      ["cloudSyncEnabled", false],
      ["authToken", null],
      ["convexUrl", null],
    ] as const) {
      expect(
        isExecutionPlacementEligible({ ...ready, [key]: value }),
        `${key}=${JSON.stringify(value)}`,
      ).toBe(false);
    }
  });
});
