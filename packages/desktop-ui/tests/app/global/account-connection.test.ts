// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyBrowserAuthSessionCookie: vi.fn(),
  assertBetterAuthSessionCookie: vi.fn(),
  getConvexToken: vi.fn(),
  getAuthSessionSnapshot: vi.fn(),
  refreshAuthSession: vi.fn(),
  socialSignIn: vi.fn(),
  updateSession: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/global/auth/lib/auth-client", () => ({
  authClient: {
    signIn: { social: mocks.socialSignIn },
    updateSession: mocks.updateSession,
  },
}));

vi.mock("@/global/auth/services/auth-session", () => ({
  getAuthSessionSnapshot: mocks.getAuthSessionSnapshot,
  refreshAuthSession: mocks.refreshAuthSession,
}));

vi.mock("@/global/auth/services/auth-storage", () => ({
  applyBrowserAuthSessionCookie: mocks.applyBrowserAuthSessionCookie,
  assertBetterAuthSessionCookie: mocks.assertBetterAuthSessionCookie,
}));

vi.mock("@/global/auth/services/auth-token", () => ({
  getConvexToken: mocks.getConvexToken,
}));

vi.mock("@/shared/lib/convex-urls", () => ({
  readConfiguredConvexSiteUrl: () => "https://auth.example",
}));

import {
  applyAndVerifyAccountSessionCookie,
  buildMagicLinkSendRequest,
  getBrowserSocialCallbackUrl,
  startBrowserGoogleSignIn,
} from "@/global/auth/services/account-connection";

const setElectronApi = (electronAPI: unknown) => {
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    writable: true,
    value: electronAPI,
  });
};

describe("account connection renderer boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setElectronApi(undefined);
    window.history.replaceState(
      null,
      "",
      "/cloud?access_token=must-not-copy#ott=must-not-copy",
    );
    mocks.socialSignIn.mockResolvedValue({ data: null, error: null });
    mocks.getConvexToken.mockResolvedValue("current-owner.jwt");
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          callbackURL:
            "https://auth.example/api/auth/browser-social/verify?requestId=00000000-0000-4000-8000-000000000000",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.refreshAuthSession.mockResolvedValue(undefined);
    mocks.getAuthSessionSnapshot.mockReturnValue({
      data: { user: { id: "account-owner", isAnonymous: false } },
      isPending: false,
      error: null,
      identityRevision: 2,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setElectronApi(undefined);
  });

  it("starts browser Google auth with a callback stripped of query credentials and fragments", async () => {
    const callbackURL = getBrowserSocialCallbackUrl(window.location);
    expect(callbackURL).toBe(`${window.location.origin}/cloud`);
    expect(callbackURL).not.toContain("access_token");
    expect(callbackURL).not.toContain("ott");

    await startBrowserGoogleSignIn();

    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://auth.example/api/auth/browser-social/start",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer current-owner.jwt",
        },
        body: JSON.stringify({ returnTo: `${window.location.origin}/cloud` }),
      },
    );
    expect(mocks.socialSignIn).toHaveBeenCalledWith({
      provider: "google",
      callbackURL:
        "https://auth.example/api/auth/browser-social/verify?requestId=00000000-0000-4000-8000-000000000000",
    });
  });

  it("fails closed when the server returns a contaminated or untrusted callback shape", async () => {
    for (const callbackURL of [
      "https://attacker.example/callback?requestId=00000000-0000-4000-8000-000000000000",
      "https://attacker.example/api/auth/browser-social/verify?requestId=00000000-0000-4000-8000-000000000000",
      "https://auth.example/api/auth/browser-social/verify?requestId=00000000-0000-4000-8000-000000000000&ott=leaked-token",
    ]) {
      mocks.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ callbackURL }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await expect(startBrowserGoogleSignIn()).rejects.toThrow(
        "callback could not be registered",
      );
    }
    expect(mocks.socialSignIn).not.toHaveBeenCalled();
  });

  it("binds browser magic-link sends to a freshly minted anonymous-owner JWT", async () => {
    mocks.getConvexToken.mockResolvedValue("current-owner.jwt");

    await expect(
      buildMagicLinkSendRequest("owner@example.com"),
    ).resolves.toEqual({
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer current-owner.jwt",
      },
      body: {
        email: "owner@example.com",
        requireAnonymousOwner: true,
      },
    });
    expect(mocks.getConvexToken).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it("fails closed before a browser magic-link send when owner proof is unavailable", async () => {
    mocks.getConvexToken.mockResolvedValue(null);

    await expect(
      buildMagicLinkSendRequest("owner@example.com"),
    ).resolves.toBeNull();
  });

  it("preserves the Electron magic-link request contract", async () => {
    setElectronApi({ system: {} });

    await expect(
      buildMagicLinkSendRequest("owner@example.com"),
    ).resolves.toEqual({
      headers: { "Content-Type": "application/json" },
      body: { email: "owner@example.com" },
    });
    expect(mocks.getConvexToken).not.toHaveBeenCalled();
  });

  it("mirrors a browser cookie and accepts it only after a connected owner revalidates", async () => {
    await applyAndVerifyAccountSessionCookie("session_token=account-cookie");

    expect(mocks.applyBrowserAuthSessionCookie).toHaveBeenCalledWith(
      "session_token=account-cookie",
    );
    expect(mocks.assertBetterAuthSessionCookie).toHaveBeenCalledWith(
      "session_token=account-cookie",
    );
    expect(mocks.updateSession).toHaveBeenCalledTimes(1);
    expect(mocks.refreshAuthSession).toHaveBeenCalledTimes(1);
  });

  it("rejects an applied cookie when revalidation still resolves to an anonymous owner", async () => {
    mocks.getAuthSessionSnapshot.mockReturnValue({
      data: { user: { id: "anonymous-owner", isAnonymous: true } },
      isPending: false,
      error: null,
      identityRevision: 1,
    });

    await expect(
      applyAndVerifyAccountSessionCookie("session_token=ambiguous-cookie"),
    ).rejects.toThrow("could not be verified");
  });

  it("keeps cookie persistence host-owned in Electron and checks the host result", async () => {
    const applyAuthSessionCookie = vi.fn().mockResolvedValue({ ok: true });
    setElectronApi({ system: { applyAuthSessionCookie } });

    await applyAndVerifyAccountSessionCookie("session_token=desktop-cookie");

    expect(applyAuthSessionCookie).toHaveBeenCalledWith(
      "session_token=desktop-cookie",
    );
    expect(mocks.applyBrowserAuthSessionCookie).not.toHaveBeenCalled();
    expect(mocks.updateSession).not.toHaveBeenCalled();

    applyAuthSessionCookie.mockResolvedValueOnce({ ok: false });
    await expect(
      applyAndVerifyAccountSessionCookie("session_token=rejected-cookie"),
    ).rejects.toThrow("rejected the cookie");
  });
});
