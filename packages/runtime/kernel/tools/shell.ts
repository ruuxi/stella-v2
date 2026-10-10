/**
 * Shell tools: platform shell plus `Bash` / `write_stdin` handlers.
 *
 * Effect-native concurrency spine (M5 kernel/tools pass), behind the exact
 * pre-Effect exported names/signatures/strings:
 *
 * - Every spawned shell is a scoped resource. `runShell`'s child is acquired
 *   via `Effect.acquireRelease` whose release runs the TERM→1s→KILL ladder
 *   when the process is still alive at scope close (the timeout path);
 *   managed session shells register a `Deferred` exit latch completed by
 *   their close/error events, which the kill ladder, `waitForShellExit`, and
 *   the joined shutdown all await instead of polling.
 * - The kill ladder's 1s TERM→KILL escalation is a forked fiber racing the
 *   child's exit (replacing the unref'd `setTimeout`).
 * - `waitForShellActivity` and the exec/write_stdin settle windows are scoped
 *   effects: the activity waiter is an `acquireRelease` resource and the
 *   caller's `AbortSignal` crosses in through the agent loop's
 *   `acquireAbortLatch` bridge (cooperative cancel; identical "Aborted"
 *   rejection reasons).
 * - Run-owned shell classification is a scope finalizer: the exec window that
 *   STARTED a shell kills it when the window fails (abort) before the session
 *   id ever reached the model; session shells whose id was delivered stay
 *   conversation-scoped and die only at `shutdownManagedShells`.
 * - `shutdownManagedShells` is the joined, bounded teardown: start every
 *   ladder, then await every exit latch in parallel under a single 3s bound.
 *
 * The implementation lives in shell/: shims.ts (the PATH shims), launch.ts
 * (shell resolution, environment, spawn diagnostics), process.ts (spawning,
 * kill ladders, `runShell`), sessions.ts (managed sessions) and handlers.ts
 * (the model-facing tools). This module is their public surface.
 */

export {
  BACKGROUND_EXEC_SETTLE_MS,
  DEFAULT_EMPTY_POLL_YIELD_MS,
  DEFAULT_EXEC_OUTPUT_TOKENS,
  DEFAULT_EXEC_YIELD_MS,
  DEFAULT_WRITE_STDIN_YIELD_MS,
  EXEC_UPDATE_MAX_BYTES,
  approxTokenCount,
  extractOfficePreviewRef,
  handleBash,
  handleExecCommand,
  handleKillShell,
  handleShellStatus,
  handleWriteStdin,
  resolveExecOutputTokens,
} from "./shell/handlers.js";
export {
  buildAgentShellEnvironment,
  buildShellCommand,
  resolveDefaultShell,
  resolveShellLaunch,
  resolveShellNodeBinary,
  resolveToolProcessIdentity,
  type ResolvedShellLaunch,
  type ShellDetectionOptions,
  type ShellLaunchOptions,
} from "./shell/launch.js";
export { runShell } from "./shell/process.js";
export {
  COMPLETED_SHELL_TTL_MS,
  MAX_RETAINED_COMPLETED_SHELLS,
  PRUNED_SHELL_RECEIPT_TTL_MS,
  cleanupShellSessions,
  createShellState,
  listRunningShellSessionsOwnedBy,
  readShellExitSnapshot,
  setShellOwner,
  shutdownManagedShells,
  startShell,
  waitForShellExit,
  watchShellExit,
  type ManagedShellRecord,
  type ShellExitSnapshot,
  type ShellSessionAccess,
  type ShellSessionOwner,
  type ShellState,
} from "./shell/sessions.js";
