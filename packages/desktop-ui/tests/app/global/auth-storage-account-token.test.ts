// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  BROWSER_SESSION_TOKEN_KEY,
  captureRotatedSessionToken,
  clearBrowserSessionToken,
  readBrowserSessionToken,
  writeBrowserSessionToken,
} from "@/global/auth/services/auth-storage";

const setElectron = (present: boolean) => {
  const target = window as unknown as { electronAPI?: unknown };
  if (present) {
    target.electronAPI = { system: {} };
  } else {
    delete target.electronAPI;
  }
};

const responseWithToken = (token: string | null): Response =>
  new Response(null, {
    headers: token ? { "set-auth-token": token } : {},
  });

describe("browser account session token persistence", () => {
  beforeEach(() => {
    setElectron(false);
    window.localStorage.clear();
  });

  it("persists and reads back a returned bearer token", () => {
    writeBrowserSessionToken("  signed.session.token  ");

    expect(window.localStorage.getItem(BROWSER_SESSION_TOKEN_KEY)).toBe(
      "signed.session.token",
    );
    expect(readBrowserSessionToken()).toBe("signed.session.token");
  });

  it("rejects an empty token instead of storing a blank credential", () => {
    expect(() => writeBrowserSessionToken("   ")).toThrow(
      "did not return a session token",
    );
    expect(window.localStorage.getItem(BROWSER_SESSION_TOKEN_KEY)).toBeNull();
  });

  it("purges the retired cross-domain cookie mirror on any access", () => {
    window.localStorage.setItem("better-auth_cookie", '{"x":{"value":"1"}}');
    window.localStorage.setItem("better-auth_session_data", "{}");

    expect(readBrowserSessionToken()).toBe("");
    expect(window.localStorage.getItem("better-auth_cookie")).toBeNull();
    expect(window.localStorage.getItem("better-auth_session_data")).toBeNull();
  });

  it("clears the stored token on sign-out", () => {
    writeBrowserSessionToken("signed.session.token");
    clearBrowserSessionToken();

    expect(readBrowserSessionToken()).toBe("");
  });

  it("adopts a rotated token from set-auth-token and ignores its absence", () => {
    writeBrowserSessionToken("first.token");

    captureRotatedSessionToken(responseWithToken(null));
    expect(readBrowserSessionToken()).toBe("first.token");

    captureRotatedSessionToken(responseWithToken("second.token"));
    expect(readBrowserSessionToken()).toBe("second.token");
  });

  it("keeps Electron renderers out of the credential store", () => {
    setElectron(true);

    expect(() => writeBrowserSessionToken("renderer.copy")).toThrow(
      "unavailable in Electron",
    );
    captureRotatedSessionToken(responseWithToken("rotated.copy"));

    expect(window.localStorage.getItem(BROWSER_SESSION_TOKEN_KEY)).toBeNull();
    expect(readBrowserSessionToken()).toBe("");
  });
});
