// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  applyBrowserAuthSessionCookie,
  assertBetterAuthSessionCookie,
} from "@/global/auth/services/auth-storage";

describe("browser account session cookie persistence", () => {
  beforeEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    window.localStorage.clear();
  });

  it("accepts and persists a returned Better Auth session token", () => {
    const expires = new Date(Date.now() + 60_000).toUTCString();
    const returned = `better-auth.session_token=account-token; Path=/; Expires=${expires}; HttpOnly`;

    expect(() => assertBetterAuthSessionCookie(returned)).not.toThrow();
    applyBrowserAuthSessionCookie(returned);

    expect(window.localStorage.getItem("better-auth_cookie")).toContain(
      "account-token",
    );
  });

  it("does not let an old anonymous token mask a malformed returned cookie", () => {
    applyBrowserAuthSessionCookie(
      "better-auth.session_token=anonymous-token; Path=/; HttpOnly",
    );

    expect(() =>
      applyBrowserAuthSessionCookie("better-auth.other=value; Path=/"),
    ).toThrow("did not return a session cookie");
    expect(window.localStorage.getItem("better-auth_cookie")).not.toContain(
      "other",
    );
  });

  it("rejects empty session-token values", () => {
    expect(() =>
      assertBetterAuthSessionCookie(
        "better-auth.session_token=; Path=/; HttpOnly",
      ),
    ).toThrow("did not return a session cookie");
  });

  it("does not accept a lookalike cookie name as a Better Auth session", () => {
    expect(() =>
      assertBetterAuthSessionCookie(
        "attacker_session_token=opaque; Path=/; HttpOnly",
      ),
    ).toThrow("did not return a session cookie");
  });
});
