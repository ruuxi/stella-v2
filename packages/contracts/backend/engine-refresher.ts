/**
 * Keeps the owner's Claude sign-ins fresh from one of their own devices
 * (desktop always, mobile while the app is open). Stella's server never
 * refreshes these tokens; whichever signed-in device is around does.
 *
 * Every connected Claude account carries `refreshAt` (half its token's life,
 * on the server's clock) in the live `engines.get` view. When it comes due,
 * plus a little random jitter so the owner's devices don't all ask at once,
 * this takes the account's refresh lease, refreshes with Anthropic and
 * uploads the result. The lease, not the jitter, guarantees one refresher:
 * refresh tokens rotate, so a second refresh with the same token would sign
 * the account out. A refresh that lands moves `refreshAt` in the view, which
 * reschedules every device.
 */

import type { CallResult } from "./api.js";
import type { BackendClient } from "./client.js";
import { BackendRequestError } from "./client.js";
import {
  DEVICE_AUTH_PROVIDERS,
  type DeviceAuthProvider,
  type EngineSettings,
} from "./engines.js";
import { EngineRefreshRejectedError, refreshAnthropicTokens } from "../engine-oauth-flows.js";

/** Spread when an account comes due while devices are online. */
const DUE_JITTER_MS = 5 * 60_000;
/** Spread when an account was already due (a device just came online). */
const LATE_JITTER_MS = 15_000;
/** Longest single timer; the schedule is recomputed at least this often. */
const MAX_TIMER_MS = 60 * 60_000;
const FAILURE_BACKOFF_MS = 60_000;
const MAX_FAILURE_BACKOFF_MS = 30 * 60_000;
/** Anthropic refused the refresh token: it won't work again until a new sign-in. */
const REJECTED_BACKOFF_MS = 6 * 60 * 60_000;
const UPLOAD_ATTEMPTS = 3;

export type EngineRefreshOutcome = "refreshed" | "fresh" | "busy" | "failed";

export type EngineTokenRefresherOptions = {
  /** The backend client, or null while signed out. */
  client: () => Pick<BackendClient, "call"> | null;
  fetch?: typeof fetch;
  random?: () => number;
  log?: (message: string) => void;
};

const isDeviceAuthProvider = (value: string): value is DeviceAuthProvider =>
  (DEVICE_AUTH_PROVIDERS as readonly string[]).includes(value);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class EngineTokenRefresher {
  readonly #options: EngineTokenRefresherOptions;
  #settings: EngineSettings | null = null;
  #active = true;
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #running = new Map<string, Promise<EngineRefreshOutcome>>();
  /** Per account: don't ask before this (device clock), after a refusal or failure. */
  readonly #notBefore = new Map<string, number>();
  readonly #failures = new Map<string, number>();
  /** Per account and `refreshAt`: a stable spread in [0, 1). */
  readonly #jitter = new Map<string, { refreshAt: number; value: number }>();

  constructor(options: EngineTokenRefresherOptions) {
    this.#options = options;
  }

  /** The live `engines.get` value (null while signed out). */
  update(settings: EngineSettings | null): void {
    this.#settings = settings;
    this.#schedule();
  }

  /** Mobile pauses while the app is in the background. */
  setActive(active: boolean): void {
    this.#active = active;
    this.#schedule();
  }

  dispose(): void {
    this.#active = false;
    this.#settings = null;
    this.#clearTimer();
  }

  /**
   * Refresh one account now if the server says it is due (or, with `force`,
   * because Anthropic rejected its access token early). One attempt per
   * account at a time on this device; the lease covers the others.
   */
  refreshNow(
    provider: DeviceAuthProvider,
    engineAccountId: string,
    options: { force?: boolean } = {},
  ): Promise<EngineRefreshOutcome> {
    const pending = this.#running.get(engineAccountId);
    if (pending) return pending;
    const run = this.#refresh(provider, engineAccountId, options.force === true).finally(() => {
      this.#running.delete(engineAccountId);
      this.#schedule();
    });
    this.#running.set(engineAccountId, run);
    return run;
  }

  async #refresh(
    provider: DeviceAuthProvider,
    engineAccountId: string,
    force: boolean,
  ): Promise<EngineRefreshOutcome> {
    const client = this.#options.client();
    if (!client) return "failed";
    let lease: CallResult<"engines.beginRefresh">;
    try {
      lease = await client.call("engines.beginRefresh", {
        provider,
        engineAccountId,
        ...(force ? { force: true } : {}),
      });
    } catch {
      this.#backOff(engineAccountId);
      return "failed";
    }
    if (lease.status !== "granted") {
      // Another device refreshed or is refreshing: look again when the
      // server says, measured on this device's clock.
      this.#notBefore.set(engineAccountId, Date.now() + Math.max(lease.retryInMs, 1_000));
      return lease.status;
    }

    let tokens: Awaited<ReturnType<typeof refreshAnthropicTokens>>;
    try {
      tokens = await refreshAnthropicTokens(lease.refreshToken, {
        ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
      });
    } catch (error) {
      await client
        .call("engines.abandonRefresh", { provider, engineAccountId, leaseId: lease.leaseId })
        .catch(() => undefined);
      this.#backOff(engineAccountId, error instanceof EngineRefreshRejectedError);
      this.#options.log?.(
        `[engine-refresh] ${provider} ${engineAccountId} refresh failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return "failed";
    }

    // The old refresh token is spent; this upload is the only copy of the new
    // one, so a transport failure is retried. A conflict means the account
    // changed underneath (signed out or signed in again): nothing to keep.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await client.call("engines.completeRefresh", {
          provider,
          engineAccountId,
          leaseId: lease.leaseId,
          tokens: {
            access: tokens.access,
            refresh: tokens.refresh,
            expiresInMs: tokens.expiresAt - Date.now(),
          },
        });
        this.#failures.delete(engineAccountId);
        this.#notBefore.delete(engineAccountId);
        return "refreshed";
      } catch (error) {
        const conflict = error instanceof BackendRequestError && error.code === "CONFLICT";
        if (conflict || attempt >= UPLOAD_ATTEMPTS) {
          this.#backOff(engineAccountId);
          this.#options.log?.(
            `[engine-refresh] ${provider} ${engineAccountId} upload failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return "failed";
        }
        await sleep(attempt * 2_000);
      }
    }
  }

  #backOff(engineAccountId: string, rejected = false): void {
    const failures = (this.#failures.get(engineAccountId) ?? 0) + 1;
    this.#failures.set(engineAccountId, failures);
    const delay = rejected
      ? REJECTED_BACKOFF_MS
      : Math.min(MAX_FAILURE_BACKOFF_MS, FAILURE_BACKOFF_MS * 2 ** (failures - 1));
    this.#notBefore.set(engineAccountId, Date.now() + delay);
  }

  #jitterFor(engineAccountId: string, refreshAt: number): number {
    const current = this.#jitter.get(engineAccountId);
    if (current?.refreshAt === refreshAt) return current.value;
    const value = (this.#options.random ?? Math.random)();
    this.#jitter.set(engineAccountId, { refreshAt, value });
    return value;
  }

  /** When each Claude account should next be refreshed on this device. */
  #dueAccounts(now: number): Array<{
    provider: DeviceAuthProvider;
    engineAccountId: string;
    dueAt: number;
  }> {
    return (this.#settings?.connections ?? []).flatMap((row) => {
      if (!isDeviceAuthProvider(row.provider)) return [];
      const refreshAt = row.refreshAt ?? 0;
      const spread = this.#jitterFor(row.accountId, refreshAt);
      const dueAt = Math.max(
        refreshAt + spread * (refreshAt <= now ? LATE_JITTER_MS : DUE_JITTER_MS),
        this.#notBefore.get(row.accountId) ?? 0,
      );
      return [{ provider: row.provider, engineAccountId: row.accountId, dueAt }];
    });
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(): void {
    this.#clearTimer();
    if (!this.#active || !this.#settings) return;
    const now = Date.now();
    const due = this.#dueAccounts(now).filter((entry) => !this.#running.has(entry.engineAccountId));
    if (due.length === 0) return;
    const next = Math.min(...due.map((entry) => entry.dueAt));
    const delay = Math.min(Math.max(next - now, 0), MAX_TIMER_MS);
    this.#timer = setTimeout(() => void this.#fire(), delay);
    (this.#timer as { unref?: () => void }).unref?.();
  }

  async #fire(): Promise<void> {
    this.#timer = null;
    if (!this.#active) return;
    const now = Date.now();
    const due = this.#dueAccounts(now).filter(
      (entry) => entry.dueAt <= now && !this.#running.has(entry.engineAccountId),
    );
    if (due.length === 0) {
      this.#schedule();
      return;
    }
    for (const entry of due) {
      await this.refreshNow(entry.provider, entry.engineAccountId);
    }
  }
}
