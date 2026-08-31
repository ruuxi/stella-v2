import { Context, Effect, Layer, ManagedRuntime, Scope } from "effect";
import { resolveLogPaths } from "./log-paths.js";
import {
  ObservabilityLogger,
  layer as observabilityLoggerLayer,
  type FileLoggerOptions,
  type Interface as ObservabilityLoggerInterface,
  type LogFields,
} from "./logger.js";

/**
 * Local debug logger shared by every Stella
 * process (Electron main and the Bun runtime worker).
 *
 * Goals:
 *   - Capture errors/crashes and process lifecycle (workers + native
 *     helpers starting / being cleaned up) to plain `.txt` files.
 *   - Daily rotation with automatic retention cleanup.
 *   - Preserve the complete diagnostic context supplied by call sites,
 *     including nested values, paths, URLs, and error stacks.
 *
 * This file is the plain synchronous facade over the Effect-native
 * `ObservabilityLogger` service in `logger.ts` — same exported names,
 * signatures, and behavior as the pre-Effect implementation; Effect types
 * never cross this boundary. Each `FileLogger` builds the scoped logger
 * resource onto its own never-closed scope (process lifetime, exactly the
 * old semantics) and runs every write synchronously on the one
 * module-level ManagedRuntime, so a line still lands on disk even if the
 * process is mid-crash — which is exactly when these logs matter most.
 * Do NOT route hot-path / per-token / per-frame logging through here.
 */

export type {
  LogChannel,
  LogLevel,
  LogFields,
  FileLoggerOptions,
} from "./logger.js";

const observabilityRuntime = ManagedRuntime.make(Layer.empty);

/**
 * Build the scoped ObservabilityLogger resource. The scope is intentionally
 * never closed: the logger lives for the whole process (the pre-Effect
 * logger had no dispose either), and its descriptors are closed/reopened by
 * the daily rotation inside the write effect.
 */
const buildLogger = (
  options: FileLoggerOptions,
): ObservabilityLoggerInterface =>
  observabilityRuntime.runSync(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        observabilityLoggerLayer(options),
        scope,
      );
      return Context.get(context, ObservabilityLogger);
    }),
  );

export class FileLogger {
  private readonly logger: ObservabilityLoggerInterface;

  constructor(options: FileLoggerOptions) {
    this.logger = buildLogger(options);
  }

  /** Lifecycle / process event (worker + native helper start/stop/cleanup). */
  process(event: string, fields?: LogFields): void {
    this.run(this.logger.process(event, fields));
  }

  /** Non-fatal warning routed to the process channel. */
  warn(event: string, fields?: LogFields): void {
    this.run(this.logger.warn(event, fields));
  }

  /** Recoverable error. */
  error(event: string, fields?: LogFields): void {
    this.run(this.logger.error(event, fields));
  }

  /** Crash / fatal error with its stack trace. */
  crash(event: string, error: unknown, fields?: LogFields): void {
    this.run(this.logger.crash(event, error, fields));
  }

  private run(effect: Effect.Effect<void>): void {
    try {
      observabilityRuntime.runSync(effect);
    } catch {
      // Best-effort diagnostics; never throw from a logging call.
    }
  }
}

let sharedLogger: FileLogger | null = null;

/**
 * Initialize (or return the existing) per-process diagnostic logger.
 * Idempotent: a process should call this once at startup; later callers
 * reuse the same instance.
 */
export const initFileLogger = (
  stellaAppDir: string,
  component: string,
  options?: { retentionDays?: number; runtimeStateDir?: string },
): FileLogger => {
  if (sharedLogger) return sharedLogger;
  const { logDir } = resolveLogPaths(stellaAppDir, {
    ...(options?.runtimeStateDir
      ? { runtimeStateDir: options.runtimeStateDir }
      : {}),
  });
  sharedLogger = new FileLogger({
    logDir,
    component,
    ...(options?.retentionDays != null
      ? { retentionDays: options.retentionDays }
      : {}),
  });
  return sharedLogger;
};

/**
 * Get the process-wide logger if it has been initialized. Returns null
 * before `initFileLogger` runs so call sites can no-op safely.
 */
export const getFileLogger = (): FileLogger | null => sharedLogger;

/**
 * Install global crash handlers that route uncaught exceptions and
 * unhandled rejections to the error channel before the runtime acts on them.
 *
 * For uncaught exceptions we use `uncaughtExceptionMonitor`, which observes
 * the error and writes a durable on-disk record WITHOUT suppressing the
 * runtime's default fatal behavior (the process still crashes/exits as
 * Node/Bun/Electron would without this listener). A plain `uncaughtException`
 * listener would silently swallow the crash and leave the process running in
 * an undefined state.
 *
 * For unhandled rejections we register an `unhandledRejection` listener, which
 * DOES swallow the rejection (the process keeps running with only a log line)
 * rather than triggering the default surfacing. This is deliberate: the
 * detached worker relies on it to stay alive across benign unhandled
 * rejections. Callers that want strict fatal semantics here should revisit
 * this decision.
 */
export const installGlobalErrorLogging = (logger: FileLogger): void => {
  process.on("uncaughtExceptionMonitor", (error) => {
    logger.crash("process.uncaughtException", error);
  });
  process.on("unhandledRejection", (reason) => {
    logger.crash("process.unhandledRejection", reason);
  });
};
