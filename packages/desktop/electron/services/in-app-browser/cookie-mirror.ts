import type { Cookie, Session, WebContents } from "electron";
import { readBrowserHistoryUrls } from "../in-app-browser-profile.js";
import {
  isTrustCriticalCookieName,
  shouldPreserveExistingCookie,
} from "../in-app-browser-auth-policy.js";
import {
  cookieIdentityKey,
  googleCookieFamilyKey,
  isGoogleAuthNavigation,
} from "../in-app-browser-cookie-family.js";
import type {
  StellaBrowserBridgeEvent,
  StellaBrowserCookieChange,
  StellaBrowserExportedCookie,
} from "../in-app-browser-service.js";

type CookieMirrorOptions = {
  profilePath: string;
  getExtensionStatus: () => Promise<boolean>;
  exportAllCookies: () => Promise<StellaBrowserExportedCookie[]>;
  exportCookiesForUrls?: (
    urls: string[],
  ) => Promise<StellaBrowserExportedCookie[]>;
  subscribeCookieEvents?: (
    onEvent: (event: StellaBrowserBridgeEvent) => void,
  ) => () => void;
  /**
   * Waits out any in-flight connection and, when no seed has completed yet,
   * drives one, so a Google sign-in navigation never runs on unseeded cookies.
   */
  awaitConnection: () => Promise<void>;
  /** The tab partitioned cookies are restored through after a seed. */
  getSeedTabContents: () => WebContents | undefined;
  cookieMirrorIntervalMs?: number;
  navigationReseedThrottleMs?: number;
};

// Continuous cookie mirror: how often, once the initial seed has completed, the
// in-app cookie store is refreshed from the real browser so it never goes
// stale. Background, unref'd, single-flight.
const DEFAULT_COOKIE_MIRROR_INTERVAL_MS = 60_000;
const MIN_COOKIE_MIRROR_INTERVAL_MS = 5_000;
// Reconcile-on-navigation coalescing: skip a navigation-triggered refresh if a
// reseed already ran within this window, so rapid navigations don't each pull a
// full cookie export.
const DEFAULT_NAVIGATION_RESEED_THROTTLE_MS = 5_000;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const cookieUrl = (cookie: {
  domain?: string;
  path?: string;
  secure?: boolean;
}) => {
  const host = String(cookie.domain || "")
    .trim()
    .replace(/^\./, "");
  if (!host || host.includes("/") || host.includes("\0")) return null;
  return `${cookie.secure ? "https" : "http"}://${host}${
    cookie.path?.startsWith("/") ? cookie.path : "/"
  }`;
};

/**
 * Mirrors the user's real-browser cookies (exported by the Stella extension)
 * into the in-app browser session: the initial seed, real-time cookie events,
 * a periodic backstop reconcile, reseeds around navigations, and partitioned
 * cookies restored per tab over CDP. Writes only to the in-app session.
 */
export class CookieMirror {
  private readonly options: CookieMirrorOptions;
  private browserSession: Session | null = null;
  private disposed = false;
  /**
   * True once at least one successful cookie seed has completed. Unlike the
   * old one-shot `seeded` latch, this does NOT block reseeding: freshness is
   * owned by the continuous cookie mirror (`startCookieMirror`), which keeps
   * running after the initial seed. This flag only gates the connection-state
   * fast paths and marks that the mirror may start.
   */
  private seededOnce = false;
  /** Single-flight guard so overlapping reseeds never interleave cookie writes. */
  private reseedInFlight: Promise<void> | null = null;
  /** Background, unref'd timer that drives the continuous cookie mirror. */
  private cookieMirrorTimer: ReturnType<typeof setTimeout> | null = null;
  /** Timestamp (ms) of the last completed reseed, for navigation throttling. */
  private lastReseedAt = 0;
  /** Disposer for the real-time cookie-event subscription (primary path). */
  private cookieEventUnsubscribe: (() => void) | null = null;
  private readonly knownMirroredCookieFamilies = new Set<string>();
  private readonly knownMirroredPartitionedCookieFamilies = new Set<string>();
  private readonly googleNavigationReadyContents = new Set<number>();
  private reseedRequested = false;
  private pendingPartitionedCookies: StellaBrowserExportedCookie[] = [];

  constructor(options: CookieMirrorOptions) {
    this.options = options;
  }

  get hasSeededOnce() {
    return this.seededOnce;
  }

  /**
   * Binds the in-app session and gates Google sign-in navigations on a fresh
   * reconcile, so a rotated Google session never loads half-mirrored.
   */
  attachSession(browserSession: Session) {
    this.browserSession = browserSession;
    browserSession.webRequest?.onBeforeRequest?.(
      { urls: ["<all_urls>"], types: ["mainFrame"] },
      (details, callback) => {
        const webContentsId = details.webContentsId;
        if (
          !isGoogleAuthNavigation(details.url) ||
          (webContentsId !== undefined &&
            this.googleNavigationReadyContents.has(webContentsId))
        ) {
          callback({});
          return;
        }
        void this.reconcileBeforeGoogleNavigation(details.url).finally(() => {
          if (webContentsId !== undefined) {
            this.googleNavigationReadyContents.add(webContentsId);
          }
          callback({});
        });
      },
    );
  }

  /** First seed, or a refresh of stale cookies once a seed has completed. */
  async seedOrRefresh() {
    if (this.seededOnce) {
      // Already seeded once: the profile has cookies, they are just stale
      // after the transport went away. Refresh instead of reseeding.
      await this.reseedFromExtension();
    } else {
      await this.seedCookies(await this.exportCookies());
      this.seededOnce = true;
      this.lastReseedAt = Date.now();
    }
  }

  /**
   * Freshness from here on is real-time: the extension pushes every cookie
   * change and we apply it immediately. The periodic mirror is only a
   * lightweight backstop for changes missed while the extension's service
   * worker slept or the subscription reconnected.
   */
  start() {
    this.startCookieEventSubscription();
    this.startCookieMirror();
  }

  dispose() {
    this.disposed = true;
    this.stopCookieMirror();
    this.stopCookieEventSubscription();
    this.browserSession?.webRequest?.onBeforeRequest?.(null);
    this.googleNavigationReadyContents.clear();
  }

  forgetContents(webContentsId: number) {
    this.googleNavigationReadyContents.delete(webContentsId);
  }

  /** Full cookie export, falling back to per-URL export on older daemons. */
  private async exportCookies(): Promise<StellaBrowserExportedCookie[]> {
    try {
      return await this.options.exportAllCookies();
    } catch (error) {
      const message = errorMessage(error);
      if (
        !/unknown (?:command|action): cookies_export_all/i.test(message) ||
        !this.options.exportCookiesForUrls
      ) {
        throw error;
      }
      return await this.options.exportCookiesForUrls(
        readBrowserHistoryUrls(this.options.profilePath),
      );
    }
  }

  private async seedCookies(cookies: StellaBrowserExportedCookie[]) {
    const browserSession = this.browserSession;
    if (!browserSession) throw new Error("Browser session is unavailable.");
    let failed = 0;
    let partitioned = 0;
    let preserved = 0;
    const googleFamilies = new Map<string, StellaBrowserExportedCookie[]>();
    this.pendingPartitionedCookies = [];

    for (const cookie of cookies) {
      const url = cookieUrl(cookie);
      if (!url || !cookie.name) {
        failed += 1;
        continue;
      }
      const familyKey = googleCookieFamilyKey(cookie);
      if (cookie.partitionKey?.topLevelSite) {
        partitioned += 1;
        this.pendingPartitionedCookies.push(cookie);
        if (familyKey) {
          this.knownMirroredPartitionedCookieFamilies.add(familyKey);
        }
        continue;
      }
      if (familyKey) {
        this.knownMirroredCookieFamilies.add(familyKey);
        const family = googleFamilies.get(familyKey) ?? [];
        family.push(cookie);
        googleFamilies.set(familyKey, family);
        continue;
      }

      // Non-Google trust state remains conservative and independent. Google
      // rotating families are reconciled below as complete source snapshots so
      // their 1P/3P and secure/host variants can never be mixed across epochs.
      if (isTrustCriticalCookieName(cookie.name)) {
        try {
          const existingForName = await browserSession.cookies.get({
            url,
            name: cookie.name,
          });
          const existing = existingForName.find(
            (candidate) => candidate.name === cookie.name,
          );
          if (shouldPreserveExistingCookie(existing, cookie)) {
            preserved += 1;
            continue;
          }
        } catch {
          // If we can't read the existing cookie, fall through and (re)seed it.
        }
      }
      try {
        await this.setSessionCookie(cookie);
      } catch {
        failed += 1;
      }
    }

    const existingCookies = await browserSession.cookies.get({});
    const sourceIdentityKeys = new Map<string, Set<string>>();
    for (const [familyKey, family] of googleFamilies) {
      sourceIdentityKeys.set(
        familyKey,
        new Set(family.map((cookie) => cookieIdentityKey(cookie))),
      );
    }
    for (const existing of existingCookies) {
      const familyKey = googleCookieFamilyKey(existing);
      if (!familyKey || !this.knownMirroredCookieFamilies.has(familyKey)) {
        continue;
      }
      const incoming = sourceIdentityKeys.get(familyKey);
      if (incoming?.has(cookieIdentityKey(existing))) continue;
      try {
        await this.removeSessionCookie(existing);
      } catch {
        failed += 1;
      }
    }
    for (const family of googleFamilies.values()) {
      for (const cookie of family) {
        try {
          await this.setSessionCookie(cookie);
        } catch {
          failed += 1;
        }
      }
    }

    await browserSession.cookies.flushStore();
    browserSession.flushStorageData();
    const seedTab = this.options.getSeedTabContents();
    if (seedTab) await this.applyPendingPartitionedCookies(seedTab);
    if (failed > 0 || partitioned > 0 || preserved > 0) {
      console.warn(
        `[in-app-browser] Cookie seed completed with ${failed} failed, ${partitioned} partitioned, and ${preserved} preserved (trust-critical) cookie(s).`,
      );
    }
  }

  private async setSessionCookie(cookie: StellaBrowserExportedCookie) {
    const browserSession = this.browserSession;
    const url = cookieUrl(cookie);
    if (!browserSession || !url) return;
    await browserSession.cookies.set({
      url,
      name: cookie.name,
      value: cookie.value,
      ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
      path: cookie.path || "/",
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      ...(!cookie.session && typeof cookie.expirationDate === "number"
        ? { expirationDate: cookie.expirationDate }
        : {}),
    });
  }

  private async removeSessionCookie(cookie: Cookie) {
    const browserSession = this.browserSession;
    const url = cookieUrl(cookie);
    if (!browserSession || !url) return;
    await browserSession.cookies.set({
      url,
      name: cookie.name,
      value: "",
      ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
      path: cookie.path || "/",
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expirationDate: 1,
    });
  }

  /**
   * Start the continuous cookie mirror. After the initial seed this re-pulls
   * the real browser's cookies on a cadence and re-applies them to the in-app
   * session, so the in-app store never goes stale. Uses a self-rescheduling
   * timeout (not setInterval) so a slow reseed can never overlap the next tick,
   * is unref'd so it does not keep the process alive, and is torn down in
   * dispose(). No-op if already running or disposed.
   */
  private startCookieMirror() {
    if (this.cookieMirrorTimer || this.disposed) return;
    const intervalMs = Math.max(
      MIN_COOKIE_MIRROR_INTERVAL_MS,
      this.options.cookieMirrorIntervalMs ?? DEFAULT_COOKIE_MIRROR_INTERVAL_MS,
    );
    const scheduleNext = () => {
      if (this.disposed) {
        this.cookieMirrorTimer = null;
        return;
      }
      const timer = setTimeout(() => {
        void this.reseedFromExtension()
          .catch(() => {})
          .finally(scheduleNext);
      }, intervalMs);
      timer.unref?.();
      this.cookieMirrorTimer = timer;
    };
    scheduleNext();
  }

  private stopCookieMirror() {
    if (this.cookieMirrorTimer) {
      clearTimeout(this.cookieMirrorTimer);
      this.cookieMirrorTimer = null;
    }
  }

  /**
   * Re-pull cookies from the real browser (via the extension) and re-apply them
   * to the in-app session. Safe to call repeatedly and concurrently: a
   * single-flight guard prevents overlapping writes to the shared cookie store,
   * and it only ever writes to `this.browserSession` (the in-app profile), never
   * to any other Electron session. No-op until the initial seed has run.
   */
  private async reseedFromExtension(): Promise<void> {
    if (this.disposed || !this.seededOnce || !this.browserSession) return;
    this.reseedRequested = true;
    if (this.reseedInFlight) return await this.reseedInFlight;

    const reseed = (async () => {
      while (
        this.reseedRequested &&
        !this.disposed &&
        this.seededOnce &&
        this.browserSession
      ) {
        this.reseedRequested = false;
        try {
          const extensionConnected = await this.options
            .getExtensionStatus()
            .catch(() => false);
          if (!extensionConnected || this.disposed) continue;
          const cookies = await this.exportCookies();
          if (this.disposed || !this.browserSession) continue;
          await this.seedCookies(cookies);
          this.lastReseedAt = Date.now();
        } catch (error) {
          // A failed mirror pass must never kill the mirror loop; the next tick
          // retries. Transient bridge/daemon errors are expected during extension
          // wake or app shutdown.
          console.warn(
            `[in-app-browser] Cookie mirror refresh failed: ${errorMessage(error)}`,
          );
        }
      }
    })().finally(() => {
      if (this.reseedInFlight === reseed) this.reseedInFlight = null;
    });
    this.reseedInFlight = reseed;
    await reseed;
  }

  private async reconcileBeforeGoogleNavigation(url: string): Promise<void> {
    if (!isGoogleAuthNavigation(url) || this.disposed) return;
    await this.options.awaitConnection();
    if (this.seededOnce) await this.reseedFromExtension();
  }

  async prepareGoogleNavigation(
    webContentsId: number,
    url: string,
  ): Promise<void> {
    if (!isGoogleAuthNavigation(url)) return;
    await this.reconcileBeforeGoogleNavigation(url);
    this.googleNavigationReadyContents.add(webContentsId);
  }

  /**
   * Reconcile-on-navigation: refresh cookies around a top-level navigation so
   * the target site sees a current session on its subresource / XHR / next-hop
   * requests. Non-blocking and throttled so rapid navigations don't each pull a
   * full cookie export.
   */
  scheduleNavigationReseed() {
    if (this.disposed || !this.seededOnce) return;
    const throttleMs =
      this.options.navigationReseedThrottleMs ??
      DEFAULT_NAVIGATION_RESEED_THROTTLE_MS;
    if (Date.now() - this.lastReseedAt < throttleMs) return;
    void this.reseedFromExtension().catch(() => {});
  }

  /**
   * Start the real-time cookie-event subscription (primary freshness path).
   * Idempotent; no-op if already running, disposed, or the option is absent.
   */
  private startCookieEventSubscription() {
    if (
      this.cookieEventUnsubscribe ||
      this.disposed ||
      !this.options.subscribeCookieEvents
    ) {
      return;
    }
    this.cookieEventUnsubscribe = this.options.subscribeCookieEvents(
      (event) => {
        void this.handleCookieEvent(event).catch(() => {});
      },
    );
  }

  private stopCookieEventSubscription() {
    if (this.cookieEventUnsubscribe) {
      try {
        this.cookieEventUnsubscribe();
      } catch {
        // A best-effort unsubscribe must not throw out of dispose().
      }
      this.cookieEventUnsubscribe = null;
    }
  }

  /**
   * Handle one pushed bridge event. `cookies_changed` applies each change to the
   * in-app session immediately; `events_lagged` means the extension outran the
   * broadcast buffer, so we full-reconcile to catch up.
   */
  private async handleCookieEvent(
    event: StellaBrowserBridgeEvent,
  ): Promise<void> {
    if (this.disposed || !this.browserSession) return;
    const kind = typeof event.event === "string" ? event.event : "";
    if (kind === "events_lagged") {
      await this.reseedFromExtension();
      return;
    }
    if (kind !== "cookies_changed") return;
    const changes = Array.isArray(event.changes) ? event.changes : [];
    const familyChanges = changes.flatMap((change) => {
      const cookie = change?.cookie;
      const familyKey = cookie ? googleCookieFamilyKey(cookie) : null;
      return familyKey && cookie ? [{ familyKey, cookie }] : [];
    });
    if (familyChanges.length > 0) {
      for (const { familyKey, cookie } of familyChanges) {
        if (cookie.partitionKey?.topLevelSite) {
          this.knownMirroredPartitionedCookieFamilies.add(familyKey);
        } else {
          this.knownMirroredCookieFamilies.add(familyKey);
        }
      }
      // A Google rotation commonly arrives as remove(old), set(new), plus
      // sibling 1P/3P variants. Never apply those edges independently: pull one
      // complete source snapshot and reconcile every affected family together.
      await this.reseedFromExtension();
      return;
    }
    // Apply in order: an overwrite arrives as remove(old) then set(new), so
    // preserving order keeps the final value correct.
    for (const change of changes) {
      if (this.disposed || !this.browserSession) return;
      await this.applyCookieChange(change);
    }
  }

  /**
   * Apply a single real-browser cookie change to the in-app session. Writes only
   * to `this.browserSession` (the in-app profile). Mirrors seedCookies' rules:
   * partitioned cookies are skipped here (applied per-tab via CDP), and a live
   * trust-critical managed cookie is never clobbered by a mid-rotation copy.
   */
  private async applyCookieChange(
    change: StellaBrowserCookieChange,
  ): Promise<void> {
    const session = this.browserSession;
    if (!session) return;
    const cookie = change?.cookie;
    if (!cookie || !cookie.name) return;
    const url = cookieUrl(cookie);
    if (!url) return;
    if (cookie.partitionKey?.topLevelSite) return;

    if (change.removed) {
      try {
        await session.cookies.remove(url, cookie.name);
      } catch {
        // Removal is best-effort; the periodic reconcile is the backstop.
      }
      return;
    }

    if (isTrustCriticalCookieName(cookie.name)) {
      try {
        const existingForName = await session.cookies.get({
          url,
          name: cookie.name,
        });
        const existing = existingForName.find(
          (candidate) => candidate.name === cookie.name,
        );
        if (shouldPreserveExistingCookie(existing, cookie)) return;
      } catch {
        // If we can't read the existing cookie, fall through and set it.
      }
    }

    try {
      await this.setSessionCookie(cookie);
    } catch {
      // A single failed cookie must not stop the stream; reconcile recovers it.
    }
  }

  /**
   * Partitioned cookies cannot go through `session.cookies`, so they are set
   * over the tab's CDP connection before it loads a page.
   */
  async applyPendingPartitionedCookies(contents: WebContents) {
    if (
      this.pendingPartitionedCookies.length === 0 &&
      this.knownMirroredPartitionedCookieFamilies.size === 0
    ) {
      return;
    }
    const sameSite = (value: StellaBrowserExportedCookie["sameSite"]) => {
      if (value === "no_restriction") return "None";
      if (value === "lax") return "Lax";
      if (value === "strict") return "Strict";
      return undefined;
    };
    const cookies = this.pendingPartitionedCookies.flatMap((cookie) => {
      const url = cookieUrl(cookie);
      if (!url || !cookie.name || !cookie.partitionKey?.topLevelSite) return [];
      const mappedSameSite = sameSite(cookie.sameSite);
      return [
        {
          name: cookie.name,
          value: cookie.value,
          url,
          ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
          path: cookie.path || "/",
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          ...(mappedSameSite ? { sameSite: mappedSameSite } : {}),
          ...(!cookie.session && typeof cookie.expirationDate === "number"
            ? { expires: cookie.expirationDate }
            : {}),
          partitionKey: cookie.partitionKey,
        },
      ];
    });
    try {
      const tabDebugger = contents.debugger;
      if (!tabDebugger.isAttached()) tabDebugger.attach();
      const sourceIdentityKeys = new Map<string, Set<string>>();
      for (const cookie of this.pendingPartitionedCookies) {
        const familyKey = googleCookieFamilyKey(cookie);
        if (!familyKey) continue;
        const family = sourceIdentityKeys.get(familyKey) ?? new Set<string>();
        family.add(cookieIdentityKey(cookie));
        sourceIdentityKeys.set(familyKey, family);
      }
      const current = (await tabDebugger.sendCommand(
        "Network.getAllCookies",
      )) as { cookies?: StellaBrowserExportedCookie[] };
      for (const existing of current.cookies ?? []) {
        if (!existing.partitionKey?.topLevelSite) continue;
        const familyKey = googleCookieFamilyKey(existing);
        if (
          !familyKey ||
          !this.knownMirroredPartitionedCookieFamilies.has(familyKey) ||
          sourceIdentityKeys.get(familyKey)?.has(cookieIdentityKey(existing))
        ) {
          continue;
        }
        await tabDebugger.sendCommand("Network.deleteCookies", {
          name: existing.name,
          domain: existing.domain,
          path: existing.path || "/",
          partitionKey: existing.partitionKey,
        });
      }
      if (cookies.length > 0) {
        await tabDebugger.sendCommand("Network.setCookies", { cookies });
      }
      this.pendingPartitionedCookies = [];
    } catch (error) {
      console.warn(
        `[in-app-browser] Could not restore partitioned cookies: ${errorMessage(error)}`,
      );
    }
  }
}
