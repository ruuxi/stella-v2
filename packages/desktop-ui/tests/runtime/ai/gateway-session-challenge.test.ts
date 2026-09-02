import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportRawPublicKey,
  generateDpopKeyPair,
  signDpopInput,
  verifyDeviceKeyProof,
} from "@stella/contracts/gateway/dpop";

const mocks = vi.hoisted(() => ({
  getConvexToken: vi.fn(),
  getChallengeToken: vi.fn(),
}));

vi.mock("@/global/auth/services/auth-token", () => ({
  getConvexToken: mocks.getConvexToken,
}));

vi.mock("@/platform/auth/challenge-token", () => ({
  getPlatformChallengeToken: mocks.getChallengeToken,
}));

const ISSUER = "https://issuer.example.test";
const OWNER_ID = `${ISSUER}|user-1`;
const AUTH_JWT = `header.${Buffer.from(
  JSON.stringify({ iss: ISSUER, sub: "user-1" }),
).toString("base64url")}.signature`;

describe("renderer gateway session challenge", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.getConvexToken.mockResolvedValue(AUTH_JWT);
    mocks.getChallengeToken.mockResolvedValue("turnstile-token");
    const generated = await generateDpopKeyPair();
    if (generated.alg !== "ed25519") {
      throw new Error("The Electron signer test requires Ed25519 WebCrypto.");
    }
    const rawPublicKey = await exportRawPublicKey(generated.keyPair.publicKey);
    const signDevice = vi.fn(async (input: string) => ({
      alg: generated.alg,
      rawPublicKey: Array.from(rawPublicKey),
      signature: await signDpopInput(
        generated.alg,
        generated.keyPair.privateKey,
        input,
      ),
    }));
    vi.stubGlobal("window", { electronAPI: { system: { signDevice } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gets a token through the platform bridge and re-exchanges once", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : null;
        bodies.push(body);
        if (bodies.length === 1) {
          return new Response(
            JSON.stringify({
              error: { code: "challenge_required", message: "verify" },
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            capability: "capability-token",
            expiresAt: Date.now() + 3_600_000,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const gateway = await import("@/platform/ai/gateway-session");

    await expect(
      gateway.getGatewaySessionCapability("https://gateway.example.test"),
    ).resolves.toBe("capability-token");
    expect(mocks.getChallengeToken).toHaveBeenCalledTimes(1);
    expect(bodies[0]).toMatchObject({ deviceKey: expect.any(Object) });
    expect(bodies[1]).toMatchObject({
      deviceKey: expect.any(Object),
      turnstileToken: "turnstile-token",
    });
    const firstBody = bodies[0] as {
      deviceKey: Parameters<typeof verifyDeviceKeyProof>[0]["proof"];
    };
    await expect(
      verifyDeviceKeyProof({
        proof: firstBody.deviceKey,
        ownerId: OWNER_ID,
        gatewayOrigin: "https://gateway.example.test",
        now: firstBody.deviceKey.timestamp,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("uses the required copy when the platform cannot get a token", async () => {
    mocks.getChallengeToken.mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "challenge_required", message: "verify" },
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const gateway = await import("@/platform/ai/gateway-session");

    await expect(
      gateway.getGatewaySessionCapability("https://gateway.example.test"),
    ).rejects.toThrow("Stella needs to verify you're human before continuing.");
  });

  it("surfaces a failed device proof without retrying", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "dpop_invalid", message: "bad device proof" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const gateway = await import("@/platform/ai/gateway-session");

    await expect(
      gateway.getGatewaySessionCapability("https://gateway.example.test"),
    ).rejects.toThrow(
      "This device could not be verified. Restart Stella and try again.",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
