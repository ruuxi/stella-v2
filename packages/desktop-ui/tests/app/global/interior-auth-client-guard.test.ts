// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bridge: vi.fn(),
  createAuthClient: vi.fn(),
  convexPlugin: vi.fn(),
  anonymousPlugin: vi.fn(),
  magicLinkPlugin: vi.fn(),
  oneTimeTokenPlugin: vi.fn(),
  readBrowserToken: vi.fn(),
  clearBrowserToken: vi.fn(),
  captureRotatedToken: vi.fn(),
}));

vi.mock("@/platform/interior/interior-bridge", () => ({
  getStellaInteriorBridge: mocks.bridge,
}));
vi.mock("better-auth/client", () => ({
  createAuthClient: mocks.createAuthClient,
}));
vi.mock("@convex-dev/better-auth/client/plugins", () => ({
  convexClient: mocks.convexPlugin,
}));
vi.mock("better-auth/client/plugins", () => ({
  anonymousClient: mocks.anonymousPlugin,
  magicLinkClient: mocks.magicLinkPlugin,
  oneTimeTokenClient: mocks.oneTimeTokenPlugin,
}));
vi.mock("@/global/auth/services/auth-storage", () => ({
  readBrowserSessionToken: mocks.readBrowserToken,
  clearBrowserSessionToken: mocks.clearBrowserToken,
  captureRotatedSessionToken: mocks.captureRotatedToken,
}));

describe("interior Better Auth guard", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.bridge.mockReturnValue({
      protocol: 1,
      gatewayOrigin: "https://apps-auth.example.test",
    });
  });

  it("rejects account operations before plugins, client, storage, or fetch initialize", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { authClient } = await import("@/global/auth/lib/auth-client");

    expect(() => authClient.getSession).toThrow(
      "Use the trusted Stella shell for account changes.",
    );
    expect(mocks.createAuthClient).not.toHaveBeenCalled();
    expect(mocks.convexPlugin).not.toHaveBeenCalled();
    expect(mocks.anonymousPlugin).not.toHaveBeenCalled();
    expect(mocks.magicLinkPlugin).not.toHaveBeenCalled();
    expect(mocks.oneTimeTokenPlugin).not.toHaveBeenCalled();
    expect(mocks.readBrowserToken).not.toHaveBeenCalled();
    expect(mocks.clearBrowserToken).not.toHaveBeenCalled();
    expect(mocks.captureRotatedToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
