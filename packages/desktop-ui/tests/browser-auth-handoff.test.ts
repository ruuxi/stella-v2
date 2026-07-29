import { describe, expect, test } from "bun:test";
import {
  AUTH_HANDOFF_TOKEN_PATTERN,
  consumeBrowserAuthHandoffToken,
  decideAutomaticAnonymousBootstrap,
  type BrowserAuthHandoffResult,
} from "../src/global/auth/browser-auth-handoff";

const makeLocation = (hash: string) => ({
  hash,
  pathname: "/stella/sr_example/",
  search: "?theme=dark",
});

describe("consumeBrowserAuthHandoffToken", () => {
  test("consumes a valid fragment token and erases it first", () => {
    const calls: Array<[unknown, string, string | URL | null | undefined]> = [];
    const history = {
      state: { navigation: 1 },
      replaceState: (
        data: unknown,
        unused: string,
        url?: string | URL | null,
      ) => {
        calls.push([data, unused, url]);
      },
    };

    const token = consumeBrowserAuthHandoffToken(
      makeLocation("#ott=valid_token-123"),
      history,
    );

    expect(token).toBe("valid_token-123");
    expect(calls).toEqual([
      [{ navigation: 1 }, "", "/stella/sr_example/?theme=dark"],
    ]);
  });

  test("erases malformed and duplicate token fragments without consuming them", () => {
    for (const hash of ["#ott=short", "#ott=valid_token-123&ott=another_one"]) {
      let cleanUrl: string | URL | null | undefined;
      const token = consumeBrowserAuthHandoffToken(makeLocation(hash), {
        state: null,
        replaceState: (_data, _unused, url) => {
          cleanUrl = url;
        },
      });

      expect(token).toBeNull();
      expect(cleanUrl).toBe("/stella/sr_example/?theme=dark");
    }
  });

  test("leaves unrelated fragments and query parameters untouched", () => {
    let replaced = false;
    const token = consumeBrowserAuthHandoffToken(
      makeLocation("#section=account"),
      {
        state: null,
        replaceState: () => {
          replaced = true;
        },
      },
    );

    expect(token).toBeNull();
    expect(replaced).toBeFalse();
  });

  test("accepts only the constrained handoff token alphabet and length", () => {
    expect(AUTH_HANDOFF_TOKEN_PATTERN.test("abc_DEF-1~")).toBeTrue();
    expect(AUTH_HANDOFF_TOKEN_PATTERN.test("has/slash")).toBeFalse();
    expect(AUTH_HANDOFF_TOKEN_PATTERN.test("too few")).toBeFalse();
  });
});

describe("decideAutomaticAnonymousBootstrap", () => {
  test("does not decide until the browser handoff has settled", async () => {
    let settle!: (result: BrowserAuthHandoffResult) => void;
    const handoff = new Promise<BrowserAuthHandoffResult>((resolve) => {
      settle = resolve;
    });
    let hasSession = false;
    let decisionSettled = false;
    const decision = decideAutomaticAnonymousBootstrap(
      handoff,
      () => hasSession,
    ).then((result) => {
      decisionSettled = true;
      return result;
    });

    await Promise.resolve();
    expect(decisionSettled).toBeFalse();

    hasSession = true;
    settle("redeemed");
    expect(await decision).toBe("session_exists");
  });

  test("never falls through to anonymous bootstrap after handoff failure", async () => {
    expect(
      await decideAutomaticAnonymousBootstrap(
        Promise.resolve("failed"),
        () => false,
      ),
    ).toBe("handoff_failed");
  });

  test("allows normal anonymous bootstrap when no handoff exists", async () => {
    expect(
      await decideAutomaticAnonymousBootstrap(
        Promise.resolve("none"),
        () => false,
      ),
    ).toBe("create_anonymous");
  });
});
