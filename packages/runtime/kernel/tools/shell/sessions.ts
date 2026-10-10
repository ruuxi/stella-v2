/**
 * Managed shell sessions: the worker-wide session map, each record's output
 * cursors and exit latch, owner-scoped access, the per-session interaction
 * queue, and the joined shutdown.
 */

import { Deferred, Effect } from "effect";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type {
  ShellRecord,
  ToolContext,
  ToolProcessIdentity,
} from "../types.js";
import {
  HeadTailOutputBuffer,
  RAW_SHELL_OUTPUT_MAX_BYTES,
} from "../head-tail-output-buffer.js";
import { runToolEffect } from "../effect-runtime.js";
import { acquireAbortLatch } from "../../agent-core/abort-bridge.js";
import { watchChildStdio } from "../../shared/child-stdio.js";
import { sanitizeToolVisibleText } from "../safety.js";
import {
  buildShellEnv,
  describeShellSpawnFailure,
  maybeSweepDeferredDeletes,
  resolveStateShellLaunch,
  type ShellLaunchOptions,
} from "./launch.js";
import {
  PTY_OUTPUT_MAX_SETTLE_MS,
  PTY_OUTPUT_SETTLE_MS,
  spawnPtyShellProcess,
  spawnShellProcess,
  terminatePtyShellProcess,
  terminateShellProcess,
  type SpawnedPtyShell,
  type SpawnedShell,
} from "./process.js";
import {
  ensureNodeShim,
  ensureWindowsCliShims,
  type ShellStateOptions,
} from "./shims.js";

export type ShellState = {
  shells: Map<string, ManagedShellRecord>;
  /** One-shot foreground commands still running (`runShell`). */
  foregroundShells: Set<SpawnedShell>;
  /** Changes whenever the runtime worker reconstructs its in-memory state. */
  workerGeneration: string;
  /** Compact receipts retained after completed shell records are pruned. */
  prunedSessions: Map<string, PrunedShellSession>;
  secretStateRoot: string;
  stellaBrowserBinPath?: string;
  stellaOfficeBinPath?: string;
  stellaComputerCliPath?: string;
  stellaMediaCliPath?: string;
  stellaXApiCliPath?: string;
  nodeShimDir?: string;
  windowsCliShimDir?: string;
  getStellaSiteAuth?: () => { baseUrl: string; authToken: string } | null;
  /** The backend origin and auth token, for `stella-media`. */
  getCloudBackendAuth?: () => { baseUrl: string; authToken: string } | null;
  /**
   * Per-root CLI bridge UDS path (worker-side). Forwarded into the PTY
   * env as `STELLA_CLI_BRIDGE_SOCK` so sidecar CLIs (e.g. `stella-computer`)
   * can call back into the host for approvals and daemon spawns.
   */
  cliBridgeSocketPath?: string;
  lastDeferredDeleteSweepAt: number;
};

/**
 * Which thread started a shell session. Sessions outlive the run that
 * created them and live in one worker-wide map, so the record has to carry
 * its own provenance — that's what lets a background command's exit be
 * delivered back to the agent that started it.
 */
export type ShellSessionOwner = {
  conversationId: string;
  /** Durable agent thread id. Absent for non-subagent callers. */
  agentId?: string;
  agentType?: string;
  /** Origin-run provenance only; later runs in the same thread retain access. */
  runId?: string;
  rootRunId?: string;
};

/** Authorization key for accessing conversation-scoped shell state. */
export type ShellSessionAccess = {
  conversationId: string;
  agentId?: string;
};

/** What a caller learns when a background session finally exits. */
export type ShellExitSnapshot = {
  sessionId: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  startedAt: number;
  completedAt: number;
  /** Captured output, raw-capped with equal head and tail retention. */
  output: string;
  owner?: ShellSessionOwner;
};

export type ManagedShellRecord = ShellRecord & {
  unreadOutput: string;
  outputBuffer: HeadTailOutputBuffer;
  unreadOutputBuffer: HeadTailOutputBuffer;
  outputVersion: number;
  waiters: Set<() => void>;
  /**
   * Persistent exit listeners, distinct from `waiters`: those are one-shot
   * and fire on any activity, these fire once when the process is gone.
   */
  exitWatchers: Set<() => void>;
  child?: SpawnedShell;
  pty?: SpawnedPtyShell;
  stdinOpen: boolean;
  owner?: ShellSessionOwner;
  /**
   * Completed exactly once, when the child's `close`/`error` event fires
   * (pre-completed for records that never spawned). The kill ladder,
   * `waitForShellExit`, and the joined shutdown await this instead of
   * polling `running`.
   */
  exitLatch: Deferred.Deferred<void>;
  /** Total UTF-8 bytes observed since process start. */
  outputCursorBytes: number;
  /** Cursor at which the next interaction-result drain begins. */
  unreadCursorStart: number;
  /** Monotonic receipt sequence shared by stream updates and final drains. */
  chunkSequence: number;
  /** Monotonic exec/write interaction number for this shell. */
  interactionSequence: number;
  activeInteractionSequence: number | null;
  activeInteractionReceipt?: ShellInteractionReceipt;
  pendingInteractions: number;
  interactionTail: Promise<void>;
  acceptedWriteIds: Map<string, { fingerprint: string; acceptedAt: number }>;
};

type PrunedShellSession = {
  id: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  completedAt: number;
  prunedAt: number;
  owner?: ShellSessionOwner;
};

export const MAX_RETAINED_COMPLETED_SHELLS = 64;
const MAX_PRUNED_SESSION_RECEIPTS = 16;
export const COMPLETED_SHELL_TTL_MS = 30 * 60_000;
export const PRUNED_SHELL_RECEIPT_TTL_MS = 10 * 60_000;
const MAX_ACCEPTED_WRITE_IDS = 256;
const ACCEPTED_WRITE_ID_TTL_MS = 10 * 60_000;

const retainPrunedSessionReceipt = (
  state: ShellState,
  record: ManagedShellRecord,
  prunedAt: number,
): void => {
  state.prunedSessions.set(record.id, {
    id: record.id,
    command: record.command,
    cwd: record.cwd,
    exitCode: record.exitCode,
    completedAt: record.completedAt ?? Date.now(),
    prunedAt,
    ...(record.owner ? { owner: record.owner } : {}),
  });
  while (state.prunedSessions.size > MAX_PRUNED_SESSION_RECEIPTS) {
    const oldestId = state.prunedSessions.keys().next().value as
      | string
      | undefined;
    if (!oldestId) break;
    state.prunedSessions.delete(oldestId);
  }
};

/**
 * Keep the active-shell map bounded. Running shells and records with queued
 * interactions are never candidates; the release path retries pruning after
 * the interaction completes.
 */
export const pruneCompletedShellSessions = (
  state: ShellState,
  now = Date.now(),
): void => {
  for (const [id, receipt] of state.prunedSessions) {
    if (now - receipt.prunedAt >= PRUNED_SHELL_RECEIPT_TTL_MS) {
      state.prunedSessions.delete(id);
    }
  }

  const completed = [...state.shells.values()]
    .filter((record) => !record.running)
    .sort(
      (left, right) =>
        (left.completedAt ?? left.startedAt) -
        (right.completedAt ?? right.startedAt),
    );
  let retainedCompleted = completed.length;

  for (const record of completed) {
    const completedAt = record.completedAt ?? record.startedAt;
    const expired = now - completedAt >= COMPLETED_SHELL_TTL_MS;
    if (!expired && retainedCompleted <= MAX_RETAINED_COMPLETED_SHELLS) break;
    if (record.pendingInteractions > 0) continue;

    retainPrunedSessionReceipt(state, record, now);
    state.shells.delete(record.id);
    retainedCompleted -= 1;
  }
};

/** Opportunistic TTL/count cleanup for hosts and focused harness checks. */
export const cleanupShellSessions = (
  state: ShellState,
  now = Date.now(),
): void => pruneCompletedShellSessions(state, now);

export function createShellState(
  secretStateRoot: string,
  options?: ShellStateOptions,
): ShellState {
  if (!secretStateRoot.trim()) {
    throw new Error("createShellState requires a secretStateRoot.");
  }

  const nodeShimDir =
    options?.enableShellShims === false
      ? undefined
      : ensureNodeShim(secretStateRoot, options);
  const windowsCliShimDir =
    options?.enableShellShims !== false && process.platform === "win32"
      ? ensureWindowsCliShims(secretStateRoot, options)
      : undefined;

  return {
    shells: new Map(),
    foregroundShells: new Set(),
    workerGeneration: crypto.randomUUID().slice(0, 8),
    prunedSessions: new Map(),
    secretStateRoot,
    stellaBrowserBinPath: options?.stellaBrowserBinPath,
    stellaOfficeBinPath: options?.stellaOfficeBinPath,
    stellaComputerCliPath: options?.stellaComputerCliPath,
    stellaMediaCliPath: options?.stellaMediaCliPath,
    stellaXApiCliPath: options?.stellaXApiCliPath,
    ...(nodeShimDir ? { nodeShimDir } : {}),
    getStellaSiteAuth: options?.getStellaSiteAuth,
    getCloudBackendAuth: options?.getCloudBackendAuth,
    ...(windowsCliShimDir ? { windowsCliShimDir } : {}),
    cliBridgeSocketPath: options?.cliBridgeSocketPath,
    lastDeferredDeleteSweepAt: 0,
  };
}

export type ShellOutputDelta = {
  text: string;
  cursorStart: number;
  cursorEnd: number;
};

export type DrainedOutput = {
  text: string;
  originalLength: number;
  rawOmittedBytes: number;
  presentationOmittedBytes: number;
  cursorStart: number;
  cursorEnd: number;
  receiptKind: "stream_delta" | "terminal" | "interaction_result";
};

export const drainUnreadOutput = (
  record: ManagedShellRecord,
): DrainedOutput => {
  const unread = record.unreadOutputBuffer.drain();
  const cursorStart = record.unreadCursorStart;
  const cursorEnd = record.outputCursorBytes;
  record.unreadCursorStart = cursorEnd;
  record.unreadOutput = "";
  return {
    text: unread.text,
    originalLength: unread.totalBytes,
    rawOmittedBytes: unread.omittedBytes,
    presentationOmittedBytes: 0,
    cursorStart,
    cursorEnd,
    receiptKind: "interaction_result",
  };
};

const refreshShellOutputText = (record: ManagedShellRecord): void => {
  record.output = record.outputBuffer.snapshot().text;
  record.unreadOutput = record.unreadOutputBuffer.snapshot().text;
};

const appendShellOutput = (
  record: ManagedShellRecord,
  text: string,
): { text: string; cursorStart: number; cursorEnd: number } | undefined => {
  if (!text) return undefined;
  const cursorStart = record.outputCursorBytes;
  const byteLength = Buffer.byteLength(text, "utf8");
  const cursorEnd = cursorStart + byteLength;
  record.outputBuffer.pushText(text);
  record.unreadOutputBuffer.pushText(text);
  record.outputCursorBytes = cursorEnd;
  refreshShellOutputText(record);
  return { text, cursorStart, cursorEnd };
};

export const notifyShellActivity = (record: ManagedShellRecord) => {
  record.outputVersion += 1;
  const waiters = [...record.waiters];
  record.waiters.clear();
  for (const waiter of waiters) {
    waiter();
  }
};

const notifyShellExit = (record: ManagedShellRecord) => {
  const watchers = [...record.exitWatchers];
  record.exitWatchers.clear();
  for (const watcher of watchers) {
    try {
      watcher();
    } catch {
      // A listener must never break the process teardown path.
    }
  }
};

export const readShellExitSnapshot = (
  state: ShellState,
  sessionId: string,
): ShellExitSnapshot | null => {
  cleanupShellSessions(state);
  const record = state.shells.get(sessionId);
  if (!record || record.running) return null;
  return {
    sessionId: record.id,
    command: record.command,
    cwd: record.cwd,
    exitCode: record.exitCode,
    startedAt: record.startedAt,
    completedAt: record.completedAt ?? Date.now(),
    output: sanitizeToolVisibleText(record.output),
    ...(record.owner ? { owner: record.owner } : {}),
  };
};

/**
 * Call `listener` once the session's process is gone, and return a
 * disposer. Sessions that already exited resolve on the next microtask so
 * callers never have to special-case the race between "still running when
 * I checked" and "exited before I subscribed".
 */
export const watchShellExit = (
  state: ShellState,
  sessionId: string,
  listener: () => void,
): (() => void) => {
  const record = state.shells.get(sessionId);
  if (!record) return () => {};
  if (!record.running) {
    let disposed = false;
    queueMicrotask(() => {
      if (!disposed) listener();
    });
    return () => {
      disposed = true;
    };
  }
  record.exitWatchers.add(listener);
  return () => {
    record.exitWatchers.delete(listener);
  };
};

/**
 * Every running session an agent thread owns, whichever of its runs started
 * them. Scoping a thread's background work by owner rather than by "what
 * the last run touched" is what keeps a job started three turns ago — and
 * not polled since — from being forgotten.
 */
export const listRunningShellSessionsOwnedBy = (
  state: ShellState,
  access: ShellSessionAccess,
): string[] => {
  const owned: string[] = [];
  for (const shell of state.shells.values()) {
    if (!shell.running || !shellOwnerMatchesAccess(shell.owner, access)) {
      continue;
    }
    owned.push(shell.id);
  }
  return owned;
};

/** Stamp the calling thread onto a freshly started session. */
export const setShellOwner = (
  record: Pick<ShellRecord, "id">,
  context?: ToolContext,
): void => {
  if (!context?.conversationId) return;
  (record as ManagedShellRecord).owner = {
    conversationId: context.conversationId,
    ...(context.agentId ? { agentId: context.agentId } : {}),
    ...(context.agentType ? { agentType: context.agentType } : {}),
    ...(context.runId ? { runId: context.runId } : {}),
    ...(context.rootRunId ? { rootRunId: context.rootRunId } : {}),
  };
};

/**
 * Model-addressable shell sessions are private to the thread that created
 * them. Run ids are deliberately not part of the access key: a background
 * process commonly outlives one turn/run and must remain usable on the next.
 * Calls without a ToolContext can only address likewise-unowned sessions,
 * preserving direct harness/internal use without opening owned sessions.
 */
const shellOwnerMatchesAccess = (
  owner: ShellSessionOwner | undefined,
  access: ShellSessionAccess | null,
): boolean => {
  if (!owner) return access === null;
  return (
    access !== null &&
    owner.conversationId === access.conversationId &&
    owner.agentId === access.agentId
  );
};

export const shellOwnerMatchesContext = (
  owner: ShellSessionOwner | undefined,
  context?: ToolContext,
): boolean =>
  shellOwnerMatchesAccess(
    owner,
    context?.conversationId
      ? {
          conversationId: context.conversationId,
          ...(context.agentId ? { agentId: context.agentId } : {}),
        }
      : null,
  );

/**
 * Wait for new shell activity (or completion), bounded by `timeoutMs`, as a
 * scoped effect. The activity waiter is an `acquireRelease` resource (always
 * removed from `record.waiters` on success, timeout, and abort alike) and
 * the caller's signal crosses in through `acquireAbortLatch`; an abort fails
 * the effect with the legacy reason (`signal.reason ?? new Error("Aborted")`).
 */
export const waitForShellActivityEffect = (
  record: ManagedShellRecord,
  observedVersion: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Effect.Effect<void, unknown> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (!record.running || record.outputVersion !== observedVersion) {
        return;
      }
      const activity = yield* Deferred.make<void>();
      const finish = () => {
        Deferred.doneUnsafe(activity, Effect.void);
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => record.waiters.add(finish)),
        () => Effect.sync(() => record.waiters.delete(finish)),
      );
      // Close the check-then-subscribe race: output or exit can land between
      // the optimistic check above and waiter registration.
      if (!record.running || record.outputVersion !== observedVersion) {
        Deferred.doneUnsafe(activity, Effect.void);
      }
      const abortLatch = yield* acquireAbortLatch(signal);
      yield* Effect.raceFirst(
        Effect.raceFirst(Deferred.await(activity), Effect.sleep(timeoutMs)),
        Deferred.await(abortLatch).pipe(
          Effect.flatMap((reason) =>
            Effect.fail(reason ?? new Error("Aborted")),
          ),
        ),
      );
    }),
  );

export const waitForShellUntilDeadlineEffect = (
  record: ManagedShellRecord,
  deadlineAt: number,
  signal?: AbortSignal,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    while (record.running && Date.now() < deadlineAt) {
      const observedVersion = record.outputVersion;
      yield* waitForShellActivityEffect(
        record,
        observedVersion,
        Math.max(0, deadlineAt - Date.now()),
        signal,
      );
    }
  });

export type ShellInteractionLease = {
  sequence: number;
  release: () => void;
};

const waitForInteractionTurnEffect = (
  previous: Promise<void>,
  signal?: AbortSignal,
): Effect.Effect<void, unknown> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (signal?.aborted) {
        yield* Effect.fail(signal.reason ?? new Error("Aborted"));
      }
      const abortLatch = yield* acquireAbortLatch(signal);
      yield* Effect.raceFirst(
        Effect.promise(() => previous),
        Deferred.await(abortLatch).pipe(
          Effect.flatMap((reason) =>
            Effect.fail(reason ?? new Error("Aborted")),
          ),
        ),
      );
    }),
  );

/** Serialize write/poll/drain interactions for one session, not all shells. */
export const acquireShellInteraction = async (
  state: ShellState,
  record: ManagedShellRecord,
  signal?: AbortSignal,
): Promise<ShellInteractionLease> => {
  const previous = record.interactionTail;
  let releaseGate = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  record.pendingInteractions += 1;
  record.interactionTail = previous.catch(() => undefined).then(() => gate);

  try {
    await runToolEffect(waitForInteractionTurnEffect(previous, signal));
  } catch (error) {
    record.pendingInteractions -= 1;
    releaseGate();
    pruneCompletedShellSessions(state);
    throw error;
  }

  const sequence = record.interactionSequence + 1;
  record.interactionSequence = sequence;
  record.activeInteractionSequence = sequence;
  let released = false;
  return {
    sequence,
    release: () => {
      if (released) return;
      released = true;
      if (record.activeInteractionSequence === sequence) {
        record.activeInteractionSequence = null;
      }
      record.pendingInteractions -= 1;
      releaseGate();
      pruneCompletedShellSessions(state);
    },
  };
};

export const settleCompletedShellEffect = (
  record: ManagedShellRecord,
  signal?: AbortSignal,
  hardDeadlineAt = Number.POSITIVE_INFINITY,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const deadline = Math.min(Date.now() + 250, hardDeadlineAt);
    while (record.running && Date.now() < deadline) {
      const observedVersion = record.outputVersion;
      yield* waitForShellActivityEffect(
        record,
        observedVersion,
        Math.min(25, Math.max(1, deadline - Date.now())),
        signal,
      );
    }
  });

export const startShell = (
  state: ShellState,
  command: string,
  cwd: string,
  envOverrides?: Record<string, string>,
  onClose?: () => void,
  onActivity?: (record: ManagedShellRecord, delta?: ShellOutputDelta) => void,
  launchOptions: ShellLaunchOptions = {},
  processIdentity?: ToolProcessIdentity,
) => {
  maybeSweepDeferredDeletes(state);
  const id = crypto.randomUUID();
  const launch = resolveStateShellLaunch(command, state, launchOptions);

  const failedRecord = (message: string, exitCode: number) => {
    const safeLaunchError = sanitizeToolVisibleText(message);
    // Never spawned: the exit latch is born completed so joins are no-ops.
    const exitLatch = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(exitLatch, Effect.void);
    const record: ManagedShellRecord = {
      id,
      command,
      cwd,
      output: safeLaunchError,
      outputBuffer: new HeadTailOutputBuffer(RAW_SHELL_OUTPUT_MAX_BYTES),
      running: false,
      exitCode,
      startedAt: Date.now(),
      completedAt: Date.now(),
      unreadOutput: safeLaunchError,
      unreadOutputBuffer: new HeadTailOutputBuffer(RAW_SHELL_OUTPUT_MAX_BYTES),
      outputVersion: 1,
      waiters: new Set(),
      exitWatchers: new Set(),
      stdinOpen: false,
      exitLatch,
      kill: () => {},
      outputCursorBytes: Buffer.byteLength(safeLaunchError, "utf8"),
      unreadCursorStart: 0,
      chunkSequence: 0,
      interactionSequence: 0,
      activeInteractionSequence: null,
      pendingInteractions: 0,
      interactionTail: Promise.resolve(),
      acceptedWriteIds: new Map(),
    };
    record.outputBuffer.pushText(safeLaunchError);
    record.unreadOutputBuffer.pushText(safeLaunchError);
    state.shells.set(id, record);
    pruneCompletedShellSessions(state);
    return record;
  };

  if ("error" in launch) {
    return failedRecord(launch.error, 127);
  }

  const record: ManagedShellRecord = {
    id,
    command,
    cwd,
    output: "",
    outputBuffer: new HeadTailOutputBuffer(RAW_SHELL_OUTPUT_MAX_BYTES),
    running: true,
    exitCode: null,
    startedAt: Date.now(),
    completedAt: null,
    unreadOutput: "",
    unreadOutputBuffer: new HeadTailOutputBuffer(RAW_SHELL_OUTPUT_MAX_BYTES),
    outputVersion: 0,
    waiters: new Set(),
    exitWatchers: new Set(),
    stdinOpen: false,
    exitLatch: Deferred.makeUnsafe<void>(),
    kill: () => {},
    outputCursorBytes: 0,
    unreadCursorStart: 0,
    chunkSequence: 0,
    interactionSequence: 0,
    activeInteractionSequence: null,
    pendingInteractions: 0,
    interactionTail: Promise.resolve(),
    acceptedWriteIds: new Map(),
  };

  const append = (chunk: string, sanitizeImmediately: boolean) => {
    // Pipe output is sanitized chunk-by-chunk for compatibility. PTY escape
    // sequences can straddle native read boundaries, so retain those chunks
    // until the existing payload-level sanitizer sees the complete drain.
    const delta = appendShellOutput(
      record,
      sanitizeImmediately ? sanitizeToolVisibleText(chunk) : chunk,
    );
    if (!delta) return;
    notifyShellActivity(record);
    onActivity?.(record, delta);
  };

  const finish = (exitCode: number | null) => {
    if (!record.running) return;
    record.running = false;
    record.exitCode = exitCode;
    record.completedAt = Date.now();
    record.stdinOpen = false;
    Deferred.doneUnsafe(record.exitLatch, Effect.void);
    notifyShellActivity(record);
    notifyShellExit(record);
    onActivity?.(record);
    record.pty?.close();
    onClose?.();
    pruneCompletedShellSessions(state);
  };

  const shellEnv = buildShellEnv(
    envOverrides,
    state,
    launchOptions.tty === true,
  );
  if (launchOptions.tty) {
    let pendingExit: { exitCode: number | null; error?: Error } | undefined;
    let settleDeadlineAt = 0;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    const schedulePtyFinish = () => {
      if (!pendingExit || !record.running) return;
      if (settleTimer) clearTimeout(settleTimer);
      const remaining = Math.max(0, settleDeadlineAt - Date.now());
      settleTimer = setTimeout(
        () => {
          if (!pendingExit) return;
          const { exitCode, error } = pendingExit;
          pendingExit = undefined;
          if (error) {
            append(
              describeShellSpawnFailure(
                error,
                launch,
                cwd,
                launchOptions,
                "bun:terminal",
              ),
              true,
            );
          }
          finish(error ? (exitCode ?? 1) : exitCode);
        },
        Math.min(PTY_OUTPUT_SETTLE_MS, remaining),
      );
      settleTimer.unref?.();
    };

    try {
      const pty = spawnPtyShellProcess(
        launch.shell,
        launch.args,
        cwd,
        shellEnv,
        launch.windowsVerbatimArguments ?? false,
        {
          onData: (chunk) => {
            append(chunk, false);
            if (pendingExit) schedulePtyFinish();
          },
          onExit: (exitCode, _signalCode, error) => {
            pendingExit = { exitCode, ...(error ? { error } : {}) };
            settleDeadlineAt = Date.now() + PTY_OUTPUT_MAX_SETTLE_MS;
            schedulePtyFinish();
          },
          onTerminalExit: (terminalExitCode) => {
            record.stdinOpen = false;
            notifyShellActivity(record);
            if (pendingExit) {
              if (settleTimer) clearTimeout(settleTimer);
              settleDeadlineAt = Date.now();
              schedulePtyFinish();
            } else if (terminalExitCode !== 0 && record.running) {
              append("PTY stream closed unexpectedly.\n", true);
              if (record.pty) terminatePtyShellProcess(record.pty);
            }
          },
        },
        processIdentity,
      );
      record.pty = pty;
      record.stdinOpen = true;
      record.kill = () => terminatePtyShellProcess(pty);
    } catch (error) {
      return failedRecord(
        describeShellSpawnFailure(
          error instanceof Error ? error : new Error(String(error)),
          launch,
          cwd,
          launchOptions,
          "bun:terminal",
        ),
        1,
      );
    }
  } else {
    let child: SpawnedShell;
    try {
      child = spawnShellProcess(
        launch.shell,
        launch.args,
        cwd,
        shellEnv,
        launch.windowsVerbatimArguments,
        processIdentity,
      );
    } catch (error) {
      return failedRecord(
        describeShellSpawnFailure(
          error instanceof Error ? error : new Error(String(error)),
          launch,
          cwd,
          launchOptions,
        ),
        1,
      );
    }
    record.child = child;
    record.stdinOpen = Boolean(child.stdin);
    record.kill = () => terminateShellProcess(child);

    // stdout/stderr are decoded independently because their byte chunks can
    // end in the middle of a UTF-8 scalar. StringDecoder retains that suffix
    // for the next chunk instead of emitting U+FFFD into output and cursors.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const appendPipe = (decoder: StringDecoder, data: Buffer) =>
      append(decoder.write(data), true);
    child.stdout?.on("data", (data: Buffer) => appendPipe(stdoutDecoder, data));
    child.stderr?.on("data", (data: Buffer) => appendPipe(stderrDecoder, data));
    child.stdout?.on("end", () => append(stdoutDecoder.end(), true));
    child.stderr?.on("end", () => append(stderrDecoder.end(), true));
    child.stdin?.on("close", () => {
      record.stdinOpen = false;
      notifyShellActivity(record);
    });
    watchChildStdio(child, `shell ${record.id}`, (stream) => {
      if (stream === "stdin") record.stdinOpen = false;
    });
    child.on("error", (error) => {
      append(
        describeShellSpawnFailure(error, launch, cwd, launchOptions),
        true,
      );
      finish(record.exitCode ?? 1);
    });
    child.on("close", (code) => finish(code ?? null));
  }

  state.shells.set(id, record);
  return record;
};

/**
 * Await a managed shell's exit (close/error already reflected in
 * `record.running`), bounded by `timeoutMs`. Resolves either way — the
 * bound exists so a wedged process can never hang a caller; the kill
 * ladder's SIGKILL has already been dispatched by then.
 */
export const waitForShellExit = (
  record: ManagedShellRecord,
  timeoutMs: number,
): Promise<void> =>
  runToolEffect(
    Effect.gen(function* () {
      if (!record.running) {
        return;
      }
      yield* Effect.raceFirst(
        Deferred.await(record.exitLatch),
        Effect.sleep(timeoutMs),
      );
    }),
  );

/**
 * Joined, bounded teardown of every managed shell and every foreground
 * command still running. `kill()` alone only
 * *starts* the TERM→1s→KILL ladders — a worker that exits right after would
 * strand TERM-ignoring children as orphans. This joins every running
 * shell's exit latch and its whole-tree termination (process group and
 * escaped descendants, which can outlive the shell itself) in parallel
 * under a single 3s bound (comfortably past the ladder); anything still
 * alive at the bound is logged and left to the OS, as the ladder's KILL
 * already fired.
 * Conversation-scoped shells are deliberately worker-lifetime resources:
 * they die here, never earlier.
 */
export const shutdownManagedShells = (state: ShellState): Promise<void> =>
  runToolEffect(
    Effect.gen(function* () {
      const pending: ManagedShellRecord[] = [];
      for (const record of state.shells.values()) {
        if (record.running) {
          pending.push(record);
        }
      }
      const terminations: Promise<void>[] = [];
      for (const record of pending) {
        const termination = record.kill();
        if (termination) terminations.push(termination);
      }
      for (const child of state.foregroundShells) {
        terminations.push(terminateShellProcess(child));
      }
      if (pending.length === 0 && terminations.length === 0) {
        return;
      }
      const joined = yield* Effect.raceFirst(
        Effect.forEach(pending, (record) => Deferred.await(record.exitLatch), {
          concurrency: "unbounded",
          discard: true,
        }).pipe(
          Effect.andThen(
            Effect.promise(() => Promise.allSettled(terminations)),
          ),
          Effect.as("joined" as const),
        ),
        Effect.sleep(3_000).pipe(Effect.as("timeout" as const)),
      );
      if (joined === "timeout") {
        // eslint-disable-next-line no-console
        console.warn(
          "[tool-host] shell teardown exceeded the shutdown bound; SIGKILL was already dispatched",
        );
      }
    }),
  );

export type ShellInteractionOperation =
  | "exec"
  | "write"
  | "poll"
  | "terminate"
  | "close_stdin"
  | "resize";

export type ShellInteractionReceipt = {
  operation: ShellInteractionOperation;
  write_id?: string;
  write_deduplicated?: boolean;
  terminal_size?: { cols: number; rows: number };
};

export const writeToShellStdin = async (
  record: ManagedShellRecord,
  chars: string,
): Promise<void> => {
  if (!chars) return;
  if (record.pty) {
    if (!record.stdinOpen) {
      throw new Error(`stdin is not available for session ${record.id}.`);
    }
    await record.pty.write(chars);
    return;
  }
  const stdin = record.child?.stdin;
  if (!stdin || !record.stdinOpen || stdin.destroyed || !stdin.writable) {
    throw new Error(`stdin is not available for session ${record.id}.`);
  }
  await new Promise<void>((resolve, reject) => {
    stdin.write(chars, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
};

export const closeShellStdin = async (
  record: ManagedShellRecord,
): Promise<void> => {
  if (record.pty) {
    throw new Error(
      `close_stdin is not independently supported for PTY session ${record.id}; use terminate or send the program's EOF/control sequence.`,
    );
  }
  if (!record.running || !record.stdinOpen) return;
  const stdin = record.child?.stdin;
  if (!stdin || stdin.destroyed) {
    record.stdinOpen = false;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => stdin.removeListener("error", onError);
    stdin.once("error", onError);
    stdin.end(() => {
      cleanup();
      resolve();
    });
  });
  record.stdinOpen = false;
  notifyShellActivity(record);
};

export const resizeShellPty = (
  record: ManagedShellRecord,
  cols: number,
  rows: number,
): void => {
  if (!record.running || !record.pty || record.pty.terminal.closed) {
    throw new Error(`resize requires a running PTY session: ${record.id}.`);
  }
  record.pty.resize(cols, rows);
  // Bun updates the PTY window size but does not consistently deliver
  // SIGWINCH to the foreground process group on Unix (notably on macOS).
  // Notify the detached group explicitly so interactive children observe the
  // new dimensions just as they do in a native terminal emulator.
  if (process.platform !== "win32") {
    const pid = record.pty.process.pid;
    if (pid) {
      try {
        process.kill(-pid, "SIGWINCH");
      } catch {
        process.kill(pid, "SIGWINCH");
      }
    }
  }
};

export const writeFingerprint = (chars: string): string =>
  createHash("sha256").update(chars, "utf8").digest("hex");

export const pruneAcceptedWriteIds = (
  record: ManagedShellRecord,
  now = Date.now(),
): void => {
  for (const [id, receipt] of record.acceptedWriteIds) {
    if (now - receipt.acceptedAt >= ACCEPTED_WRITE_ID_TTL_MS) {
      record.acceptedWriteIds.delete(id);
    }
  }
  while (record.acceptedWriteIds.size > MAX_ACCEPTED_WRITE_IDS) {
    const oldestId = record.acceptedWriteIds.keys().next().value as
      | string
      | undefined;
    if (!oldestId) break;
    record.acceptedWriteIds.delete(oldestId);
  }
};

export const recordAcceptedWriteId = (
  record: ManagedShellRecord,
  writeId: string,
  fingerprint: string,
): void => {
  record.acceptedWriteIds.delete(writeId);
  record.acceptedWriteIds.set(writeId, {
    fingerprint,
    acceptedAt: Date.now(),
  });
  pruneAcceptedWriteIds(record);
};
