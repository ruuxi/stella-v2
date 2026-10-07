// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeBrowserSessionToken: vi.fn(),
  readBrowserSessionToken: vi.fn(),
  hasBrowserLegacyAnonymousSession: vi.fn(),
  token: vi.fn(),
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
    token: mocks.token,
  },
}));

vi.mock("@/global/auth/services/auth-session", () => ({
  getAuthSessionSnapshot: mocks.getAuthSessionSnapshot,
  hasBrowserLegacyAnonymousSession: mocks.hasBrowserLegacyAnonymousSession,
  refreshAuthSession: mocks.refreshAuthSession,
}));

vi.mock("@/global/auth/services/auth-storage", () => ({
  readBrowserSessionToken: mocks.readBrowserSessionToken,
  writeBrowserSessionToken: mocks.writeBrowserSessionToken,
}));

vi.mock("@/platform/backend/backend-url", () => ({
  backendUrl: "https://auth.example",
  requireBackendUrl: () => "https://auth.example",
}));

import {
  applyAndVerifyAccountSessionToken,
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
    mocks.hasBrowserLegacyAnonymousSession.mockReturnValue(false);
    mocks.readBrowserSessionToken.mockReturnValue("");
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
      data: { user: { id: "account-owner" } },
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

  it("returns website OAuth handoffs through the public chat route", () => {
    expect(getBrowserSocialCallbackUrl(window.location, true)).toBe(
      `${window.location.origin}/chat`,
    );
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

  it("sends a plain browser magic link when no legacy anonymous session exists", () => {
    expect(
      buildMagicLinkSendRequest("owner@example.com", "turnstile-token"),
    ).toEqual({
      headers: {
        "Content-Type": "application/json",
        "x-captcha-response": "turnstile-token",
      },
      body: { email: "owner@example.com" },
    });
  });

  it("binds a browser magic link to a legacy anonymous bearer so it upgrades in place", () => {
    mocks.hasBrowserLegacyAnonymousSession.mockReturnValue(true);
    mocks.readBrowserSessionToken.mockReturnValue("legacy.bearer");

    expect(buildMagicLinkSendRequest("owner@example.com")).toEqual({
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer legacy.bearer",
      },
      body: {
        email: "owner@example.com",
        requireAnonymousOwner: true,
      },
    });
  });

  it("never attaches a renderer bearer to an Electron magic link", () => {
    setElectronApi({ system: {} });
    mocks.hasBrowserLegacyAnonymousSession.mockReturnValue(true);
    mocks.readBrowserSessionToken.mockReturnValue("legacy.bearer");

    expect(buildMagicLinkSendRequest("owner@example.com")).toEqual({
      headers: { "Content-Type": "application/json" },
      body: { email: "owner@example.com" },
    });
  });

  it("stores a browser bearer and accepts it only after a connected owner revalidates", async () => {
    await applyAndVerifyAccountSessionToken("account.bearer.token");

    expect(mocks.writeBrowserSessionToken).toHaveBeenCalledWith(
      "account.bearer.token",
    );
    expect(mocks.updateSession).toHaveBeenCalledTimes(1);
    expect(mocks.refreshAuthSession).toHaveBeenCalledTimes(1);
  });

  it("rejects an applied bearer when revalidation still resolves to no account", async () => {
    mocks.getAuthSessionSnapshot.mockReturnValue({
      data: null,
      isPending: false,
      error: null,
      identityRevision: 1,
    });

    await expect(
      applyAndVerifyAccountSessionToken("ambiguous.bearer.token"),
    ).rejects.toThrow("could not be verified");
  });

  it("keeps bearer persistence host-owned in Electron and checks the host result", async () => {
    const applyAuthSessionToken = vi.fn().mockResolvedValue({ ok: true });
    setElectronApi({ system: { applyAuthSessionToken } });

    await applyAndVerifyAccountSessionToken("desktop.bearer.token");

    expect(applyAuthSessionToken).toHaveBeenCalledWith("desktop.bearer.token");
    expect(mocks.writeBrowserSessionToken).not.toHaveBeenCalled();
    expect(mocks.updateSession).not.toHaveBeenCalled();

    applyAuthSessionToken.mockResolvedValueOnce({ ok: false });
    await expect(
      applyAndVerifyAccountSessionToken("rejected.bearer.token"),
    ).rejects.toThrow("rejected the token");
  });
});
