// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bridge: vi.fn(),
  getSession: vi.fn(),
  browserSession: vi.fn(),
  browserAnonymous: vi.fn(),
  readBrowserToken: vi.fn(),
  readCachedSession: vi.fn(),
  readIdentityIntent: vi.fn(),
  writeCachedSession: vi.fn(),
  writeIdentityIntent: vi.fn(),
  clearBrowserToken: vi.fn(),
}));

vi.mock("@/platform/interior/interior-bridge", () => ({
  getStellaInteriorBridge: mocks.bridge,
}));
vi.mock("@/platform/electron/device", () => ({
  configurePiRuntime: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/global/auth/lib/auth-client", () => ({
  authClient: {
    getSession: mocks.browserSession,
    signIn: { anonymous: mocks.browserAnonymous },
    oneTimeToken: { verify: vi.fn() },
    updateSession: vi.fn(),
    signOut: vi.fn(),
    deleteUser: vi.fn(),
  },
}));
vi.mock("@/global/auth/services/auth-storage", () => ({
  readBrowserSessionToken: mocks.readBrowserToken,
  readBrowserCachedSession: mocks.readCachedSession,
  readBrowserIdentityIntent: mocks.readIdentityIntent,
  writeBrowserCachedSession: mocks.writeCachedSession,
  writeBrowserIdentityIntent: mocks.writeIdentityIntent,
  clearBrowserSessionToken: mocks.clearBrowserToken,
}));

describe("interior auth session", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    window.history.replaceState(null, "", "/stella/sr_example/");
    mocks.bridge.mockReturnValue({
      protocol: 1,
      gatewayOrigin: "https://apps-auth.example.test",
      getSession: mocks.getSession,
      getToken: vi.fn().mockResolvedValue({
        token: "opaque-interior-scope-token",
        expiresAt: Date.now() + 5 * 60_000,
      }),
    });
  });

  it("hydrates display identity only from the bridge without Better Auth or storage", async () => {
    mocks.getSession.mockResolvedValue({
      user: {
        id: "viewer-1",
        email: "viewer@example.test",
        name: "Viewer",
        image: null,
        isAnonymous: false,
      },
      expiresAt: Date.now() + 5 * 60_000,
    });
    const mod = await import("@/global/auth/services/auth-session");
    await mod.refreshAuthSession();

    expect(mod.getAuthSessionSnapshot()).toMatchObject({
      status: "authenticated",
      isPending: false,
      data: { user: { id: "viewer-1", isAnonymous: false } },
    });
    expect(mocks.browserSession).not.toHaveBeenCalled();
    expect(mocks.browserAnonymous).not.toHaveBeenCalled();
    expect(mocks.readBrowserToken).not.toHaveBeenCalled();
    expect(mocks.readCachedSession).not.toHaveBeenCalled();
    expect(mocks.readIdentityIntent).not.toHaveBeenCalled();
    expect(mocks.writeCachedSession).not.toHaveBeenCalled();
    expect(mocks.writeIdentityIntent).not.toHaveBeenCalled();
    expect(mocks.clearBrowserToken).not.toHaveBeenCalled();
  });
});
