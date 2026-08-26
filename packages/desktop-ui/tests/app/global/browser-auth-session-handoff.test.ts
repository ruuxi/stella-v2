// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  verifyOneTimeToken: vi.fn(),
  getCookie: vi.fn(),
  updateSession: vi.fn(),
  getSession: vi.fn(),
  signInAnonymous: vi.fn(),
  signOut: vi.fn(),
  deleteUser: vi.fn(),
}));

vi.mock("@/platform/electron/device", () => ({
  configurePiRuntime: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/global/auth/lib/auth-client", () => ({
  authClient: {
    crossDomain: {
      oneTimeToken: {
        verify: authMocks.verifyOneTimeToken,
      },
    },
    getCookie: authMocks.getCookie,
    updateSession: authMocks.updateSession,
    getSession: authMocks.getSession,
    signIn: { anonymous: authMocks.signInAnonymous },
    signOut: authMocks.signOut,
    deleteUser: authMocks.deleteUser,
  },
}));

describe("browser auth session handoff", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    window.localStorage.clear();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    window.history.replaceState(null, "", "/cloud?theme=dark");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("erases and redeems a fragment OTT before exposing its owner", async () => {
    window.history.replaceState(
      { navigation: 1 },
      "",
      "/cloud?theme=dark#ott=valid_token-123",
    );
    authMocks.verifyOneTimeToken.mockResolvedValue({ error: null });
    authMocks.getCookie.mockReturnValue("session_token=mirrored");
    authMocks.getSession.mockResolvedValue({
      data: {
        user: { id: "owner-1", isAnonymous: false },
        session: { id: "session-1" },
      },
      error: null,
    });

    const mod = await import("@/global/auth/services/auth-session");

    expect(await mod.waitForBrowserAuthHandoff()).toBe("redeemed");
    expect(authMocks.verifyOneTimeToken).toHaveBeenCalledWith({
      token: "valid_token-123",
    });
    expect(window.location.hash).toBe("");
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      "/cloud?theme=dark",
    );
    expect(mod.getAuthSessionSnapshot()).toMatchObject({
      data: { user: { id: "owner-1" } },
      isPending: false,
      identityRevision: 1,
    });
  });

  it("fails closed on a malformed fragment without attempting redemption", async () => {
    window.history.replaceState(null, "", "/cloud#ott=short");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const mod = await import("@/global/auth/services/auth-session");

    expect(await mod.waitForBrowserAuthHandoff()).toBe("failed");
    expect(authMocks.verifyOneTimeToken).not.toHaveBeenCalled();
    expect(authMocks.getSession).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
    expect(mod.getAuthSessionSnapshot()).toMatchObject({
      data: null,
      isPending: true,
      identityRevision: 0,
    });
  });

  it("does not accept an OTT from the query string", async () => {
    window.history.replaceState(
      null,
      "",
      "/cloud?ott=valid_token-123#section=account",
    );

    const mod = await import("@/global/auth/services/auth-session");

    expect(await mod.waitForBrowserAuthHandoff()).toBe("none");
    expect(authMocks.verifyOneTimeToken).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#section=account");
  });
});
