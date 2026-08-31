import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  TELEMETRY_PROJECT,
  TELEMETRY_SCHEMA_VERSION,
  isTelemetryEventBody,
  isTelemetryEventV1,
  type TelemetryBatchV1,
  type TelemetryEventBody,
  type TelemetryEventContext,
  type TelemetryEventV1,
} from "@stella/contracts/telemetry/events";

/**
 * Node/Electron-only remote telemetry delivery.
 *
 * The renderer must never import this module. Producers submit one of the
 * closed metadata-only event variants from `@stella/contracts`; arbitrary
 * objects cannot reach the network or durable spool.
 */

const DEFAULT_MAX_QUEUED_EVENTS = 2_000;
const DEFAULT_MAX_SPOOL_BYTES = 8 * 1024 * 1024;
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_INITIAL_RETRY_MS = 1_000;
const DEFAULT_MAX_RETRY_MS = 60_000;

type Awaitable<T> = T | Promise<T>;

export type RemoteTelemetryTransportConfig = {
  endpoint: string;
  /** Raw bearer token. It is used only in-memory and is never logged/spooled. */
  authToken?: string;
  /**
   * Pseudonymous identity lane for authenticated durable queues. When the
   * client itself is scoped, a transport for any other lane is refused.
   */
  principalScope?: string;
};

export type RemoteTelemetryClientOptions = {
  /** Absolute, process-specific `.jsonl` file. Main and worker must not share it. */
  spoolPath: string;
  getContext: () => Awaitable<TelemetryEventContext | null>;
  getTransportConfig: () => Awaitable<RemoteTelemetryTransportConfig | null>;
  fetch?: typeof globalThis.fetch;
  maxQueuedEvents?: number;
  maxSpoolBytes?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  requestTimeoutMs?: number;
  initialRetryMs?: number;
  maxRetryMs?: number;
  /** Test/development seam. Production endpoints must be HTTPS. */
  allowInsecureEndpoint?: boolean;
  random?: () => number;
  now?: () => number;
  eventId?: () => string;
  /** Pseudonymous identity lane bound to this durable spool. */
  principalScope?: string;
};

export type RemoteTelemetryStats = {
  queued: number;
  accepted: number;
  sent: number;
  dropped: number;
  rejected: number;
  failedBatches: number;
  spoolErrors: number;
};

const positiveInt = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;

const safeEndpoint = (raw: string, allowInsecure: boolean): string | null => {
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol === "https:") return url.toString();
    if (
      allowInsecure &&
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" ||
        url.hostname === "localhost" ||
        url.hostname === "::1")
    ) {
      return url.toString();
    }
  } catch {
    // Invalid/missing dynamic config disables this flush attempt.
  }
  return null;
};

const eventLine = (event: TelemetryEventV1): string =>
  `${JSON.stringify(event)}\n`;

const lineBytes = (line: string): number => Buffer.byteLength(line, "utf8");

const batchId = (events: readonly TelemetryEventV1[]): string =>
  createHash("sha256")
    .update(events.map((event) => event.eventId).join("\n"))
    .digest("hex");

const withUnrefTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export class RemoteTelemetryClient {
  private readonly options: Required<
    Pick<
      RemoteTelemetryClientOptions,
      | "maxQueuedEvents"
      | "maxSpoolBytes"
      | "batchSize"
      | "flushIntervalMs"
      | "requestTimeoutMs"
      | "initialRetryMs"
      | "maxRetryMs"
      | "allowInsecureEndpoint"
      | "random"
      | "now"
      | "eventId"
    >
  > &
    Pick<
      RemoteTelemetryClientOptions,
      "spoolPath" | "getContext" | "getTransportConfig"
    > & { fetch: typeof globalThis.fetch };

  private queue: TelemetryEventV1[] = [];
  private readonly principalScope: string | null;
  private spoolBytes = 0;
  private writeTail: Promise<void> = Promise.resolve();
  private readonly ready: Promise<void>;
  private flushPromise: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerDueAt = 0;
  private retryAttempt = 0;
  private closing = false;
  private closed = false;
  private stats: Omit<RemoteTelemetryStats, "queued"> = {
    accepted: 0,
    sent: 0,
    dropped: 0,
    rejected: 0,
    failedBatches: 0,
    spoolErrors: 0,
  };

  constructor(options: RemoteTelemetryClientOptions) {
    this.principalScope = options.principalScope?.trim() || null;
    this.options = {
      spoolPath: path.resolve(options.spoolPath),
      getContext: options.getContext,
      getTransportConfig: options.getTransportConfig,
      fetch: options.fetch ?? globalThis.fetch,
      maxQueuedEvents: positiveInt(
        options.maxQueuedEvents,
        DEFAULT_MAX_QUEUED_EVENTS,
      ),
      maxSpoolBytes: positiveInt(
        options.maxSpoolBytes,
        DEFAULT_MAX_SPOOL_BYTES,
      ),
      batchSize: Math.min(
        MAX_BATCH_SIZE,
        positiveInt(options.batchSize, DEFAULT_BATCH_SIZE),
      ),
      flushIntervalMs: positiveInt(
        options.flushIntervalMs,
        DEFAULT_FLUSH_INTERVAL_MS,
      ),
      requestTimeoutMs: positiveInt(
        options.requestTimeoutMs,
        DEFAULT_REQUEST_TIMEOUT_MS,
      ),
      initialRetryMs: positiveInt(
        options.initialRetryMs,
        DEFAULT_INITIAL_RETRY_MS,
      ),
      maxRetryMs: positiveInt(options.maxRetryMs, DEFAULT_MAX_RETRY_MS),
      allowInsecureEndpoint: options.allowInsecureEndpoint ?? false,
      random: options.random ?? Math.random,
      now: options.now ?? Date.now,
      eventId: options.eventId ?? randomUUID,
    };
    this.ready = this.initialize().catch(() => {
      this.stats.spoolErrors += 1;
    });
  }

  /**
   * Validate, envelope, and durably enqueue one metadata event. Never throws.
   * Resolves to the idempotency key only after the spool append/compaction.
   */
  async record(event: TelemetryEventBody): Promise<string | null> {
    if (this.closing || this.closed || !isTelemetryEventBody(event)) {
      this.stats.rejected += 1;
      return null;
    }

    try {
      const context = await this.options.getContext();
      if (!context) {
        this.stats.rejected += 1;
        return null;
      }
      const envelope: TelemetryEventV1 = {
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        eventId: this.options.eventId(),
        occurredAtMs: Math.max(0, Math.floor(this.options.now())),
        project: TELEMETRY_PROJECT,
        environment: context.environment,
        source: context.source,
        ...(context.release ? { release: context.release } : {}),
        ...(context.installationIdSha256
          ? { installationIdSha256: context.installationIdSha256 }
          : {}),
        ...(context.ownerIdSha256
          ? { ownerIdSha256: context.ownerIdSha256 }
          : {}),
        // Keep no caller-owned reference: a mutation after validation must not
        // be able to add content-bearing fields before a later flush/rewrite.
        event: structuredClone(event),
      };
      if (!isTelemetryEventV1(envelope)) {
        this.stats.rejected += 1;
        return null;
      }

      await this.serializeSpool(async () => {
        await this.ready;
        this.queue.push(envelope);
        this.stats.accepted += 1;
        let compact = false;
        if (this.queue.length > this.options.maxQueuedEvents) {
          const overflow = this.queue.length - this.options.maxQueuedEvents;
          this.queue.splice(0, overflow);
          this.stats.dropped += overflow;
          compact = true;
        }
        const line = eventLine(envelope);
        try {
          await appendFile(this.options.spoolPath, line, {
            encoding: "utf8",
            mode: 0o600,
          });
          this.spoolBytes += lineBytes(line);
        } catch {
          this.stats.spoolErrors += 1;
        }
        if (compact || this.spoolBytes > this.options.maxSpoolBytes) {
          await this.rewriteSpool();
        }
      });
      this.schedule(this.options.flushIntervalMs);
      return envelope.eventId;
    } catch {
      this.stats.rejected += 1;
      return null;
    }
  }

  /** Flush one bounded batch. Concurrent callers share the same attempt. */
  async flush(): Promise<boolean> {
    if (this.closed) return false;
    if (this.flushPromise) return await this.flushPromise;
    this.clearScheduledFlush();
    this.flushPromise = this.flushOnce().finally(() => {
      this.flushPromise = null;
    });
    return await this.flushPromise;
  }

  /**
   * Stop timers, wait for pending spool writes, and make one final send attempt.
   * Unsent events remain in the durable spool for the next process.
   */
  async close(options: { timeoutMs?: number } = {}): Promise<boolean> {
    if (this.closed) return true;
    this.closing = true;
    this.clearScheduledFlush();
    const timeoutMs = positiveInt(options.timeoutMs, 5_000);
    const result = await withUnrefTimeout(
      (async () => {
        await this.writeTail;
        return await this.flush();
      })(),
      timeoutMs,
    ).catch(() => null);
    this.closed = true;
    this.clearScheduledFlush();
    return result === true || (await this.getStats()).queued === 0;
  }

  async getStats(): Promise<RemoteTelemetryStats> {
    await this.ready;
    await this.writeTail;
    return { queued: this.queue.length, ...this.stats };
  }

  private async initialize(): Promise<void> {
    await mkdir(path.dirname(this.options.spoolPath), {
      recursive: true,
      mode: 0o700,
    });
    let raw = "";
    try {
      raw = await readFile(this.options.spoolPath, "utf8");
      await chmod(this.options.spoolPath, 0o600).catch(() => {
        this.stats.spoolErrors += 1;
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.stats.spoolErrors += 1;
      }
      return;
    }

    let malformed = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (isTelemetryEventV1(value)) this.queue.push(value);
        else malformed += 1;
      } catch {
        malformed += 1;
      }
    }
    this.spoolBytes = Buffer.byteLength(raw, "utf8");
    if (malformed > 0 || this.queue.length > this.options.maxQueuedEvents) {
      this.stats.dropped +=
        malformed +
        Math.max(0, this.queue.length - this.options.maxQueuedEvents);
      this.queue = this.queue.slice(-this.options.maxQueuedEvents);
      await this.rewriteSpool();
    } else if (this.spoolBytes > this.options.maxSpoolBytes) {
      await this.rewriteSpool();
    }
    if (this.queue.length > 0) this.schedule(this.options.flushIntervalMs);
  }

  private serializeSpool(task: () => Promise<void>): Promise<void> {
    const next = this.writeTail.then(task, task);
    this.writeTail = next.catch(() => {
      this.stats.spoolErrors += 1;
    });
    return this.writeTail;
  }

  private async rewriteSpool(): Promise<void> {
    const retained: TelemetryEventV1[] = [];
    const lines: string[] = [];
    let bytes = 0;
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const event = this.queue[index]!;
      const line = eventLine(event);
      const size = lineBytes(line);
      if (bytes + size > this.options.maxSpoolBytes) continue;
      retained.unshift(event);
      lines.unshift(line);
      bytes += size;
    }
    if (retained.length < this.queue.length) {
      this.stats.dropped += this.queue.length - retained.length;
      this.queue = retained;
    }

    const temporary = `${this.options.spoolPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, lines.join(""), {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.options.spoolPath);
      this.spoolBytes = bytes;
    } catch {
      this.stats.spoolErrors += 1;
    }
  }

  private async flushOnce(): Promise<boolean> {
    await this.ready;
    await this.writeTail;
    if (this.queue.length === 0) {
      this.retryAttempt = 0;
      return true;
    }

    let transport: RemoteTelemetryTransportConfig | null = null;
    try {
      transport = await this.options.getTransportConfig();
    } catch {
      // Dynamic auth/config lookup is best-effort.
    }
    const endpoint = transport
      ? safeEndpoint(transport.endpoint, this.options.allowInsecureEndpoint)
      : null;
    if (
      !transport ||
      !endpoint ||
      (this.principalScope !== null &&
        transport.principalScope !== this.principalScope)
    ) {
      this.scheduleRetry();
      return false;
    }

    const events = this.queue.slice(0, this.options.batchSize);
    const body: TelemetryBatchV1 = {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      events,
    };
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("telemetry request timed out")),
      this.options.requestTimeoutMs,
    );
    timeout.unref?.();
    let ok = false;
    let permanentRejection = false;
    try {
      const response = await this.options.fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stella-telemetry-batch-id": batchId(events),
          ...(transport.authToken?.trim()
            ? { authorization: `Bearer ${transport.authToken.trim()}` }
            : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      });
      ok = response.ok;
      // Drop only payload errors. Auth, routing, and rate-limit failures can
      // recover after a token refresh, Worker rollout, or backoff window.
      permanentRejection = [400, 413, 415, 422].includes(response.status);
      await response.body?.cancel().catch(() => undefined);
    } catch {
      ok = false;
    } finally {
      clearTimeout(timeout);
    }

    if (!ok && !permanentRejection) {
      this.stats.failedBatches += 1;
      this.scheduleRetry();
      return false;
    }

    const delivered = new Set(events.map((event) => event.eventId));
    await this.serializeSpool(async () => {
      this.queue = this.queue.filter((event) => !delivered.has(event.eventId));
      if (ok) this.stats.sent += events.length;
      else {
        this.stats.rejected += events.length;
        this.stats.dropped += events.length;
      }
      await this.rewriteSpool();
    });
    this.retryAttempt = 0;
    if (this.queue.length > 0 && !this.closing) this.schedule(0);
    return true;
  }

  private scheduleRetry(): void {
    if (this.closing || this.closed) return;
    const exponent = Math.min(this.retryAttempt, 16);
    const ceiling = Math.min(
      this.options.maxRetryMs,
      this.options.initialRetryMs * 2 ** exponent,
    );
    this.retryAttempt += 1;
    // Full jitter avoids synchronized desktop retry waves after an outage.
    this.schedule(Math.max(1, Math.floor(this.options.random() * ceiling)));
  }

  private schedule(delayMs: number): void {
    if (this.closing || this.closed) return;
    const dueAt = Date.now() + delayMs;
    if (this.timer && this.timerDueAt <= dueAt) return;
    this.clearScheduledFlush();
    this.timerDueAt = dueAt;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerDueAt = 0;
      void this.flush();
    }, delayMs);
    this.timer.unref?.();
  }

  private clearScheduledFlush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerDueAt = 0;
  }
}

export const createRemoteTelemetryClient = (
  options: RemoteTelemetryClientOptions,
): RemoteTelemetryClient => new RemoteTelemetryClient(options);
