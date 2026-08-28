import { describe, expect, test } from "bun:test";
import { handoffNetworkRequestAllowed } from "../src/handoff-navigation-policy.js";

const expectedOrigin = "https://www.demoblaze.com";

describe("human takeover navigation fence", () => {
  test("keeps every credential-entry document on the exact displayed origin", () => {
    expect(
      handoffNetworkRequestAllowed({
        requestUrl: "https://www.demoblaze.com/login",
        documentNavigation: true,
        expectedOrigin,
      }),
    ).toBe(true);
    for (const requestUrl of [
      "http://www.demoblaze.com/login",
      "https://www.demoblaze.com:444/login",
      "https://api.demoblaze.com/phish",
      "https://evil.example/phish",
    ]) {
      expect(
        handoffNetworkRequestAllowed({
          requestUrl,
          documentNavigation: true,
          expectedOrigin,
        }),
      ).toBe(false);
    }
  });

  test("allows HTTPS same-site API requests but no insecure subresource", () => {
    expect(
      handoffNetworkRequestAllowed({
        requestUrl: "https://api.demoblaze.com/login",
        documentNavigation: false,
        expectedOrigin,
      }),
    ).toBe(true);
    expect(
      handoffNetworkRequestAllowed({
        requestUrl: "http://api.demoblaze.com/login",
        documentNavigation: false,
        expectedOrigin,
      }),
    ).toBe(false);
  });
});
