import { describe, expect, test } from "bun:test";
import { AUTH_CAPTCHA_HEADER } from "@stella/contracts/auth-challenge";
import {
  buildAnonymousSignInOptions,
  buildMagicLinkHeaders,
} from "../auth-captcha-headers";

describe("mobile auth captcha request builders", () => {
  test("attaches the captcha header to anonymous sign-in", () => {
    expect(buildAnonymousSignInOptions(" token-1 ")).toEqual({
      fetchOptions: {
        headers: { [AUTH_CAPTCHA_HEADER]: "token-1" },
      },
    });
  });

  test("attaches the captcha header to magic-link sends", () => {
    expect(buildMagicLinkHeaders("token-2")).toEqual({
      "Content-Type": "application/json",
      [AUTH_CAPTCHA_HEADER]: "token-2",
    });
  });

  test("omits the captcha header when Turnstile is not configured", () => {
    expect(buildAnonymousSignInOptions(undefined)).toEqual({
      fetchOptions: { headers: {} },
    });
    expect(buildMagicLinkHeaders(undefined)).toEqual({
      "Content-Type": "application/json",
    });
  });
});
