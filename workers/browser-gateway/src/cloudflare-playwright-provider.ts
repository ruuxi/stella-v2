import {
  acquire,
  connect,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Locator,
  type Page,
} from "@cloudflare/playwright";
import { GatewayError } from "./errors.js";
import { handoffNetworkRequestAllowed } from "./handoff-navigation-policy.js";
import { browserGuardrailDomains } from "./network-policy.js";
import { sha256Hex, stableJson } from "./protocol.js";
import {
  SENSITIVE_OBSERVATION_SELECTOR,
  redactVisibleText,
  sanitizePageUrl,
} from "./safe-observation.js";
import { trustedVerifyPageResult } from "./trusted-verification.js";
import type {
  BrowserBackend,
  BrowserHandoff,
  HandoffState,
  SafeObservation,
  SafeTab,
  TrustedVerification,
  TrustedVerificationState,
} from "./browser-provider.js";

type BrowserWorker = { fetch: typeof fetch };

const boundedString = (value: unknown, maximum: number): string => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new GatewayError("bad_request", 400);
  }
  return value;
};

const safeTitle = (value: string): string =>
  redactVisibleText(value).slice(0, 512);

const trustedVerifyPage = async (
  page: Page,
  verification: TrustedVerification,
  expectedState: TrustedVerificationState,
): Promise<boolean> =>
  (await trustedVerifyPageResult(page, verification, expectedState)).verified;

export class CloudflarePlaywrightProvider implements BrowserBackend {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private cdp: CDPSession | undefined;
  private currentSessionId: string | undefined;
  private currentPolicyDigest: string | undefined;
  // Stella owns the human handoff end to end. Cloudflare's structured
  // `Cloudflare.handoff` command is deliberately not used: its Live View
  // renders a hardcoded "Human Intervention Required" panel with its own
  // Done/Failed buttons on top of the page, duplicating Stella's controls.
  // The navigation fence, verification, expiry, and Done/Cancel decisions all
  // live in the gateway, so the remote browser only needs an interactive
  // Live View of the fenced page.
  private activeHandoffId: string | undefined;
  private handoffOriginViolation = false;
  private handoffRouteHandler:
    Parameters<BrowserContext["route"]>[1] | undefined;

  constructor(
    private readonly endpoint: BrowserWorker,
    private readonly keepAliveMs: number,
  ) {}

  sessionId(): string | undefined {
    return this.currentSessionId;
  }

  policyDigest(): string | undefined {
    return this.currentPolicyDigest;
  }

  async ensure(args: {
    sessionId?: string;
    storageState?: unknown;
    allowedOrigins: readonly string[];
    onSessionAcquired: (sessionId: string, policyDigest: string) => void;
  }): Promise<void> {
    const allowedDomains = [...browserGuardrailDomains(args.allowedOrigins)];
    const policyDigest = await sha256Hex(stableJson(allowedDomains));
    if (
      this.browser &&
      this.context &&
      this.page &&
      this.currentPolicyDigest === policyDigest
    ) {
      return;
    }
    await this.closeContext();
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = undefined;
    }

    let browser: Browser | undefined;
    if (args.sessionId) {
      try {
        browser = await connect(this.endpoint, args.sessionId);
        this.currentSessionId = args.sessionId;
      } catch {
        browser = undefined;
      }
    }
    if (!browser) {
      let acquired: { sessionId: string };
      try {
        acquired = await acquire(this.endpoint, {
          keep_alive: this.keepAliveMs,
          recording: false,
          guardrails: { allowedDomains },
        });
      } catch {
        throw new GatewayError("browser_unavailable", 503);
      }
      this.currentSessionId = acquired.sessionId;
      this.currentPolicyDigest = policyDigest;
      args.onSessionAcquired(acquired.sessionId, policyDigest);
      try {
        browser = await connect(this.endpoint, acquired.sessionId);
      } catch {
        throw new GatewayError("browser_unavailable", 503);
      }
    }
    this.browser = browser;
    this.currentPolicyDigest = policyDigest;
    try {
      this.context = await browser.newContext(
        args.storageState
          ? ({ storageState: args.storageState } as unknown as Parameters<
              Browser["newContext"]
            >[0])
          : undefined,
      );
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
    } catch {
      await this.closeRemote();
      throw new GatewayError("browser_unavailable", 503);
    }
  }

  private requiredPage(): Page {
    if (!this.page) throw new GatewayError("browser_unavailable", 503);
    return this.page;
  }

  private async observation(
    page = this.requiredPage(),
  ): Promise<SafeObservation> {
    try {
      const [title, text] = await Promise.all([
        page.title(),
        page
          .locator("body")
          .evaluate((element, selector) => {
            const clone = element.cloneNode(true) as unknown as {
              querySelectorAll(selector: string): Iterable<{ remove(): void }>;
              innerText?: string;
              textContent?: string | null;
            };
            for (const sensitive of clone.querySelectorAll(selector)) {
              sensitive.remove();
            }
            return clone.innerText || clone.textContent || "";
          }, SENSITIVE_OBSERVATION_SELECTOR)
          .catch(() => ""),
      ]);
      return {
        url: sanitizePageUrl(page.url()),
        title: safeTitle(title),
        // innerText deliberately excludes form control values.
        text: redactVisibleText(text),
      };
    } catch {
      throw new GatewayError("browser_unavailable", 503);
    }
  }

  async navigate(url: string): Promise<SafeObservation> {
    try {
      await this.requiredPage().goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      return await this.observation();
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError("browser_unavailable", 503);
    }
  }

  observe(): Promise<SafeObservation> {
    return this.observation();
  }

  private async safeAgentLocator(selector: string): Promise<Locator> {
    const locator = this.requiredPage().locator(boundedString(selector, 128));
    try {
      if ((await locator.count()) !== 1) {
        throw new GatewayError("navigation_denied", 403);
      }
      const [type, autocomplete, name, id, placeholder, ariaLabel] =
        await Promise.all([
          locator.getAttribute("type"),
          locator.getAttribute("autocomplete"),
          locator.getAttribute("name"),
          locator.getAttribute("id"),
          locator.getAttribute("placeholder"),
          locator.getAttribute("aria-label"),
        ]);
      const descriptor = [type, autocomplete, name, id, placeholder, ariaLabel]
        .map((item) => item ?? "")
        .join(" ")
        .toLowerCase();
      if (
        /(?:password|email|tel|username|one-time-code|otp|token|secret|passkey)/u.test(
          descriptor,
        )
      ) {
        throw new GatewayError("navigation_denied", 403);
      }
      return locator;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError("navigation_denied", 403);
    }
  }

  async click(selector: string): Promise<void> {
    try {
      await (
        await this.safeAgentLocator(selector)
      ).click({
        timeout: 15_000,
      });
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError("browser_unavailable", 503);
    }
  }

  async fillNonSecret(selector: string, value: string): Promise<void> {
    try {
      const locator = await this.safeAgentLocator(selector);
      await locator.fill(boundedString(value, 4_096), { timeout: 15_000 });
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError("browser_unavailable", 503);
    }
  }

  async press(selector: string, key: string): Promise<void> {
    try {
      await (
        await this.safeAgentLocator(selector)
      ).press(boundedString(key, 64), { timeout: 15_000 });
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError("browser_unavailable", 503);
    }
  }

  async select(selector: string, value: string): Promise<void> {
    try {
      await (
        await this.safeAgentLocator(selector)
      ).selectOption(boundedString(value, 1_024), { timeout: 15_000 });
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError("browser_unavailable", 503);
    }
  }

  async wait(selector: string, timeoutMs: number): Promise<void> {
    try {
      await (
        await this.safeAgentLocator(selector)
      ).waitFor({
        state: "visible",
        timeout: timeoutMs,
      });
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError("browser_unavailable", 503);
    }
  }

  async tabs(): Promise<readonly SafeTab[]> {
    if (!this.context) throw new GatewayError("browser_unavailable", 503);
    const pages = this.context.pages().slice(0, 16);
    return Promise.all(
      pages.map(async (page, index) => ({
        tabId: String(index),
        url: sanitizePageUrl(page.url()),
        title: safeTitle(await page.title().catch(() => "")),
        active: page === this.page,
      })),
    );
  }

  async focusTab(tabId: string): Promise<void> {
    if (!this.context || !/^\d{1,2}$/u.test(tabId)) {
      throw new GatewayError("bad_request", 400);
    }
    const page = this.context.pages()[Number(tabId)];
    if (!page) throw new GatewayError("not_found", 404);
    this.page = page;
    await page.bringToFront();
  }

  async storageState(): Promise<unknown> {
    if (!this.context) throw new GatewayError("browser_unavailable", 503);
    try {
      // @cloudflare/playwright 1.3.6 restores IndexedDB at runtime even though
      // its published return type omits that field.
      return (await this.context.storageState({ indexedDB: true })) as unknown;
    } catch {
      throw new GatewayError("browser_unavailable", 503);
    }
  }

  async verifyImportedStorageState(args: {
    storageState: unknown;
    allowedOrigins: readonly string[];
    verification: TrustedVerification;
  }): Promise<void> {
    let temporaryBrowser: Browser | undefined;
    let temporaryContext: BrowserContext | undefined;
    try {
      const acquired = await acquire(this.endpoint, {
        keep_alive: this.keepAliveMs,
        recording: false,
        guardrails: {
          allowedDomains: [...browserGuardrailDomains(args.allowedOrigins)],
        },
      });
      temporaryBrowser = await connect(this.endpoint, acquired.sessionId);
      temporaryContext = await temporaryBrowser.newContext({
        storageState: args.storageState,
      } as unknown as Parameters<Browser["newContext"]>[0]);
      const page =
        temporaryContext.pages()[0] ?? (await temporaryContext.newPage());
      await page.goto(args.verification.resumeUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      const result = await trustedVerifyPageResult(
        page,
        args.verification,
        "authenticated",
      );
      if (!result.verified) {
        console.error(
          JSON.stringify({
            service: "cloudflare-playwright-provider",
            event: "imported_session_verification_failed",
            originMatches: result.originMatches,
            authenticatedVisible: result.authenticatedVisible,
            loggedOutVisible: result.loggedOutVisible,
          }),
        );
        throw new GatewayError("verification_failed", 409);
      }
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError("browser_unavailable", 503);
    } finally {
      await temporaryContext?.close().catch(() => undefined);
      if (temporaryBrowser) {
        try {
          const cdp = await temporaryBrowser.newBrowserCDPSession();
          await cdp.send("Browser.close");
        } catch {
          // Browser.close normally races the temporary connection shutdown.
        }
        await temporaryBrowser.close().catch(() => undefined);
      }
    }
  }

  private async handoffCdp(): Promise<CDPSession> {
    if (this.cdp) return this.cdp;
    if (!this.context) throw new GatewayError("browser_unavailable", 503);
    try {
      this.cdp = await this.context.newCDPSession(this.requiredPage());
      return this.cdp;
    } catch {
      throw new GatewayError("browser_unavailable", 503);
    }
  }

  async startHandoff(args: {
    handoffTimeoutMs: number;
    expectedOrigin: string;
  }): Promise<BrowserHandoff> {
    try {
      const cdp = await this.handoffCdp();
      this.activeHandoffId = undefined;
      this.handoffOriginViolation = false;
      await this.installHandoffNavigationFence(args.expectedOrigin);
      const { targetInfo } = await cdp.send("Target.getTargetInfo");
      // The gateway's own interaction expiry (bounded by args.handoffTimeoutMs
      // upstream) and suspension alarm end the handoff; no remote timer exists.
      const handoffId = crypto.randomUUID();
      this.activeHandoffId = handoffId;
      return { handoffId, targetId: targetInfo.targetId };
    } catch {
      await this.removeHandoffNavigationFence();
      throw new GatewayError("browser_unavailable", 503);
    }
  }

  private async installHandoffNavigationFence(
    expectedOrigin: string,
  ): Promise<void> {
    if (!this.context) throw new GatewayError("browser_unavailable", 503);
    await this.removeHandoffNavigationFence();
    const handler: Parameters<BrowserContext["route"]>[1] = async (route) => {
      const request = route.request();
      if (
        handoffNetworkRequestAllowed({
          requestUrl: request.url(),
          documentNavigation:
            request.isNavigationRequest() &&
            request.resourceType() === "document",
          expectedOrigin,
        })
      ) {
        await route.continue();
        return;
      }
      // The durable violation flag makes Done and verification fail.
      this.handoffOriginViolation = true;
      await route.abort("blockedbyclient").catch(() => undefined);
    };
    this.handoffRouteHandler = handler;
    await this.context.route("**/*", handler);
  }

  private async removeHandoffNavigationFence(): Promise<void> {
    const handler = this.handoffRouteHandler;
    this.handoffRouteHandler = undefined;
    if (handler && this.context) {
      await this.context.unroute("**/*", handler).catch(() => undefined);
    }
  }

  async renewLiveView(
    liveViewTtlMs: number,
    targetId?: string,
  ): Promise<string> {
    try {
      if (this.handoffOriginViolation) {
        throw new GatewayError("verification_failed", 409);
      }
      const liveView = await (
        await this.handoffCdp()
      ).send("Cloudflare.getLiveView", {
        ...(targetId ? { targetId } : {}),
        mode: "tab",
        expiresInMs: liveViewTtlMs,
      });
      return liveView.devtoolsFrontendUrl;
    } catch {
      throw new GatewayError("browser_unavailable", 503);
    }
  }

  async handoffState(): Promise<HandoffState> {
    // A handoff is active only while this provider still holds the fenced
    // context it was started on. A recreated browser never inherits one.
    if (
      this.activeHandoffId &&
      this.context &&
      this.handoffRouteHandler
    ) {
      return { active: true, handoffId: this.activeHandoffId };
    }
    return { active: false };
  }

  async completeHandoff(success: boolean): Promise<void> {
    if (success && this.handoffOriginViolation) {
      await this.removeHandoffNavigationFence();
      return;
    }
    this.activeHandoffId = undefined;
    await this.removeHandoffNavigationFence();
  }

  async trustedVerify(
    verification: TrustedVerification,
    expectedState: TrustedVerificationState,
  ): Promise<boolean> {
    if (this.handoffOriginViolation) return false;
    return await trustedVerifyPage(
      this.requiredPage(),
      verification,
      expectedState,
    );
  }

  async closeContext(): Promise<void> {
    await this.removeHandoffNavigationFence();
    this.cdp = undefined;
    this.activeHandoffId = undefined;
    this.handoffOriginViolation = false;
    this.page = undefined;
    if (this.context) {
      await this.context.close().catch(() => undefined);
      this.context = undefined;
    }
  }

  async closeRemote(sessionId?: string): Promise<void> {
    await this.closeContext();
    if (!this.browser && sessionId) {
      try {
        this.browser = await connect(this.endpoint, sessionId);
        this.currentSessionId = sessionId;
      } catch {
        // The remote session may already be closed or owned by a live request.
      }
    }
    if (this.browser) {
      try {
        const cdp = await this.browser.newBrowserCDPSession();
        await cdp.send("Browser.close");
      } catch {
        // Browser.close normally races the connection shutdown.
      }
      await this.browser.close().catch(() => undefined);
      this.browser = undefined;
    }
    this.currentSessionId = undefined;
    this.currentPolicyDigest = undefined;
  }
}
