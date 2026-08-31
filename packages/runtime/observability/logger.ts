import {
  chmodSync,
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  Context,
  Effect,
  Formatter,
  Layer,
  Semaphore,
  type Scope,
} from "effect";

/**
 * Effect-native core of the local debug logger
 * (see `file-logger.ts` for the plain facade every current caller uses).
 *
 * The logger is a scoped resource: the layer acquires the open-file table
 * via `Effect.acquireRelease`, the daily rollover closes and reopens the
 * per-channel descriptors (rotate), and closing the layer's scope closes
 * whatever is still open. Rotation is a size/date check inside the write
 * effect itself — there are no timers anywhere in this module.
 *
 * Writes stay fully synchronous (`openSync` + `writeSync` on an `O_APPEND`
 * descriptor): diagnostic volume is low, and sync writes guarantee the line
 * lands on disk even if the process is mid-crash — which is exactly when
 * these logs matter most. The write path is serialized through a
 * one-permit semaphore so concurrent fibers can never interleave a
 * rollover (close/sweep/reopen) with another fiber's append; the plain
 * facade's `runSync` calls take the free permit synchronously. Every
 * filesystem error is swallowed inside the effect — a write effect never
 * fails and never throws into callers.
 */

export type LogChannel = "error" | "process";
export type LogLevel = "info" | "warn" | "error" | "fatal";
export type LogFields = Record<string, unknown>;

const DEFAULT_RETENTION_DAYS = 7;
// Soft per-file cap so a crash loop can't fill the disk within a single
// day. Once a day's file passes this we stop appending to it (a single
// truncation marker is written once); it resets at the next daily rollover.
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
// Total budget across every log file in the directory. Enforced on the
// age sweep (init + daily rollover): oldest files are deleted first until
// the directory is back under budget. Bounds long-term accumulation
// independent of the day-count retention window.
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const LOG_FILE_PATTERN = /^(error|process)-\d{4}-\d{2}-\d{2}\.txt$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const flattenFields = (
  input: Record<string, unknown>,
  prefix = "",
  seen = new WeakSet<object>(),
): Array<readonly [string, unknown]> => {
  if (seen.has(input)) return [[prefix || "value", "[Circular]"]];
  seen.add(input);
  const entries = Object.entries(input);
  if (entries.length === 0 && prefix) return [[prefix, input]];
  return entries.flatMap(([key, value]) => {
    const field = prefix ? `${prefix}.${key}` : key;
    return isPlainObject(value)
      ? flattenFields(value, field, seen)
      : [[field, value] as const];
  });
};

const formatValue = (input: unknown): string => {
  const value = typeof input === "string" ? input : Formatter.format(input);
  return /^[^\s="\\]+$/u.test(value) ? value : JSON.stringify(value);
};

const dateStamp = (now: Date): string => {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const parsePositiveInt = (
  raw: string | undefined,
  fallback: number,
): number => {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export type FileLoggerOptions = {
  /** Absolute directory the log files live in. */
  logDir: string;
  /** Identifies the writing process, e.g. "main" or "worker". */
  component: string;
  /** Delete files older than this many days. */
  retentionDays?: number;
  /** Stop appending to a single day's file once it passes this size. */
  maxFileBytes?: number;
  /** Total byte budget across all log files; oldest are deleted first. */
  maxTotalBytes?: number;
};

export interface Interface {
  /** Append one structured local-debug line to a channel. Never throws. */
  readonly write: (
    channel: LogChannel,
    level: LogLevel,
    event: string,
    fields?: LogFields,
  ) => Effect.Effect<void>;
  /** Lifecycle / process event (worker + native helper start/stop/cleanup). */
  readonly process: (event: string, fields?: LogFields) => Effect.Effect<void>;
  /** Non-fatal warning routed to the process channel. */
  readonly warn: (event: string, fields?: LogFields) => Effect.Effect<void>;
  /** Recoverable error. */
  readonly error: (event: string, fields?: LogFields) => Effect.Effect<void>;
  /** Crash / fatal error with its stack trace. */
  readonly crash: (
    event: string,
    error: unknown,
    fields?: LogFields,
  ) => Effect.Effect<void>;
}

export class ObservabilityLogger extends Context.Service<
  ObservabilityLogger,
  Interface
>()("@stella/runtime/observability/ObservabilityLogger") {}

const make = (
  options: FileLoggerOptions,
): Effect.Effect<Interface, never, Scope.Scope> =>
  Effect.gen(function* () {
    const logDir = options.logDir;
    const component = options.component;
    const retentionDays =
      options.retentionDays ??
      parsePositiveInt(
        process.env.STELLA_LOG_RETENTION_DAYS,
        DEFAULT_RETENTION_DAYS,
      );
    const maxFileBytes =
      options.maxFileBytes ??
      parsePositiveInt(
        process.env.STELLA_LOG_MAX_FILE_BYTES,
        DEFAULT_MAX_FILE_BYTES,
      );
    const maxTotalBytes =
      options.maxTotalBytes ??
      parsePositiveInt(
        process.env.STELLA_LOG_MAX_TOTAL_BYTES,
        DEFAULT_MAX_TOTAL_BYTES,
      );

    // Serializes the whole write path (rollover + append) across fibers.
    const writeLock = yield* Semaphore.make(1);

    let currentStamp = "";
    let dirReady = false;
    const truncatedChannels = new Set<LogChannel>();

    // The scoped resource: per-channel O_APPEND descriptors for the current
    // day's files, opened lazily on first write, closed on rotation, and
    // closed by the layer's finalizer when the scope ends.
    const openFiles = yield* Effect.acquireRelease(
      Effect.sync(() => new Map<LogChannel, number>()),
      (files) =>
        Effect.sync(() => {
          for (const fd of files.values()) {
            try {
              closeSync(fd);
            } catch {
              // Best-effort close on scope end.
            }
          }
          files.clear();
        }),
    );

    const closeAllFiles = (): void => {
      for (const fd of openFiles.values()) {
        try {
          closeSync(fd);
        } catch {
          // Best-effort close before rotation.
        }
      }
      openFiles.clear();
    };

    const ensureDir = (): boolean => {
      if (dirReady) return true;
      try {
        mkdirSync(logDir, { recursive: true, mode: 0o700 });
        if (process.platform !== "win32") chmodSync(logDir, 0o700);
        dirReady = true;
      } catch {
        // If we can't create the log dir, diagnostics silently no-op rather
        // than break the app.
        dirReady = false;
      }
      return dirReady;
    };

    const sweepRetention = (now: Date): void => {
      let remaining: Array<{ filePath: string; size: number; mtimeMs: number }>;
      try {
        const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
        remaining = [];
        for (const name of readdirSync(logDir)) {
          if (!LOG_FILE_PATTERN.test(name)) continue;
          const filePath = path.join(logDir, name);
          try {
            const stat = statSync(filePath);
            // Age-based retention first.
            if (stat.mtimeMs < cutoff) {
              unlinkSync(filePath);
              continue;
            }
            remaining.push({
              filePath,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
            });
          } catch {
            // Skip files we can't stat/unlink.
          }
        }
      } catch {
        // Directory may not exist yet; nothing to sweep.
        return;
      }

      // Total-size budget: delete oldest files first until under budget.
      // The active (newest) file is preserved so we never delete what we're
      // about to append to.
      let total = remaining.reduce((sum, entry) => sum + entry.size, 0);
      if (total <= maxTotalBytes) return;
      remaining.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (let i = 0; i < remaining.length - 1 && total > maxTotalBytes; i++) {
        const entry = remaining[i];
        if (!entry) continue;
        try {
          unlinkSync(entry.filePath);
          total -= entry.size;
        } catch {
          // Skip files we can't unlink.
        }
      }
    };

    const rollIfNeeded = (now: Date): void => {
      const stamp = dateStamp(now);
      if (stamp === currentStamp) return;
      currentStamp = stamp;
      truncatedChannels.clear();
      // Rotation: close the previous day's descriptors BEFORE the retention
      // sweep so the sweep never unlinks a file we still hold open, and the
      // next append opens the new day's file fresh. No lines can be lost in
      // between — the whole rollover runs inside the serialized write path.
      closeAllFiles();
      sweepRetention(now);
    };

    const filePathFor = (channel: LogChannel): string =>
      path.join(logDir, `${channel}-${currentStamp}.txt`);

    /** Size of the current file, or null when it does not exist / can't be statted. */
    const currentFileSize = (filePath: string): number | null => {
      try {
        return statSync(filePath).size;
      } catch {
        return null;
      }
    };

    const appendLine = (
      channel: LogChannel,
      filePath: string,
      text: string,
    ): void => {
      let fd = openFiles.get(channel);
      if (fd === undefined) {
        try {
          fd = openSync(filePath, "a", 0o600);
          if (process.platform !== "win32") {
            try {
              fchmodSync(fd, 0o600);
            } catch {
              closeSync(fd);
              return;
            }
          }
        } catch {
          // Best-effort diagnostics; retried on the next write.
          return;
        }
        openFiles.set(channel, fd);
      }
      try {
        writeSync(fd, text);
      } catch {
        // Best-effort diagnostics; never throw from a logging call.
      }
    };

    const format = (
      now: Date,
      level: LogLevel,
      event: string,
      fields?: LogFields,
    ): string => {
      const parts = [
        now.toISOString(),
        `[${level}]`,
        `[${component}]`,
        `event=${formatValue(event)}`,
      ];
      if (fields) {
        for (const [key, value] of flattenFields(fields)) {
          if (value === undefined) continue;
          parts.push(`${key}=${formatValue(value)}`);
        }
      }
      return `${parts.join(" ")}\n`;
    };

    const writeUnsafe = (
      channel: LogChannel,
      level: LogLevel,
      event: string,
      fields?: LogFields,
    ): void => {
      if (!ensureDir()) return;
      const now = new Date();
      rollIfNeeded(now);
      const filePath = filePathFor(channel);

      if (truncatedChannels.has(channel)) return;
      const size = currentFileSize(filePath);
      if (size === null && openFiles.has(channel)) {
        // The current file vanished underneath us (external cleanup): drop
        // the stale descriptor so the append below recreates the file,
        // exactly as the per-write append used to.
        const fd = openFiles.get(channel);
        openFiles.delete(channel);
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {
            // ignore
          }
        }
      }
      if (size !== null && size >= maxFileBytes) {
        truncatedChannels.add(channel);
        appendLine(
          channel,
          filePath,
          `${now.toISOString()} [warn] [${component}] log.truncated reason=size-cap\n`,
        );
        return;
      }

      appendLine(channel, filePath, format(now, level, event, fields));
    };

    const write: Interface["write"] = (channel, level, event, fields) =>
      writeLock.withPermit(
        Effect.sync(() => writeUnsafe(channel, level, event, fields)),
      );

    const crash: Interface["crash"] = (event, error, fields) =>
      Effect.suspend(() => {
        const err = error instanceof Error ? error : new Error(String(error));
        const stack = err.stack;
        return write("error", "fatal", event, {
          ...fields,
          errorName: err.name,
          errorMessage: err.message,
          ...(stack ? { stack } : {}),
        });
      });

    return {
      write,
      process: (event, fields) => write("process", "info", event, fields),
      warn: (event, fields) => write("process", "warn", event, fields),
      error: (event, fields) => write("error", "error", event, fields),
      crash,
    };
  });

// `make` acquires into the ambient scope; `Layer.effect` runs it in the
// layer's own scope (house idiom: acquireRelease inside Layer.effect, no
// Layer.scoped), so closing the layer closes the open descriptors.
export const layer = (
  options: FileLoggerOptions,
): Layer.Layer<ObservabilityLogger> =>
  Layer.effect(ObservabilityLogger, make(options));
