import { describe, expect, test } from "bun:test";
import type { TrustedVerification } from "../src/browser-provider.js";
import {
  trustedVerifyPageResult,
  type TrustedVerificationPage,
} from "../src/trusted-verification.js";

const VERIFICATION: TrustedVerification = {
  expectedOrigin: "https://www.demoblaze.com",
  authenticatedSelector: "#nameofuser",
  loggedOutSelector: "#login2",
  resumeUrl: "https://www.demoblaze.com/index.html",
};

type PageState = Readonly<{
  url: string;
  authenticatedVisible: boolean;
  loggedOutVisible: boolean;
}>;

class DeterministicVerificationPage implements TrustedVerificationPage {
  private index = 0;
  readonly sleeps: number[] = [];

  constructor(private readonly states: readonly [PageState, ...PageState[]]) {}

  url(): string {
    return this.current().url;
  }

  locator(selector: string) {
    const visible = () => {
      const state = this.current();
      if (selector === VERIFICATION.authenticatedSelector) {
        return state.authenticatedVisible;
      }
      if (selector === VERIFICATION.loggedOutSelector) {
        return state.loggedOutVisible;
      }
      return false;
    };
    return {
      count: async () => 1,
      nth: (_index: number) => ({ isVisible: async () => visible() }),
    };
  }

  async waitForTimeout(timeoutMs: number): Promise<void> {
    this.advance(timeoutMs);
  }

  advance(timeoutMs: number): void {
    this.sleeps.push(timeoutMs);
    this.index = Math.min(this.index + 1, this.states.length - 1);
  }

  private current(): PageState {
    return this.states[this.index];
  }
}

const polling = (page: DeterministicVerificationPage, timeoutMs = 1_000) => {
  let now = 10_000;
  return {
    now: () => now,
    timeoutMs,
    intervalMs: 100,
    sleep: async (durationMs: number) => {
      now += durationMs;
      page.advance(durationMs);
    },
  };
};

describe("trusted browser authentication verification", () => {
  test("waits for authenticated UI to appear and logged-out UI to disappear", async () => {
    const page = new DeterministicVerificationPage([
      {
        url: VERIFICATION.resumeUrl,
        authenticatedVisible: false,
        loggedOutVisible: true,
      },
      {
        url: VERIFICATION.resumeUrl,
        authenticatedVisible: true,
        loggedOutVisible: true,
      },
      {
        url: VERIFICATION.resumeUrl,
        authenticatedVisible: true,
        loggedOutVisible: false,
      },
    ]);

    await expect(
      trustedVerifyPageResult(
        page,
        VERIFICATION,
        "authenticated",
        polling(page),
      ),
    ).resolves.toEqual({
      verified: true,
      originMatches: true,
      authenticatedVisible: true,
      loggedOutVisible: false,
    });
    expect(page.sleeps).toEqual([100, 100]);
  });

  test("fails closed when the page changes origin during polling", async () => {
    const page = new DeterministicVerificationPage([
      {
        url: VERIFICATION.resumeUrl,
        authenticatedVisible: false,
        loggedOutVisible: true,
      },
      {
        url: "https://api.demoblaze.com/lookalike",
        authenticatedVisible: true,
        loggedOutVisible: false,
      },
    ]);

    await expect(
      trustedVerifyPageResult(
        page,
        VERIFICATION,
        "authenticated",
        polling(page),
      ),
    ).resolves.toEqual({
      verified: false,
      originMatches: false,
      authenticatedVisible: false,
      loggedOutVisible: true,
    });
    expect(page.sleeps).toEqual([100]);
  });

  test("returns the final unverified state at the bounded deadline", async () => {
    const page = new DeterministicVerificationPage([
      {
        url: VERIFICATION.resumeUrl,
        authenticatedVisible: false,
        loggedOutVisible: true,
      },
    ]);

    await expect(
      trustedVerifyPageResult(
        page,
        VERIFICATION,
        "authenticated",
        polling(page, 200),
      ),
    ).resolves.toEqual({
      verified: false,
      originMatches: true,
      authenticatedVisible: false,
      loggedOutVisible: true,
    });
    expect(page.sleeps).toEqual([100, 100]);
  });
});
