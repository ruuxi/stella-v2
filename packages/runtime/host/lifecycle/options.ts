import type { Socket } from "node:net";
import type { RuntimePaths } from "../../worker/runtime-paths.js";

export type LifecycleConnection = {
  socket: Socket;
  pid: number;
  paths: RuntimePaths;
  /** True if we spawned the worker; false if we attached to an existing one. */
  spawned: boolean;
};

export type LifecycleStartOptions = {
  stellaAppDir: string;
  workerEntryPath: string;
  bunBinaryPath?: string;
  idleShutdownMs?: number;
  /**
   * Extra env merged onto the child process. The host adapter passes
   * NODE_ENV, custom debug flags, etc.
   */
  env?: NodeJS.ProcessEnv;
  expectedProtocolVersion?: string;
  hostExecutablePath?: string;
};

/**
 * Retry/timeout policy for the attach pipeline. Production always runs the
 * defaults below (the facade does not expose overrides); the Effect-level
 * tests shrink the budgets so timeout/interruption paths run in
 * milliseconds instead of tens of seconds.
 */
export type LifecycleBudgets = {
  /** Spacing of the spawn-readiness poll attempts. */
  startPollIntervalMs: number;
  /** Total budget for a freshly spawned worker to answer the probe. */
  startTimeoutMs: number;
  /** Per-attempt socket connect + probe budget. */
  socketConnectTimeoutMs: number;
  /** Total budget for the host lockfile acquire loop. */
  hostLockTimeoutMs: number;
  /** Readiness budget for an alive-pid-but-unreachable-socket worker. */
  staleRetryTimeoutMs: number;
};

// The Bun worker cold-starts by loading the bundled kernel entry, which on
// low-end Windows machines has been observed at ~9.5s (worker startupMs≈9466).
// A 10s budget left effectively no margin, so a slightly slower boot timed out
// and triggered a spawn-retry cascade (worker not "ready" until ~40s, plus a
// failed startup source-history record that waits on it). 30s gives ample
// headroom on slow machines while still surfacing a genuinely stuck worker.
export const defaultLifecycleBudgets: LifecycleBudgets = {
  startPollIntervalMs: 50,
  startTimeoutMs: 30_000,
  socketConnectTimeoutMs: 1_000,
  hostLockTimeoutMs: 75_000,
  staleRetryTimeoutMs: 2_000,
};
