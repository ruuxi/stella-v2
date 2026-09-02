import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("renderer gateway session challenge", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.getConvexToken.mockResolvedValue("auth-jwt");
    mocks.getChallengeToken.mockResolvedValue("turnstile-token");
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
    expect(bodies).toEqual([{}, { turnstileToken: "turnstile-token" }]);
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
});
