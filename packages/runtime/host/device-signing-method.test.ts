import { describe, expect, it } from "bun:test";

import { createRemoteDeviceSigner } from "./device-signing-method.js";

describe("remote device signer", () => {
  it("keeps private-key operations behind the host request boundary", async () => {
    const rawPublicKey = Array.from({ length: 32 }, (_, index) => index);
    const inputs: string[] = [];
    const signer = await createRemoteDeviceSigner(async (input) => {
      inputs.push(input);
      return {
        alg: "ed25519",
        rawPublicKey,
        signature: `signature-${inputs.length}`,
      };
    });

    expect(Array.from(signer.rawPublicKey)).toEqual(rawPublicKey);
    await expect(signer.sign("canonical-request")).resolves.toBe("signature-2");
    expect(inputs).toEqual(["stella-device-key-probe", "canonical-request"]);
  });

  it("rejects a key change after a capability has been bound", async () => {
    let requestCount = 0;
    const signer = await createRemoteDeviceSigner(async () => {
      requestCount += 1;
      return {
        alg: "ed25519",
        rawPublicKey: Array.from(
          { length: 32 },
          (_, index) => index + (requestCount > 1 ? 1 : 0),
        ),
        signature: "signature",
      };
    });

    await expect(signer.sign("canonical-request")).rejects.toThrow(
      "changed unexpectedly",
    );
  });
});
