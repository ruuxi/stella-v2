import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp/stella-auth-service-test"),
    isReady: vi.fn(() => false),
    setAsDefaultProtocolClient: vi.fn(),
  },
}));

import { AuthService } from "@stella/desktop/electron/services/auth-service.js";

const createJwt = (expiresAtSeconds: number) =>
  [
    "header",
    Buffer.from(JSON.stringify({ exp: expiresAtSeconds })).toString(
      "base64url",
    ),
    "signature",
  ].join(".");

const createService = () => {
  const runner = {
    setAuthToken: vi.fn(),
    setHasConnectedAccount: vi.fn(),
    setConvexUrl: vi.fn(),
    setConvexSiteUrl: vi.fn(),
  };
  const service = new AuthService({
    authProtocol: "stella",
    isDev: false,
    projectDir: "/tmp/stella-auth-service-test",
    sessionPartition: "persist:stella",
    runnerTarget: { getRunner: () => runner },
    onAuthCallback: vi.fn(),
    onSecondInstanceFocus: vi.fn(),
  });
  return { runner, service };
};

describe("AuthService scheduled-script auth", () => {
  it("returns a token minted by the desktop-owned auth path", async () => {
    const { service } = createService();
    const freshToken = createJwt(Math.floor(Date.now() / 1000) + 30 * 60);
    service.configurePiRuntime({
      convexUrl: "https://example.convex.cloud",
      convexSiteUrl: "https://example.convex.site/",
    });
    vi.spyOn(service, "getAuthToken").mockResolvedValue(freshToken);

    await expect(service.getScheduleScriptAuth()).resolves.toEqual({
      baseUrl: "https://example.convex.site",
      authToken: freshToken,
    });
  });

  it("does not inject a stale fallback token when minting fails", async () => {
    const { service } = createService();
    service.configurePiRuntime({
      convexUrl: "https://example.convex.cloud",
      convexSiteUrl: "https://example.convex.site",
    });
    vi.spyOn(service, "getAuthToken").mockResolvedValue(
      createJwt(Math.floor(Date.now() / 1000) - 60),
    );

    await expect(service.getScheduleScriptAuth()).resolves.toBeNull();
  });
});
