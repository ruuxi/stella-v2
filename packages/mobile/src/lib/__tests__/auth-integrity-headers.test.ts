import { describe, expect, test } from "bun:test";
import { APP_INTEGRITY_HEADER } from "@stella/contracts/app-integrity";
import {
  buildAnonymousSignInOptions,
  buildMagicLinkHeaders,
} from "../auth-integrity-headers";

describe("mobile auth integrity request builders", () => {
  test("attaches the integrity proof header to anonymous sign-in", () => {
    expect(buildAnonymousSignInOptions(" proof-1 ")).toEqual({
      fetchOptions: {
        headers: { [APP_INTEGRITY_HEADER]: "proof-1" },
      },
    });
  });

  test("attaches the integrity proof header to magic-link sends", () => {
    expect(buildMagicLinkHeaders("proof-2")).toEqual({
      "Content-Type": "application/json",
      [APP_INTEGRITY_HEADER]: "proof-2",
    });
  });

  test("omits the integrity header when this platform cannot make a proof", () => {
    expect(buildAnonymousSignInOptions(undefined)).toEqual({
      fetchOptions: { headers: {} },
    });
    expect(buildMagicLinkHeaders(undefined)).toEqual({
      "Content-Type": "application/json",
    });
  });
});
