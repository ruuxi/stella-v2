import type {
  TrustedVerification,
  TrustedVerificationState,
} from "./browser-provider.js";

type VisibilityLocator = Readonly<{
  count(): Promise<number>;
  nth(index: number): Readonly<{
    isVisible(): Promise<boolean>;
  }>;
}>;

export type TrustedVerificationPage = Readonly<{
  locator(selector: string): VisibilityLocator;
  url(): string;
  waitForTimeout(timeoutMs: number): Promise<void>;
}>;

export type TrustedVerificationResult = Readonly<{
  verified: boolean;
  originMatches: boolean;
  authenticatedVisible: boolean;
  loggedOutVisible: boolean;
}>;

type TrustedVerificationPolling = Readonly<{
  now?: () => number;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (timeoutMs: number) => Promise<void>;
}>;

export const trustedVerifyPageResult = async (
  page: TrustedVerificationPage,
  verification: TrustedVerification,
  expectedState: TrustedVerificationState,
  polling: TrustedVerificationPolling = {},
): Promise<TrustedVerificationResult> => {
  const now = polling.now ?? Date.now;
  const sleep =
    polling.sleep ??
    (async (timeoutMs: number) => await page.waitForTimeout(timeoutMs));
  const timeoutMs = polling.timeoutMs ?? 7_000;
  const intervalMs = polling.intervalMs ?? 100;
  try {
    const anyVisible = async (selector: string) => {
      const locator = page.locator(selector);
      const count = Math.min(await locator.count(), 32);
      for (let index = 0; index < count; index += 1) {
        if (await locator.nth(index).isVisible().catch(() => false)) {
          return true;
        }
      }
      return false;
    };
    // Locator.isVisible() is an immediate snapshot; its timeout option is
    // explicitly ignored by Playwright. Authentication UIs commonly update
    // after DOMContentLoaded, so poll the compound trusted state instead of
    // accepting or rejecting the first transient frame.
    const deadline = now() + timeoutMs;
    let authenticatedVisible = false;
    let loggedOutVisible = false;
    while (true) {
      const originMatches =
        new URL(page.url()).origin === verification.expectedOrigin;
      if (!originMatches) {
        return {
          verified: false,
          originMatches,
          authenticatedVisible,
          loggedOutVisible,
        };
      }
      [authenticatedVisible, loggedOutVisible] = await Promise.all([
        anyVisible(verification.authenticatedSelector),
        anyVisible(verification.loggedOutSelector),
      ]);
      const verified =
        expectedState === "authenticated"
          ? authenticatedVisible && !loggedOutVisible
          : !authenticatedVisible && loggedOutVisible;
      if (verified || now() >= deadline) {
        return {
          verified,
          originMatches,
          authenticatedVisible,
          loggedOutVisible,
        };
      }
      await sleep(intervalMs);
    }
  } catch {
    return {
      verified: false,
      originMatches: false,
      authenticatedVisible: false,
      loggedOutVisible: false,
    };
  }
};
