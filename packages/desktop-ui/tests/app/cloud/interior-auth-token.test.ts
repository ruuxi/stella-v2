// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bridge: vi.fn(),
  browserToken: vi.fn(),
  configurePiRuntime: vi.fn(),
}));

vi.mock("@/platform/interior/interior-bridge", () => ({
  getStellaInteriorBridge: mocks.bridge,
}));
vi.mock("@/global/auth/lib/auth-client", () => ({
  authClient: { token: mocks.browserToken },
}));
vi.mock("@/platform/electron/device", () => ({
  configurePiRuntime: mocks.configurePiRuntime,
}));

describe("interior scoped auth token", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it("uses only the pre-module bridge and accepts its opaque scoped token", async () => {
    const getToken = vi.fn().mockResolvedValue({
      token: "opaque-interior-scope-token",
      expiresAt: Date.now() + 5 * 60_000,
    });
    mocks.bridge.mockReturnValue({
      protocol: 1,
      gatewayOrigin: "https://apps-auth.example.test",
      getToken,
    });
    const mod = await import("@/global/auth/services/auth-token");

    await expect(mod.getAuthToken({ forceRefresh: true })).resolves.toBe(
      "opaque-interior-scope-token",
    );
    await expect(mod.getAuthTokenForSubject("viewer-1")).resolves.toBe(
      "opaque-interior-scope-token",
    );
    expect(getToken).toHaveBeenCalledWith({ forceRefresh: true });
    expect(mocks.browserToken).not.toHaveBeenCalled();
    expect(mocks.configurePiRuntime).not.toHaveBeenCalled();
  });
});
