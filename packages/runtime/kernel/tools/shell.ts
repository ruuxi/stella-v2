/**
 * Shell tools: platform shell plus `exec_command` / `write_stdin` handlers.
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
 */

import { Deferred, Effect, Exit } from "effect";
import { spawn } from "child_process";
import path from "path";
import os from "os";
import { StringDecoder } from "node:string_decoder";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "fs";
import { readdir, stat } from "fs/promises";
import {
  fileChange,
  isNoiseProducedPath,
  MAX_PRODUCED_FILES_PER_COMMAND,
  type FileChangeRecord,
  type ProducedFileRecord,
} from "@stella/contracts/file-changes";
import type {
  ProducedFilesOmission,
  ToolContext,
  ToolProcessIdentity,
  ToolResult,
  ShellRecord,
  ToolUpdateCallback,
} from "./types.js";
import { truncate } from "./utils.js";
import { getTerminalRecoveryHint } from "./terminal-hints.js";
import {
  HeadTailOutputBuffer,
  RAW_SHELL_OUTPUT_MAX_BYTES,
  splitUtf8TextByBytes,
} from "./head-tail-output-buffer.js";
import { runToolEffect, toolsRuntime } from "./effect-runtime.js";
import { acquireAbortLatch } from "../agent-core/abort-bridge.js";
import { isDangerousCommand } from "./command-safety.js";
import { getStellaComputerSessionId } from "./stella-computer-session.js";
import { inferShellMentionedPaths } from "./path-inference.js";
import { isKnownSafeCommand } from "./safe-commands.js";
import { sanitizeToolVisibleText } from "./safety.js";
import type { OfficePreviewRef } from "@stella/contracts/office-preview";
import { purgeExpiredDeferredDeletes } from "./deferred-delete.js";
import { resolveToolFallbackCwd } from "./cwd.js";
import { isolateToolProcessLaunch } from "./process-isolation.js";

type PrunedProducedFilesRecovery = {
  prunedAt: number;
  owner?: ShellSessionOwner;
  claimed: boolean;
  source: ProducedFilesSource;
};

export type ShellState = {
  shells: Map<string, ManagedShellRecord>;
  /** Changes whenever the runtime worker reconstructs its in-memory state. */
  workerGeneration: string;
  /** Compact receipts retained after completed shell records are pruned. */
  prunedSessions: Map<string, PrunedShellSession>;
  /** Produced-file recovery detached from pruned shell output records. */
  prunedProducedFiles: Map<string, PrunedProducedFilesRecovery>;
  secretStateRoot: string;
  stellaBrowserBinPath?: string;
  stellaOfficeBinPath?: string;
  stellaComputerCliPath?: string;
  stellaMediaCliPath?: string;
  stellaXApiCliPath?: string;
  nodeShimDir?: string;
  windowsCliShimDir?: string;
  getStellaSiteAuth?: () => { baseUrl: string; authToken: string } | null;
  /**
   * Per-root CLI bridge UDS path (worker-side). Forwarded into the PTY
   * env as `STELLA_CLI_BRIDGE_SOCK` so sidecar CLIs (e.g. `stella-computer`)
   * can call back into the host for approvals and daemon spawns.
   */
  cliBridgeSocketPath?: string;
  lastDeferredDeleteSweepAt: number;
};

type ShellStateOptions = {
  enableShellShims?: boolean;
  stellaBrowserBinPath?: string;
  stellaOfficeBinPath?: string;
  stellaComputerCliPath?: string;
  stellaMediaCliPath?: string;
  stellaXApiCliPath?: string;
  getStellaSiteAuth?: () => { baseUrl: string; authToken: string } | null;
  cliBridgeSocketPath?: string;
};

const WINDOWS_CLI_SHIMS = [
  {
    command: "stella-office",
    optionKey: "stellaOfficeBinPath",
    envVar: "STELLA_OFFICE_BIN",
  },
  {
    command: "stella-computer",
    optionKey: "stellaComputerCliPath",
    envVar: "STELLA_COMPUTER_CLI",
  },
  {
    command: "stella-media",
    optionKey: "stellaMediaCliPath",
    envVar: "STELLA_MEDIA_CLI",
  },
  {
    command: "stella-x-api",
    optionKey: "stellaXApiCliPath",
    envVar: "STELLA_X_API_CLI",
  },
] as const;

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
  startSnapshot?: FileSnapshot | null;
  externalCandidateSnapshots?: ExternalCandidateSnapshot[];
  producedFilesReported?: boolean;
  /** One bounded producer generation, retained as ready until atomically claimed. */
  producedFilesCollection?: ProducedFilesCollectionState;
  /** Cap resolved from the host's ToolContext when the shell was started. */
  producedFileLimit: number;
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

type FileSnapshotEntry = {
  size: number;
  mtimeMs: number;
};

type FileSnapshot = {
  root: string;
  files: Map<string, FileSnapshotEntry>;
  complete: boolean;
};

type ExternalCandidateSnapshot =
  | {
      path: string;
      kind: "unavailable";
    }
  | {
      path: string;
      kind: "missing";
    }
  | {
      path: string;
      kind: "file";
      entry: FileSnapshotEntry;
    }
  | {
      path: string;
      kind: "directory";
      snapshot: FileSnapshot | null;
    };

// Stella defaults: 10s for exec_command, 250ms for write_stdin. Letting
// short commands finish on the first call dramatically reduces the
// "got a session_id, must call write_stdin to drain" round-trip the model
// would otherwise need for every fast shell invocation.
export const DEFAULT_EXEC_YIELD_MS = 10_000;
export const DEFAULT_WRITE_STDIN_YIELD_MS = 250;
const MAX_EXEC_YIELD_MS = 30_000;
// An empty `write_stdin` is a poll, not an interaction: nobody is waiting on
// the other side of the pipe, so it can afford to block much longer than a
// write. Codex sizes the same case at 5s..5min; matching that lets an agent
// sit out a quiet build inside its turn instead of round-tripping every 30s.
export const DEFAULT_EMPTY_POLL_YIELD_MS = 5_000;
const MAX_EMPTY_POLL_YIELD_MS = 5 * 60_000;
export const DEFAULT_EXEC_OUTPUT_TOKENS = 10_000;
export const EXEC_UPDATE_MAX_BYTES = 8 * 1024;
const MAX_EXEC_UPDATE_CHUNKS = 10_000;
export const MAX_RETAINED_COMPLETED_SHELLS = 64;
const MAX_PRUNED_SESSION_RECEIPTS = 16;
export const MAX_PRUNED_PRODUCED_FILE_RECOVERIES = 64;
export const COMPLETED_SHELL_TTL_MS = 30 * 60_000;
export const PRUNED_SHELL_RECEIPT_TTL_MS = 10 * 60_000;
const PRUNED_PRODUCED_FILES_TTL_MS = 30 * 60_000;
const MAX_ACCEPTED_WRITE_IDS = 256;
const ACCEPTED_WRITE_ID_TTL_MS = 10 * 60_000;
const PRODUCED_FILE_DELIVERY_WAIT_MS = 2_000;
export const PRODUCED_FILE_COLLECTION_ATTEMPT_MS = 5_000;
const MAX_SNAPSHOT_FILES = 20_000;
// Bound traversal independently of file count: a tree with hundreds of
// thousands of empty directories must not monopolize a tool deadline.
export const MAX_SNAPSHOT_ENTRIES = 50_000;
const MAX_EXTERNAL_SNAPSHOT_CANDIDATES = 256;
const MAX_SNAPSHOT_DIRECTORY_CONCURRENCY = 8;
const MAX_SNAPSHOT_STAT_CONCURRENCY = 32;
const MAX_EXTERNAL_SNAPSHOT_CONCURRENCY = 8;
const SNAPSHOT_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".turbo",
  "target",
  "dist",
  "build",
  "coverage",
  ".cache",
  "electron-user-data",
  // Electron build output (`desktop/dist-electron`) — segment-exact matching
  // means the plain "dist" entry above doesn't cover it. Dev-instance builds
  // copy the whole runtime-extension tree (agents/skills manifests) in here,
  // which showed up in production as phantom "update" produced files.
  "dist-electron",
]);

const APPROX_BYTES_PER_TOKEN = 4;
/**
 * Cheap byte-count → token estimate. Off by a small constant from any real
 * tokenizer, but stable enough for "did this output get truncated".
 */
export const approxTokenCount = (text: string): number =>
  Math.ceil(text.length / APPROX_BYTES_PER_TOKEN);

const OFFICE_PREVIEW_REF_MARKER = "__STELLA_OFFICE_PREVIEW_REF__";
const DEFERRED_DELETE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

// Snapshot root selection is lexical. Existence/readability is checked by the
// bounded async walk itself; a synchronous `existsSync` here could block the
// event loop on a stalled FUSE/network mount and defeat every caller deadline.
const normalizeSnapshotRoot = (cwd: string): string => path.resolve(cwd);

const shouldSkipSnapshotDir = (relativeDir: string): boolean => {
  const normalized = relativeDir.split(path.sep).join("/");
  return (
    SNAPSHOT_IGNORED_DIRS.has(normalized) ||
    normalized.split("/").some((segment) => SNAPSHOT_IGNORED_DIRS.has(segment))
  );
};

type SnapshotBudgetInterruption =
  | { kind: "deadline" }
  | { kind: "aborted"; error: unknown };

/**
 * One absolute budget shared by every read in a snapshot phase. Nothing in
 * the walk gets to restart a relative timeout: directory traversal, stats,
 * and mentioned external candidates all consume the same wall-clock bound.
 */
type SnapshotBudget = {
  readonly deadlineAtMonotonic: number;
  readonly signal?: AbortSignal;
  interruption?: SnapshotBudgetInterruption;
};

const createSnapshotBudget = (
  deadlineAt: number,
  signal?: AbortSignal,
): SnapshotBudget => ({
  // Convert the caller's public wall-clock deadline exactly once. Snapshot
  // progress thereafter uses the monotonic clock, so a wall-clock adjustment
  // cannot prematurely expire or indefinitely extend a filesystem walk.
  deadlineAtMonotonic: performance.now() + Math.max(0, deadlineAt - Date.now()),
  ...(signal ? { signal } : {}),
});

const readSnapshotBudgetInterruption = (
  budget: SnapshotBudget,
): SnapshotBudgetInterruption | undefined => {
  // A caller abort is stronger than a coincident best-effort deadline. Check
  // it first and let it replace a deadline observed by a sibling batch.
  if (budget.signal?.aborted) {
    budget.interruption = {
      kind: "aborted",
      error: budget.signal.reason ?? new Error("Aborted"),
    };
  } else if (
    !budget.interruption &&
    performance.now() >= budget.deadlineAtMonotonic
  ) {
    budget.interruption = { kind: "deadline" };
  }
  return budget.interruption;
};

/**
 * Bound one filesystem batch with the tools tree's Effect runtime. The raw
 * fs promise may be uninterruptible at the Node boundary, but once the race
 * loses it is detached from all returned snapshot state: it cannot hold a
 * caller, mutate a cached collection, or manufacture a partial diff later.
 */
const runSnapshotBudgetOperation = async <T>(
  budget: SnapshotBudget,
  operation: () => Promise<T>,
): Promise<ExecDeadlineOutcome<T>> => {
  const interrupted = readSnapshotBudgetInterruption(budget);
  if (interrupted?.kind === "aborted") {
    return { status: "aborted", error: interrupted.error };
  }
  if (interrupted?.kind === "deadline") return { status: "deadline" };

  const outcome = await runUntilDuration(
    operation,
    budget.deadlineAtMonotonic - performance.now(),
    budget.signal,
  );
  if (outcome.status === "aborted") {
    budget.interruption = { kind: "aborted", error: outcome.error };
    return outcome;
  }
  if (outcome.status === "deadline") {
    // Prefer an abort that raced the timer but became observable immediately
    // after Effect selected its winner.
    const afterRace = readSnapshotBudgetInterruption(budget);
    if (afterRace?.kind === "aborted") {
      return { status: "aborted", error: afterRace.error };
    }
    budget.interruption = { kind: "deadline" };
    return outcome;
  }
  if (outcome.status === "completed") {
    const afterOperation = readSnapshotBudgetInterruption(budget);
    if (afterOperation?.kind === "aborted") {
      return { status: "aborted", error: afterOperation.error };
    }
    if (afterOperation?.kind === "deadline") {
      return { status: "deadline" };
    }
  }
  return outcome;
};

const chunksOf = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const snapshotFiles = async (
  cwd: string,
  budget: SnapshotBudget,
): Promise<FileSnapshot | null> => {
  const root = normalizeSnapshotRoot(cwd);
  const files = new Map<string, FileSnapshotEntry>();
  const pendingDirectories = [root];
  let visitedEntries = 0;
  let complete = true;

  while (pendingDirectories.length > 0 && complete) {
    if (readSnapshotBudgetInterruption(budget)) {
      complete = false;
      break;
    }
    const directories = pendingDirectories.splice(
      0,
      MAX_SNAPSHOT_DIRECTORY_CONCURRENCY,
    );
    const directoryOutcome = await runSnapshotBudgetOperation(budget, () =>
      Promise.all(
        directories.map(async (directory) => {
          try {
            return {
              kind: "ready" as const,
              directory,
              entries: await readdir(directory, { withFileTypes: true }),
            };
          } catch (error) {
            return { kind: "failed" as const, directory, error };
          }
        }),
      ),
    );
    if (directoryOutcome.status !== "completed") {
      complete = false;
      break;
    }

    const filePaths: string[] = [];
    for (const directoryRead of directoryOutcome.value) {
      if (directoryRead.kind === "failed") {
        // Missing, unreadable, or transiently changing roots all make this
        // snapshot unusable. Consumers reject every incomplete diff.
        complete = false;
        break;
      }
      for (const entry of directoryRead.entries) {
        visitedEntries += 1;
        if (visitedEntries > MAX_SNAPSHOT_ENTRIES) {
          complete = false;
          break;
        }
        const fullPath = path.join(directoryRead.directory, entry.name);
        const relativePath = path.relative(root, fullPath);
        if (entry.isDirectory()) {
          if (!shouldSkipSnapshotDir(relativePath)) {
            pendingDirectories.push(fullPath);
          }
          continue;
        }
        if (!entry.isFile()) continue;
        if (files.size + filePaths.length >= MAX_SNAPSHOT_FILES) {
          complete = false;
          break;
        }
        filePaths.push(fullPath);
      }
      if (!complete) break;
    }
    if (!complete) break;

    for (const fileBatch of chunksOf(
      filePaths,
      MAX_SNAPSHOT_STAT_CONCURRENCY,
    )) {
      const statOutcome = await runSnapshotBudgetOperation(budget, () =>
        Promise.all(
          fileBatch.map(async (filePath) => {
            try {
              return {
                kind: "ready" as const,
                filePath,
                info: await stat(filePath),
              };
            } catch (error) {
              return { kind: "failed" as const, filePath, error };
            }
          }),
        ),
      );
      if (statOutcome.status !== "completed") {
        complete = false;
        break;
      }
      if (statOutcome.value.some((entry) => entry.kind === "failed")) {
        // Never turn an EACCES/transient stat failure into a delete. The map
        // can be partial internally, but `complete: false` makes it unusable.
        complete = false;
        break;
      }
      for (const entry of statOutcome.value) {
        if (entry.kind !== "ready") continue;
        files.set(entry.filePath, {
          size: entry.info.size,
          mtimeMs: entry.info.mtimeMs,
        });
      }
    }
  }

  return { root, files, complete };
};

const resolveShellSnapshotRoot = (
  cwd: string,
  context?: ToolContext,
): string => {
  if (context?.storageMode === "cloud") {
    const workspaceRoot = context.toolWorkspaceRoot?.trim();
    if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
      throw new Error("Cloud shell snapshots require a workspace boundary.");
    }
    return normalizeSnapshotRoot(workspaceRoot);
  }
  const resolvedCwd = normalizeSnapshotRoot(cwd);
  const resolvedStellaAppDir = context?.stellaAppDir?.trim()
    ? normalizeSnapshotRoot(context.stellaAppDir)
    : null;
  if (
    resolvedStellaAppDir &&
    (resolvedCwd === resolvedStellaAppDir ||
      resolvedCwd.startsWith(`${resolvedStellaAppDir}${path.sep}`))
  ) {
    return resolvedStellaAppDir;
  }
  return resolvedCwd;
};

const isSameOrInsidePath = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

const isBroadExternalCandidate = (candidate: string): boolean => {
  const resolved = path.resolve(candidate);
  return (
    resolved === path.parse(resolved).root ||
    resolved === os.homedir() ||
    resolved === path.dirname(os.homedir())
  );
};

const diffFileSnapshots = (
  before: FileSnapshot | null,
  after: FileSnapshot | null,
): FileChangeRecord[] | undefined => {
  if (
    !before ||
    !after ||
    !before.complete ||
    !after.complete ||
    before.root !== after.root
  ) {
    return undefined;
  }
  const changes: FileChangeRecord[] = [];
  for (const [filePath, afterEntry] of after.files) {
    const beforeEntry = before.files.get(filePath);
    if (!beforeEntry) {
      changes.push(fileChange(filePath, { type: "add" }));
      continue;
    }
    if (
      beforeEntry.size !== afterEntry.size ||
      beforeEntry.mtimeMs !== afterEntry.mtimeMs
    ) {
      changes.push(fileChange(filePath, { type: "update" }));
    }
  }
  for (const filePath of before.files.keys()) {
    if (!after.files.has(filePath)) {
      changes.push(fileChange(filePath, { type: "delete" }));
    }
  }
  return changes.length > 0 ? changes : undefined;
};

const snapshotExternalCandidate = async (
  candidatePath: string,
  budget: SnapshotBudget,
): Promise<ExternalCandidateSnapshot> => {
  if (readSnapshotBudgetInterruption(budget)) {
    return { path: candidatePath, kind: "unavailable" };
  }
  const statOutcome = await runSnapshotBudgetOperation(budget, () =>
    stat(candidatePath),
  );
  if (statOutcome.status === "failed") {
    if ((statOutcome.error as NodeJS.ErrnoException)?.code === "ENOENT") {
      // A genuinely missing path is useful: if it appears after the command,
      // we can report it as a produced file. Other I/O failures are
      // unavailable, never a synthetic delete.
      return { path: candidatePath, kind: "missing" };
    }
    return { path: candidatePath, kind: "unavailable" };
  }
  if (statOutcome.status !== "completed") {
    return { path: candidatePath, kind: "unavailable" };
  }
  const info = statOutcome.value;
  if (info.isDirectory()) {
    return {
      path: candidatePath,
      kind: "directory",
      snapshot: await snapshotFiles(candidatePath, budget),
    };
  }
  if (info.isFile()) {
    return {
      path: candidatePath,
      kind: "file",
      entry: {
        size: info.size,
        mtimeMs: info.mtimeMs,
      },
    };
  }
  return { path: candidatePath, kind: "unavailable" };
};

const snapshotExternalCandidates = async (
  candidatePaths: string[],
  snapshotRoot: string,
  budget: SnapshotBudget,
): Promise<ExternalCandidateSnapshot[] | undefined> => {
  const root = path.resolve(snapshotRoot);
  const paths = [
    ...new Set(candidatePaths.map((candidate) => path.resolve(candidate))),
  ].filter(
    (candidate) =>
      !isSameOrInsidePath(candidate, root) &&
      !isBroadExternalCandidate(candidate),
  );
  if (paths.length === 0) return undefined;
  // An inferred command can mention arbitrarily many paths. Skip the
  // external slice rather than take a misleading partial baseline.
  if (paths.length > MAX_EXTERNAL_SNAPSHOT_CANDIDATES) return undefined;
  const snapshots: ExternalCandidateSnapshot[] = [];
  for (const candidates of chunksOf(paths, MAX_EXTERNAL_SNAPSHOT_CONCURRENCY)) {
    if (readSnapshotBudgetInterruption(budget)) return undefined;
    snapshots.push(
      ...(await Promise.all(
        candidates.map((candidate) =>
          snapshotExternalCandidate(candidate, budget),
        ),
      )),
    );
    if (readSnapshotBudgetInterruption(budget)) return undefined;
  }
  return snapshots;
};

const diffExternalCandidateSnapshots = async (
  beforeSnapshots: ExternalCandidateSnapshot[] | undefined,
  budget: SnapshotBudget,
): Promise<{
  files?: ProducedFileRecord[];
  complete: boolean;
}> => {
  if (!beforeSnapshots || beforeSnapshots.length === 0) {
    return { complete: true };
  }
  const changes: ProducedFileRecord[] = [];

  const comparable = beforeSnapshots.filter(
    (before) => before.kind !== "unavailable",
  );
  for (const beforeBatch of chunksOf(
    comparable,
    MAX_EXTERNAL_SNAPSHOT_CONCURRENCY,
  )) {
    if (readSnapshotBudgetInterruption(budget)) return { complete: false };
    const afterBatch = await Promise.all(
      beforeBatch.map((before) =>
        snapshotExternalCandidate(before.path, budget),
      ),
    );
    if (readSnapshotBudgetInterruption(budget)) return { complete: false };

    for (let index = 0; index < beforeBatch.length; index += 1) {
      const before = beforeBatch[index];
      const after = afterBatch[index];
      if (!before || !after || after.kind === "unavailable") {
        // Discard the whole external diff on any unavailable after-state so a
        // partial batch can never manufacture deletes.
        return { complete: false };
      }
      if (after.kind === "missing") {
        if (before.kind !== "missing") {
          changes.push(fileChange(before.path, { type: "delete" }));
        }
        continue;
      }

      if (after.kind === "file") {
        if (before.kind !== "file") {
          changes.push(fileChange(after.path, { type: "add" }));
          continue;
        }
        if (
          before.entry.size !== after.entry.size ||
          before.entry.mtimeMs !== after.entry.mtimeMs
        ) {
          changes.push(fileChange(after.path, { type: "update" }));
        }
        continue;
      }

      if (before.kind === "directory") {
        if (!before.snapshot?.complete) continue;
        if (!after.snapshot?.complete) return { complete: false };
        changes.push(
          ...(diffFileSnapshots(before.snapshot, after.snapshot) ?? []),
        );
        continue;
      }
      if (!after.snapshot?.complete) return { complete: false };
      for (const filePath of after.snapshot.files.keys()) {
        changes.push(fileChange(filePath, { type: "add" }));
      }
    }
  }

  return {
    complete: true,
    ...(changes.length > 0 ? { files: changes } : {}),
  };
};

/**
 * The `producedFiles` / `producedFilesOmitted` slice of a `ToolResult`, so
 * every shell handler can spread one object instead of rebuilding the pair.
 */
type ProducedFilesOutcome = {
  producedFiles?: ProducedFileRecord[];
  producedFilesOmitted?: ProducedFilesOmission;
};

type ProducedFilesCollectionAttempt =
  | { kind: "ready"; outcome: ProducedFilesOutcome }
  | { kind: "retryable" };

/**
 * Identity-stable producer state. A caller only waits on `promise`; timing
 * out or aborting that wait never replaces the producer. The producer itself
 * either publishes `ready` on this exact object or clears the record back to
 * retryable/idle, preserving the original baselines for a later drain.
 */
type ProducedFilesCollectionState = {
  phase: "producing" | "ready";
  promise: Promise<ProducedFilesCollectionAttempt>;
  outcome?: ProducedFilesOutcome;
};

type ProducedFilesSource = Pick<
  ManagedShellRecord,
  | "running"
  | "startSnapshot"
  | "externalCandidateSnapshots"
  | "producedFilesReported"
  | "producedFilesCollection"
  | "producedFileLimit"
  | "child"
  | "pty"
>;

type PreparedProducedFilesClaim = {
  ready: boolean;
  claim: () => ProducedFilesOutcome;
};

const publishProducedFilesCollectionAttempt = (
  record: ProducedFilesSource,
  state: ProducedFilesCollectionState,
  attempt: ProducedFilesCollectionAttempt,
): void => {
  if (record.producedFilesCollection !== state) return;
  if (attempt.kind === "ready") {
    state.phase = "ready";
    state.outcome = attempt.outcome;
    // Release potentially large baselines, but retain this ready state until
    // one authorized caller atomically claims its outcome.
    record.startSnapshot = null;
    record.externalCandidateSnapshots = undefined;
  } else {
    // A failed, incomplete, or timed-out attempt is retryable. Keep its
    // baselines and clear only this generation.
    record.producedFilesCollection = undefined;
  }
  record.child = undefined;
  record.pty = undefined;
};

/**
 * Per-command cap on snapshot-detected produced files. Belongs to the host,
 * not to the runtime: the desktop default assumes an over-cap batch reaches
 * the user unfiltered, while a host that re-filters every file downstream can
 * afford a larger deliberate batch.
 */
const resolveProducedFileLimit = (context?: ToolContext): number => {
  const requested = context?.maxProducedFilesPerCommand;
  return typeof requested === "number" && Number.isFinite(requested)
    ? Math.max(0, Math.floor(requested))
    : MAX_PRODUCED_FILES_PER_COMMAND;
};

/**
 * Merge + sanitize snapshot-detected produced files. Every shell
 * `producedFiles` emission (foreground exec, background completion via
 * `takeCompletedProducedFiles`, `write_stdin` / shell-status drains) funnels
 * through here, so collection semantics live in one place:
 *
 *  1. Dedupe across the root-workspace diff and external-candidate diffs.
 *  2. Drop noise paths (`isNoiseProducedPath`: hidden/profile/cache dirs,
 *     logs, locks) so they never persist into `tool_result` payloads.
 *  3. Bulk-churn guard: if a single command still "produced" more than
 *     `limit` files, the diff is most likely environment churn (spawned app
 *     bootstrap seeding its data dir, git checkout/worktree mtime rewrites,
 *     dependency installs) — not deliverables. Withhold the whole batch,
 *     since no per-path signal separates the churn from the three files the
 *     user asked for; deliberate writes still surface via explicit
 *     `fileChanges` from Write/Edit/apply_patch, which never pass through
 *     snapshot detection.
 *
 * The withholding is *reported*, never silent: a genuinely large deliberate
 * batch (a loop writing 31 charts) also trips the guard, and a caller that
 * sees neither files nor a count cannot tell "produced nothing" from
 * "produced 31 and I dropped them". Hosts that can afford the batch raise
 * `limit` via `ToolContext.maxProducedFilesPerCommand` instead.
 */
const mergeProducedFiles = (
  limit: number,
  ...groups: Array<ProducedFileRecord[] | undefined>
): ProducedFilesOutcome => {
  const out: ProducedFileRecord[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    if (!group) continue;
    for (const file of group) {
      if (isNoiseProducedPath(file.path)) continue;
      const key = `${file.kind.type}:${file.path}:${file.kind.type === "update" ? (file.kind.move_path ?? "") : ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(file);
    }
  }
  if (out.length > limit) {
    return { producedFilesOmitted: { count: out.length, limit } };
  }
  return out.length > 0 ? { producedFiles: out } : {};
};

const producedFilesOmittedNotice = (omission: ProducedFilesOmission): string =>
  `Note: ${omission.count} produced files were detected for this command, above the per-command delivery limit of ${omission.limit}, so none were attached to this result.`;

const snapshotShellSideEffects = async (
  args: Record<string, unknown>,
  snapshotRoot: string,
  context: ToolContext | undefined,
  budget: SnapshotBudget,
): Promise<{
  rootSnapshot: FileSnapshot | null;
  externalCandidateSnapshots?: ExternalCandidateSnapshot[];
}> => {
  const rootSnapshot = await snapshotFiles(snapshotRoot, budget);
  const externalCandidateSnapshots =
    context?.storageMode === "cloud"
      ? undefined
      : await snapshotExternalCandidates(
          inferShellMentionedPaths(args, context),
          snapshotRoot,
          budget,
        );
  return { rootSnapshot, externalCandidateSnapshots };
};

const shouldSnapshotShellSideEffects = (command: string): boolean =>
  !isKnownSafeCommand(command);

const hasProducedFileSources = (record: ProducedFilesSource): boolean =>
  Boolean(record.startSnapshot?.complete) ||
  Boolean(
    record.externalCandidateSnapshots &&
      record.externalCandidateSnapshots.some(
        (candidate) =>
          candidate.kind === "missing" ||
          candidate.kind === "file" ||
          (candidate.kind === "directory" &&
            Boolean(candidate.snapshot?.complete)),
      ),
  );

/**
 * Start (or reuse) collection owned by the completed shell record. Individual
 * callers race this promise with their own signal/deadline below; leaving the
 * producer independent means one canceled exec/write cannot consume or poison
 * a result that a later run-finalizer can still deliver.
 */
const ensureCompletedProducedFilesCollection = (
  record: ProducedFilesSource,
): ProducedFilesCollectionState => {
  if (record.producedFilesCollection) return record.producedFilesCollection;

  const startSnapshot = record.startSnapshot;
  const externalCandidateSnapshots = record.externalCandidateSnapshots;
  const budget = createSnapshotBudget(
    Date.now() + PRODUCED_FILE_COLLECTION_ATTEMPT_MS,
  );
  const promise = (async (): Promise<ProducedFilesCollectionAttempt> => {
    let rootFiles: ProducedFileRecord[] | undefined;
    // A missing/incomplete start snapshot can never produce a trustworthy
    // root diff. Known-safe commands deliberately set it to null; do not turn
    // their completion into an unconditional full-tree walk.
    if (startSnapshot?.complete) {
      const after = await snapshotFiles(startSnapshot.root, budget);
      if (!after?.complete) return { kind: "retryable" };
      rootFiles = diffFileSnapshots(startSnapshot, after);
    }
    const external = await diffExternalCandidateSnapshots(
      externalCandidateSnapshots,
      budget,
    );
    if (!external.complete) return { kind: "retryable" };
    return {
      kind: "ready",
      outcome: mergeProducedFiles(
        record.producedFileLimit,
        rootFiles,
        external.files,
      ),
    };
  })().catch((): ProducedFilesCollectionAttempt => ({ kind: "retryable" }));
  const state: ProducedFilesCollectionState = {
    phase: "producing",
    promise,
  };
  record.producedFilesCollection = state;
  void promise.then((attempt) => {
    publishProducedFilesCollectionAttempt(record, state, attempt);
  });
  return state;
};

const prepareCompletedProducedFilesClaim = async (
  record: ProducedFilesSource,
  signal?: AbortSignal,
  deadlineAt = Date.now() + PRODUCED_FILE_DELIVERY_WAIT_MS,
): Promise<PreparedProducedFilesClaim> => {
  const deferredClaim = {
    ready: false,
    claim: (): ProducedFilesOutcome => ({}),
  };
  const emptyClaim = {
    ready: true,
    claim: (): ProducedFilesOutcome => ({}),
  };
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Aborted");
  }
  if (Date.now() >= deadlineAt) return deferredClaim;
  if (record.running) return deferredClaim;
  if (record.producedFilesReported) return emptyClaim;
  if (!hasProducedFileSources(record) && !record.producedFilesCollection) {
    record.producedFilesReported = true;
    record.child = undefined;
    record.pty = undefined;
    return emptyClaim;
  }
  const state = ensureCompletedProducedFilesCollection(record);
  let produced = state.outcome;
  if (state.phase === "producing") {
    const outcome = await runUntilExecDeadline(
      () => state.promise,
      deadlineAt,
      signal,
    );
    if (outcome.status === "aborted") {
      throw outcome.error;
    }
    if (outcome.status === "failed") {
      throw outcome.error;
    }
    if (outcome.status === "deadline") {
      return deferredClaim;
    }
    if (outcome.value.kind === "retryable") {
      publishProducedFilesCollectionAttempt(record, state, outcome.value);
      return deferredClaim;
    }
    publishProducedFilesCollectionAttempt(record, state, outcome.value);
    if (signal?.aborted) {
      throw signal.reason ?? new Error("Aborted");
    }
    produced = outcome.value.outcome;
  }
  if (!produced || record.producedFilesCollection !== state) {
    return deferredClaim;
  }
  return {
    ready: true,
    claim: () => {
      if (record.producedFilesReported) return {};
      if (record.producedFilesCollection !== state || state.phase !== "ready") {
        return {};
      }
      record.producedFilesReported = true;
      record.producedFilesCollection = undefined;
      return produced;
    },
  };
};

const takeCompletedProducedFiles = async (
  record: ProducedFilesSource,
  signal?: AbortSignal,
  deadlineAt = Date.now() + PRODUCED_FILE_DELIVERY_WAIT_MS,
): Promise<ProducedFilesOutcome> => {
  const prepared = await prepareCompletedProducedFilesClaim(
    record,
    signal,
    deadlineAt,
  );
  return prepared.claim();
};

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
 * Keep the active-shell map bounded while detaching produced-file recovery
 * into its own bounded/TTL map. Running shells and records with queued
 * interactions are never candidates; the release path retries pruning after
 * the interaction completes.
 */
const pruneCompletedShellSessions = (
  state: ShellState,
  now = Date.now(),
): void => {
  for (const [id, receipt] of state.prunedSessions) {
    if (now - receipt.prunedAt >= PRUNED_SHELL_RECEIPT_TTL_MS) {
      state.prunedSessions.delete(id);
    }
  }
  for (const [id, recovery] of state.prunedProducedFiles) {
    if (
      !recovery.claimed &&
      now - recovery.prunedAt >= PRUNED_PRODUCED_FILES_TTL_MS
    ) {
      state.prunedProducedFiles.delete(id);
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

    if (
      !record.producedFilesReported &&
      (hasProducedFileSources(record) || record.producedFilesCollection)
    ) {
      while (
        state.prunedProducedFiles.size >= MAX_PRUNED_PRODUCED_FILE_RECOVERIES
      ) {
        const oldestUnclaimed = [...state.prunedProducedFiles.entries()]
          .filter(([, recovery]) => !recovery.claimed)
          .sort((left, right) => left[1].prunedAt - right[1].prunedAt)[0];
        if (!oldestUnclaimed) break;
        state.prunedProducedFiles.delete(oldestUnclaimed[0]);
      }
      // If every bounded slot is actively claimed, retain the rich record and
      // retry pruning after those drains release instead of dropping recovery.
      if (
        state.prunedProducedFiles.size >= MAX_PRUNED_PRODUCED_FILE_RECOVERIES
      ) {
        continue;
      }
      const recovery = {
        prunedAt: now,
        ...(record.owner ? { owner: record.owner } : {}),
        claimed: false,
        source: record,
      };
      state.prunedProducedFiles.set(record.id, recovery);
      const collection = ensureCompletedProducedFilesCollection(record);
      void collection.promise.then((attempt) => {
        const current = state.prunedProducedFiles.get(record.id);
        if (
          current === recovery &&
          !current.claimed &&
          attempt.kind === "ready" &&
          !attempt.outcome.producedFiles?.length &&
          !attempt.outcome.producedFilesOmitted
        ) {
          // Empty/failed outcomes carry no recoverable user value and should
          // not occupy the bounded map until its TTL.
          state.prunedProducedFiles.delete(record.id);
        }
      });
    }
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

/**
 * Drain completed-but-unreported produced files from managed shell sessions.
 *
 * Long-running/background commands that finish AFTER the model's last poll
 * leave their deliverables sitting on the record with `producedFilesReported`
 * still false — the foreground `write_stdin` / shell-status drain never runs
 * for them, so those files (e.g. a video render written after the tool
 * nominally completed) would only ride individual `tool_result` entries and
 * never reach the agent-completed rollup. This lets the agent finalizer pull
 * such late deliverables in before the rollup emits.
 *
 * `access` is the full conversation/agent owner key (`null` is reserved for
 * likewise-unowned direct harness sessions). Scope with `sessionIds` to the
 * sessions a run actually touched; omitting ids sweeps only sessions matching
 * that owner. Uses the same prepared/atomic produced-file claim, so the
 * one-shot `producedFilesReported` flag, `isNoiseProducedPath` guards,
 * per-command dedup, and the per-command cap all still apply, and a session
 * already drained inline yields nothing here.
 *
 * The withholding travels with the files, for the same reason it does on the
 * inline drains: a session whose batch the cap held back contributes no files
 * at all, and a rollup that sees an empty list cannot tell that from a
 * background command that wrote nothing. `omitted` sums the withheld counts
 * across the swept sessions and carries the largest limit that did the
 * withholding, so the rollup can say how many files are still on disk.
 */
export const drainCompletedProducedFiles = async (
  state: ShellState,
  access: ShellSessionAccess | null,
  sessionIds?: Iterable<string>,
  signal?: AbortSignal,
  deadlineAt = Date.now() + PRODUCED_FILE_DELIVERY_WAIT_MS,
): Promise<{
  files: ProducedFileRecord[];
  omitted?: ProducedFilesOmission;
}> => {
  const requestedIds = sessionIds ? [...new Set(sessionIds)] : undefined;
  const records = requestedIds
    ? requestedIds
        .map((id) => state.shells.get(id))
        .filter(
          (record): record is ManagedShellRecord =>
            Boolean(record) && shellOwnerMatchesAccess(record?.owner, access),
        )
    : [...state.shells.values()].filter((record) =>
        shellOwnerMatchesAccess(record.owner, access),
      );
  const files: ProducedFileRecord[] = [];
  let count = 0;
  let limit = 0;
  const collect = (produced: ProducedFilesOutcome | undefined) => {
    if (!produced) return;
    if (produced.producedFiles) files.push(...produced.producedFiles);
    if (produced.producedFilesOmitted) {
      count += produced.producedFilesOmitted.count;
      limit = Math.max(limit, produced.producedFilesOmitted.limit);
    }
  };
  const prunedIds = requestedIds ?? [...state.prunedProducedFiles.keys()];
  const claims: Array<{ id: string; recovery: PrunedProducedFilesRecovery }> =
    [];
  for (const id of prunedIds) {
    const recovery = state.prunedProducedFiles.get(id);
    if (
      !recovery ||
      recovery.claimed ||
      !shellOwnerMatchesAccess(recovery.owner, access)
    ) {
      continue;
    }
    recovery.claimed = true;
    claims.push({ id, recovery });
  }
  let liveClaims: PreparedProducedFilesClaim[];
  let claimOutcomes: Array<{
    id: string;
    recovery: PrunedProducedFilesRecovery;
    prepared: PreparedProducedFilesClaim;
  }>;
  try {
    [liveClaims, claimOutcomes] = await Promise.all([
      Promise.all(
        records.map((record) =>
          prepareCompletedProducedFilesClaim(record, signal, deadlineAt),
        ),
      ),
      Promise.all(
        claims.map(async ({ id, recovery }) => ({
          id,
          recovery,
          prepared: await prepareCompletedProducedFilesClaim(
            recovery.source,
            signal,
            deadlineAt,
          ),
        })),
      ),
    ]);
  } catch (error) {
    for (const { id, recovery } of claims) {
      const current = state.prunedProducedFiles.get(id);
      if (current === recovery) current.claimed = false;
    }
    throw error;
  }
  if (signal?.aborted) {
    for (const { id, recovery } of claims) {
      const current = state.prunedProducedFiles.get(id);
      if (current === recovery) current.claimed = false;
    }
    throw signal.reason ?? new Error("Aborted");
  }
  for (const prepared of liveClaims) {
    if (prepared.ready) collect(prepared.claim());
  }
  for (const { id, recovery, prepared } of claimOutcomes) {
    const current = state.prunedProducedFiles.get(id);
    if (prepared.ready) {
      if (current === recovery) state.prunedProducedFiles.delete(id);
      collect(prepared.claim());
      continue;
    }
    if (current === recovery) current.claimed = false;
  }
  return { files, ...(count > 0 ? { omitted: { count, limit } } : {}) };
};

export const extractOfficePreviewRef = (
  output: string,
): { cleanedOutput: string; officePreviewRef?: OfficePreviewRef } => {
  let officePreviewRef: OfficePreviewRef | undefined;
  const keptLines: string[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(OFFICE_PREVIEW_REF_MARKER)) {
      keptLines.push(line);
      continue;
    }

    const rawPayload = line.slice(OFFICE_PREVIEW_REF_MARKER.length).trim();
    if (!rawPayload) {
      continue;
    }

    try {
      const parsed = JSON.parse(rawPayload) as OfficePreviewRef;
      if (
        typeof parsed.sessionId === "string" &&
        typeof parsed.title === "string" &&
        typeof parsed.sourcePath === "string"
      ) {
        officePreviewRef = parsed;
      }
    } catch {
      keptLines.push(line);
    }
  }

  const cleanedOutput = keptLines.join("\n").trim();
  return {
    cleanedOutput:
      cleanedOutput ||
      (officePreviewRef ? "Started inline office preview." : ""),
    ...(officePreviewRef ? { officePreviewRef } : {}),
  };
};

const buildWindowsCliShimScript = (envVar: string): string =>
  [
    "@echo off",
    'set "ELECTRON_RUN_AS_NODE=1"',
    `"%STELLA_NODE_BIN%" "%${envVar}%" %*`,
    "",
  ].join("\r\n");

const buildWindowsNodeShimScript = (): string =>
  [
    "@echo off",
    'set "ELECTRON_RUN_AS_NODE=1"',
    '"%STELLA_NODE_BIN%" %*',
    "",
  ].join("\r\n");

const buildWindowsPythonShimScript = (): string =>
  ["@echo off", '"%STELLA_PYTHON_BIN%" %*', ""].join("\r\n");

const buildWindowsPipShimScript = (): string =>
  ["@echo off", '"%STELLA_PYTHON_BIN%" -m pip %*', ""].join("\r\n");

const buildUnixNodeShimScript = (): string =>
  ["#!/bin/sh", 'ELECTRON_RUN_AS_NODE=1 exec "$STELLA_NODE_BIN" "$@"', ""].join(
    "\n",
  );

const buildUnixCliShimScript = (envVar: string): string =>
  [
    "#!/bin/sh",
    `ELECTRON_RUN_AS_NODE=1 exec "$STELLA_NODE_BIN" "$${envVar}" "$@"`,
    "",
  ].join("\n");

const buildUnixGitShimScript = (): string =>
  [
    "#!/bin/sh",
    'if [ -n "$STELLA_GIT_BIN" ]; then',
    '  __stella_git_bin="$STELLA_GIT_BIN"',
    "else",
    '  __stella_git_bin="$STELLA_REAL_GIT_BIN"',
    "fi",
    'if [ -z "$__stella_git_bin" ]; then',
    '  echo "git executable not found" >&2',
    "  exit 127",
    "fi",
    'if [ "$1" = "commit" ]; then',
    "  __stella_has_feature_tag=0",
    '  for __stella_arg in "$@"; do',
    '    case "$__stella_arg" in',
    '      *"[feature:"*) __stella_has_feature_tag=1 ;;',
    "    esac",
    "  done",
    '  if [ "$__stella_has_feature_tag" -eq 1 ]; then',
    '    __stella_repo_root="$("$__stella_git_bin" rev-parse --show-toplevel 2>/dev/null || true)"',
    '    if [ -n "$__stella_repo_root" ]; then',
    "      for __stella_dep_name in package.json bun.lock bun.lockb package-lock.json pnpm-lock.yaml yarn.lock npm-shrinkwrap.json; do",
    '        __stella_dep_file="$__stella_repo_root/$__stella_dep_name"',
    '        if [ -f "$__stella_dep_file" ]; then',
    '          "$__stella_git_bin" add -- "$__stella_dep_file" >/dev/null 2>&1 || true',
    "        fi",
    "      done",
    "    fi",
    "  fi",
    "fi",
    'exec "$__stella_git_bin" "$@"',
    "",
  ].join("\n");

const ensureNodeShim = (
  secretStateRoot: string,
  options?: ShellStateOptions,
): string | undefined => {
  const shimDir = path.join(secretStateRoot, "shell-shims");
  const shimPath = path.join(
    shimDir,
    process.platform === "win32" ? "node.cmd" : "node",
  );
  try {
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(
      shimPath,
      process.platform === "win32"
        ? buildWindowsNodeShimScript()
        : buildUnixNodeShimScript(),
      "utf-8",
    );
    if (process.platform === "win32" && process.env.STELLA_PYTHON_BIN?.trim()) {
      for (const command of ["python", "python3", "py"]) {
        writeFileSync(
          path.join(shimDir, `${command}.cmd`),
          buildWindowsPythonShimScript(),
          "utf-8",
        );
      }
      for (const command of ["pip", "pip3"]) {
        writeFileSync(
          path.join(shimDir, `${command}.cmd`),
          buildWindowsPipShimScript(),
          "utf-8",
        );
      }
    }
    if (process.platform !== "win32") {
      const unixShimPaths = [shimPath];
      const gitShimPath = path.join(shimDir, "git");
      writeFileSync(gitShimPath, buildUnixGitShimScript(), "utf-8");
      unixShimPaths.push(gitShimPath);
      for (const shim of WINDOWS_CLI_SHIMS) {
        const cliPath = options?.[shim.optionKey];
        if (typeof cliPath !== "string" || !existsSync(cliPath)) continue;
        const cliShimPath = path.join(shimDir, shim.command);
        writeFileSync(
          cliShimPath,
          buildUnixCliShimScript(shim.envVar),
          "utf-8",
        );
        unixShimPaths.push(cliShimPath);
      }
      for (const unixShimPath of unixShimPaths) {
        chmodSync(unixShimPath, 0o700);
      }
    }
    return shimDir;
  } catch {
    return undefined;
  }
};

const ensureWindowsCliShims = (
  secretStateRoot: string,
  options?: ShellStateOptions,
): string | undefined => {
  const requested = WINDOWS_CLI_SHIMS.filter(
    (shim) => typeof options?.[shim.optionKey] === "string",
  );
  if (requested.length === 0) {
    return undefined;
  }

  const shimDir = path.join(secretStateRoot, "shell-shims");
  try {
    mkdirSync(shimDir, { recursive: true });
    for (const shim of requested) {
      writeFileSync(
        path.join(shimDir, `${shim.command}.cmd`),
        buildWindowsCliShimScript(shim.envVar),
        "utf-8",
      );
    }
    return shimDir;
  } catch {
    return undefined;
  }
};

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
    workerGeneration: crypto.randomUUID().slice(0, 8),
    prunedSessions: new Map(),
    prunedProducedFiles: new Map(),
    secretStateRoot,
    stellaBrowserBinPath: options?.stellaBrowserBinPath,
    stellaOfficeBinPath: options?.stellaOfficeBinPath,
    stellaComputerCliPath: options?.stellaComputerCliPath,
    stellaMediaCliPath: options?.stellaMediaCliPath,
    stellaXApiCliPath: options?.stellaXApiCliPath,
    ...(nodeShimDir ? { nodeShimDir } : {}),
    getStellaSiteAuth: options?.getStellaSiteAuth,
    ...(windowsCliShimDir ? { windowsCliShimDir } : {}),
    cliBridgeSocketPath: options?.cliBridgeSocketPath,
    lastDeferredDeleteSweepAt: 0,
  };
}

export const buildShellCommand = (
  command: string,
  _state: ShellState,
  _platform: NodeJS.Platform = process.platform,
  _shell?: string,
): string => command;

const resolveStellaDataDirFromState = (
  state: ShellState,
): string | undefined => {
  const stateRoot = path.resolve(state.secretStateRoot);
  if (path.basename(stateRoot) === "state") {
    return path.dirname(stateRoot);
  }
  return stateRoot;
};

const maybeSweepDeferredDeletes = (state: ShellState) => {
  const now = Date.now();
  if (
    state.lastDeferredDeleteSweepAt > 0 &&
    now - state.lastDeferredDeleteSweepAt < DEFERRED_DELETE_SWEEP_INTERVAL_MS
  ) {
    return;
  }
  state.lastDeferredDeleteSweepAt = now;
  void purgeExpiredDeferredDeletes({
    stellaDataDir: resolveStellaDataDirFromState(state),
    now,
  }).catch(() => undefined);
};

export const resolveShellNodeBinary = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const explicit = env.STELLA_NODE_BIN?.trim();
  if (explicit && existsSync(explicit)) return explicit;

  // The detached Stella runtime itself runs under Bun. Electron's host
  // executable is passed into that worker specifically so child processes can
  // launch its bundled Node runtime with ELECTRON_RUN_AS_NODE=1.
  const hostExecutable = env.STELLA_HOST_EXECUTABLE_PATH?.trim();
  if (hostExecutable && existsSync(hostExecutable)) return hostExecutable;

  // Non-Electron embeddings commonly run the kernel under Node.
  return process.execPath;
};

const buildShellEnv = (
  envOverrides?: Record<string, string>,
  options?: {
    secretStateRoot?: string;
    stellaBrowserBinPath?: string;
    stellaOfficeBinPath?: string;
    stellaComputerCliPath?: string;
    stellaMediaCliPath?: string;
    stellaXApiCliPath?: string;
    nodeShimDir?: string;
    windowsCliShimDir?: string;
    cliBridgeSocketPath?: string;
  },
  tty = false,
) => {
  const deterministicPipeEnv: NodeJS.ProcessEnv = tty
    ? {}
    : {
        NO_COLOR: "1",
        CLICOLOR: "0",
        FORCE_COLOR: "0",
        TERM: "dumb",
        COLORTERM: "",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        LC_CTYPE: "C.UTF-8",
        PAGER: "cat",
        GIT_PAGER: "cat",
        GH_PAGER: "cat",
      };
  const mergedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...deterministicPipeEnv,
    ...(envOverrides ?? {}),
    STELLA_NODE_BIN: resolveShellNodeBinary(
      envOverrides ? { ...process.env, ...envOverrides } : process.env,
    ),
    STELLA_RUNTIME_WORKER_PID: String(process.pid),
    ...(options?.secretStateRoot
      ? { STELLA_DATA_DIR: options.secretStateRoot }
      : {}),
    ...(options?.stellaOfficeBinPath
      ? { STELLA_OFFICE_BIN: options.stellaOfficeBinPath }
      : {}),
    ...(options?.stellaComputerCliPath
      ? { STELLA_COMPUTER_CLI: options.stellaComputerCliPath }
      : {}),
    ...(options?.stellaMediaCliPath
      ? { STELLA_MEDIA_CLI: options.stellaMediaCliPath }
      : {}),
    ...(options?.stellaXApiCliPath
      ? { STELLA_X_API_CLI: options.stellaXApiCliPath }
      : {}),
    ...(options?.cliBridgeSocketPath
      ? { STELLA_CLI_BRIDGE_SOCK: options.cliBridgeSocketPath }
      : {}),
  };
  // Connector actions authenticate through the worker broker. Never inherit
  // legacy raw Stella bearer variables into shell or agent processes.
  delete mergedEnv.STELLA_SITE_AUTH_TOKEN;
  delete mergedEnv.STELLA_NATIVE_OAUTH_BACKEND_AUTH_TOKEN;
  delete mergedEnv.STELLA_LLM_PROXY_TOKEN;
  delete mergedEnv.STELLA_AUTH_TOKEN;

  const shellShimDirs = [options?.nodeShimDir, options?.windowsCliShimDir]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);
  if (shellShimDirs.length > 0) {
    const pathKey =
      Object.keys(mergedEnv).find((key) => key.toLowerCase() === "path") ??
      "PATH";
    const existingPath =
      typeof mergedEnv[pathKey] === "string" ? mergedEnv[pathKey] : "";
    if (process.platform !== "win32" && options?.nodeShimDir) {
      const configuredGit = mergedEnv.STELLA_GIT_BIN?.trim();
      const validConfiguredGit =
        configuredGit && existsSync(configuredGit) ? configuredGit : undefined;
      const realGit =
        validConfiguredGit ??
        findOnPath("git", process.platform, mergedEnv, existsSync) ??
        "";
      if (!validConfiguredGit) delete mergedEnv.STELLA_GIT_BIN;
      if (realGit) mergedEnv.STELLA_REAL_GIT_BIN = realGit;
    }
    mergedEnv[pathKey] = [...shellShimDirs, existingPath]
      .filter(Boolean)
      .join(path.delimiter);
    if (options?.nodeShimDir) {
      mergedEnv.STELLA_NODE_SHIM_DIR = options.nodeShimDir;
    }
    if (options?.windowsCliShimDir) {
      mergedEnv.STELLA_WINDOWS_CLI_SHIM_DIR = options.windowsCliShimDir;
    }
  }

  return mergedEnv;
};

type DetectedShellKind = "zsh" | "bash" | "sh" | "powershell" | "cmd";

export type ShellDetectionOptions = {
  /** Unix login shell from the system account database. Null disables it. */
  userShell?: string | null;
  /** Test seam for platform-specific executable discovery. */
  executableExists?: (candidate: string) => boolean;
};

const resolveUserLoginShell = (): string | null => {
  try {
    return os.userInfo().shell?.trim() || null;
  } catch {
    return null;
  }
};

const shellKind = (
  shell: string,
  platform: NodeJS.Platform,
): DetectedShellKind | undefined => {
  const basename =
    platform === "win32"
      ? path.win32.basename(shell.trim()).toLowerCase()
      : path.posix.basename(shell.trim()).toLowerCase();
  switch (basename.replace(/\.exe$/u, "")) {
    case "zsh":
      return "zsh";
    case "bash":
      return "bash";
    case "sh":
      return "sh";
    case "pwsh":
    case "powershell":
      return "powershell";
    case "cmd":
      return "cmd";
    default:
      return undefined;
  }
};

const pathEnvironmentValue = (
  environment: NodeJS.ProcessEnv,
): string | undefined =>
  Object.entries(environment).find(
    ([key]) => key.toLowerCase() === "path",
  )?.[1];

const findOnPath = (
  binary: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  executableExists: (candidate: string) => boolean,
): string | undefined => {
  const pathValue = pathEnvironmentValue(environment);
  if (!pathValue) return undefined;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const names =
    platform === "win32" && !path.win32.extname(binary)
      ? [binary, `${binary}.exe`]
      : [binary];
  for (const directory of pathValue.split(pathApi.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = pathApi.join(directory, name);
      if (executableExists(candidate)) return candidate;
    }
  }
  return undefined;
};

const resolveUnixShellKind = (
  kind: "zsh" | "bash" | "sh" | "powershell",
  preferredPath: string | undefined,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  executableExists: (candidate: string) => boolean,
): string | undefined => {
  if (preferredPath && executableExists(preferredPath)) return preferredPath;
  const binary = kind === "powershell" ? "pwsh" : kind;
  const fromPath = findOnPath(binary, platform, environment, executableExists);
  if (fromPath) return fromPath;
  const fallbacks =
    kind === "zsh"
      ? ["/bin/zsh"]
      : kind === "bash"
        ? ["/bin/bash", "/usr/bin/bash"]
        : kind === "sh"
          ? ["/bin/sh"]
          : ["/usr/local/bin/pwsh"];
  return fallbacks.find(executableExists);
};

export const resolveDefaultShell = (
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  detection: ShellDetectionOptions = {},
): string => {
  const executableExists = detection.executableExists ?? existsSync;
  if (platform === "win32") {
    const programFiles =
      environment.ProgramFiles?.trim() || "C:\\Program Files";
    const systemRoot = environment.SystemRoot?.trim() || "C:\\Windows";
    const pwsh =
      findOnPath("pwsh", platform, environment, executableExists) ??
      [path.win32.join(programFiles, "PowerShell", "7", "pwsh.exe")].find(
        executableExists,
      );
    if (pwsh) return pwsh;
    const windowsPowerShell =
      findOnPath("powershell", platform, environment, executableExists) ??
      [
        path.win32.join(
          systemRoot,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
      ].find(executableExists);
    return windowsPowerShell ?? "cmd.exe";
  }

  const hasInjectedUserShell = Object.prototype.hasOwnProperty.call(
    detection,
    "userShell",
  );
  const userShell = hasInjectedUserShell
    ? detection.userShell?.trim() || null
    : resolveUserLoginShell();
  const userKind = userShell ? shellKind(userShell, platform) : undefined;
  if (userKind && userKind !== "cmd") {
    const resolved = resolveUnixShellKind(
      userKind,
      userShell ?? undefined,
      platform,
      environment,
      executableExists,
    );
    if (resolved) return resolved;
  }

  const fallbackKinds: Array<"zsh" | "bash"> =
    platform === "darwin" ? ["zsh", "bash"] : ["bash", "zsh"];
  for (const kind of fallbackKinds) {
    const resolved = resolveUnixShellKind(
      kind,
      undefined,
      platform,
      environment,
      executableExists,
    );
    if (resolved) return resolved;
  }
  return "/bin/sh";
};

export type ShellLaunchOptions = {
  /** Explicit executable requested by exec_command. */
  shell?: string;
  /** Login-shell semantics are the default for compatibility with prior runs. */
  login?: boolean;
  /** Allocate a real Unix PTY or Windows ConPTY for this command. */
  tty?: boolean;
};

export type ResolvedShellLaunch = {
  shell: string;
  args: string[];
  /**
   * `cmd.exe` parses the raw Windows command line itself instead of using the
   * C runtime argv decoder. Letting Node quote its final command argument turns
   * embedded `"` delimiters into literal `\"` text, breaking executable paths
   * that contain spaces.
   */
  windowsVerbatimArguments?: boolean;
};

const windowsShellName = (shell: string): string =>
  path.win32.basename(shell.trim()).toLowerCase();

const isWindowsCmdShell = (shell: string): boolean =>
  ["cmd", "cmd.exe"].includes(windowsShellName(shell));

const isPowerShell = (shell: string): boolean =>
  ["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(
    windowsShellName(shell),
  );

const encodePowerShellCommand = (command: string): string =>
  Buffer.from(command, "utf16le").toString("base64");

const withPowerShellExitPropagation = (command: string): string =>
  [
    // `pwsh -EncodedCommand` otherwise normalizes some native failures to a
    // generic process status. Capture the command's own success bit and native
    // status immediately, before the epilogue itself can overwrite `$?`.
    "$global:LASTEXITCODE = 0",
    command,
    "$__stella_command_succeeded = $?",
    "$__stella_native_exit = $global:LASTEXITCODE",
    "if ($__stella_command_succeeded) { exit 0 }",
    "if ($__stella_native_exit -ne 0) { exit $__stella_native_exit }",
    "exit 1",
  ].join("\n");

export const resolveShellLaunch = (
  command: string,
  options: ShellLaunchOptions = {},
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  detection: ShellDetectionOptions = {},
): ResolvedShellLaunch | { error: string } => {
  if (platform !== "win32") {
    const requestedShell = options.shell?.trim();
    const shell =
      requestedShell || resolveDefaultShell(platform, environment, detection);
    if (!isPowerShell(shell)) {
      return {
        shell,
        args: [options.login === false ? "-c" : "-lc", command],
      };
    }
    return {
      shell,
      args: [
        "-NoLogo",
        "-NoProfile",
        ...(options.tty ? [] : ["-NonInteractive"]),
        "-EncodedCommand",
        encodePowerShellCommand(withPowerShellExitPropagation(command)),
      ],
    };
  }

  const shell =
    options.shell?.trim() ||
    resolveDefaultShell(platform, environment, detection);
  if (isPowerShell(shell)) {
    // `-EncodedCommand` avoids routing PowerShell source through the native
    // Windows argv quoting rules at all. PowerShell requires UTF-16LE here.
    return {
      shell,
      args: [
        "-NoLogo",
        "-NoProfile",
        ...(options.tty ? [] : ["-NonInteractive"]),
        "-EncodedCommand",
        encodePowerShellCommand(withPowerShellExitPropagation(command)),
      ],
    };
  }

  if (!isWindowsCmdShell(shell)) {
    // Git Bash and other Unix-style shells available on Windows use the same
    // command flags as their Unix counterparts, not cmd.exe's `/d /s /c`.
    return {
      shell,
      args: [options.login === false ? "-c" : "-lc", command],
    };
  }

  return {
    shell,
    // Match Node's own `shell: true` cmd.exe contract: `/s` expects the whole
    // source string to have one outer quote pair, while verbatim arguments
    // preserve every quote inside that source for cmd's parser.
    args: ["/d", "/s", "/c", `"${command}"`],
    windowsVerbatimArguments: true,
  };
};

const resolveStateShellLaunch = (
  command: string,
  state: ShellState,
  options: ShellLaunchOptions,
): ResolvedShellLaunch | { error: string } => {
  const selectedShell =
    options.shell?.trim() || resolveDefaultShell(process.platform, process.env);
  const shellCommand = buildShellCommand(
    command,
    state,
    process.platform,
    selectedShell,
  );
  return resolveShellLaunch(shellCommand, {
    ...options,
    shell: selectedShell,
  });
};

const describeShellSpawnFailure = (
  error: Error,
  launch: ResolvedShellLaunch,
  cwd: string,
  options: ShellLaunchOptions,
  runner = "node:child_process.spawn",
): string => {
  const requestedShell = options.shell?.trim() || "platform-default";
  const login = options.login !== false;
  return [
    "Failed to start exec_command shell.",
    `runner=${runner} namespace=runtime-worker platform=${process.platform} runtime_pid=${process.pid}`,
    `executable=${JSON.stringify(launch.shell)} requested_shell=${JSON.stringify(requestedShell)} login=${login} tty=${options.tty === true}`,
    `cwd=${JSON.stringify(cwd)}`,
    `cause=${error.name}: ${error.message}`,
  ].join("\n");
};

type SpawnedShell = ReturnType<typeof spawn>;

type SpawnedPtyShell = {
  process: Bun.Subprocess;
  terminal: Bun.Terminal;
  write: (chars: string) => Promise<void>;
  resize: (cols: number, rows: number) => void;
  close: () => void;
};

type ShellOutputDelta = {
  text: string;
  cursorStart: number;
  cursorEnd: number;
};

export const resolveExecOutputTokens = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : DEFAULT_EXEC_OUTPUT_TOKENS;

const invalidExecOutputTokens = (value: unknown): boolean =>
  value !== undefined &&
  value !== null &&
  (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0);

type DrainedOutput = {
  text: string;
  originalLength: number;
  rawOmittedBytes: number;
  presentationOmittedBytes: number;
  cursorStart: number;
  cursorEnd: number;
  receiptKind: "stream_delta" | "terminal" | "interaction_result";
};

const drainUnreadOutput = (record: ManagedShellRecord): DrainedOutput => {
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

const notifyShellActivity = (record: ManagedShellRecord) => {
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

const shellOwnerMatchesContext = (
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
const waitForShellActivityEffect = (
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

const waitForShellUntilDeadlineEffect = (
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

type ShellInteractionLease = {
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
const acquireShellInteraction = async (
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

const settleCompletedShellEffect = (
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

const spawnShellProcess = (
  shell: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  windowsVerbatimArguments = false,
  processIdentity?: ToolProcessIdentity,
) => {
  const launch = isolateToolProcessLaunch({
    command: shell,
    commandArgs: args,
    identity: processIdentity,
  });
  return spawn(launch.command, launch.args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments,
    // On Unix, make the shell the leader of its own process group so timeouts
    // and manual kills can terminate the entire command tree.
    detached: process.platform !== "win32",
    ...(launch.nativeIdentity
      ? {
          uid: launch.nativeIdentity.uid,
          gid: launch.nativeIdentity.gid,
        }
      : {}),
  });
};

const DEFAULT_PTY_COLUMNS = 80;
const DEFAULT_PTY_ROWS = 24;
const PTY_OUTPUT_SETTLE_MS = 15;
const PTY_OUTPUT_MAX_SETTLE_MS = 100;

type PtyShellCallbacks = {
  onData: (data: string) => void;
  onExit: (
    exitCode: number | null,
    signalCode: number | null,
    error?: Error,
  ) => void;
  onTerminalExit: (exitCode: number) => void;
};

/**
 * Spawn a shell through Bun's native terminal transport. Bun maps this to
 * openpty(3) on macOS/Linux and CreatePseudoConsole (ConPTY) on Windows.
 *
 * Bun may invoke spawn callbacks before `Bun.spawn` returns, so every callback
 * crosses a microtask boundary. That guarantees startShell has installed the
 * returned transport on its managed record before lifecycle events arrive.
 */
const spawnPtyShellProcess = (
  shell: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  windowsVerbatimArguments: boolean,
  callbacks: PtyShellCallbacks,
  processIdentity?: ToolProcessIdentity,
): SpawnedPtyShell => {
  const bunRuntime = (globalThis as typeof globalThis & { Bun?: typeof Bun })
    .Bun;
  if (!bunRuntime || typeof bunRuntime.Terminal !== "function") {
    throw new Error(
      "PTY execution requires Stella's bundled Bun runtime with Bun.Terminal support.",
    );
  }

  const drainWaiters = new Set<() => void>();
  const outputDecoder = new TextDecoder();
  const terminal = new bunRuntime.Terminal({
    cols: DEFAULT_PTY_COLUMNS,
    rows: DEFAULT_PTY_ROWS,
    name: "xterm-256color",
    data: (_terminal, data) => {
      const chunk = outputDecoder.decode(data, { stream: true });
      if (chunk) queueMicrotask(() => callbacks.onData(chunk));
    },
    drain: () => {
      const waiters = [...drainWaiters];
      drainWaiters.clear();
      for (const waiter of waiters) waiter();
    },
    exit: (_terminal, exitCode) => {
      const finalChunk = outputDecoder.decode();
      queueMicrotask(() => {
        if (finalChunk) callbacks.onData(finalChunk);
        callbacks.onTerminalExit(exitCode);
      });
    },
  });

  const launch = isolateToolProcessLaunch({
    command: shell,
    commandArgs: args,
    identity: processIdentity,
  });
  let subprocess: Bun.Subprocess;
  try {
    subprocess = bunRuntime.spawn([launch.command, ...launch.args], {
      cwd,
      env: {
        ...env,
        TERM: env.TERM?.trim() || "xterm-256color",
      },
      terminal,
      windowsHide: true,
      windowsVerbatimArguments,
      detached: process.platform !== "win32",
      ...(launch.nativeIdentity
        ? {
            uid: launch.nativeIdentity.uid,
            gid: launch.nativeIdentity.gid,
          }
        : {}),
      onExit: (_subprocess, exitCode, signalCode, error) => {
        const normalizedError = error
          ? error instanceof Error
            ? error
            : new Error(String(error))
          : undefined;
        queueMicrotask(() =>
          callbacks.onExit(exitCode, signalCode, normalizedError),
        );
      },
    });
  } catch (error) {
    terminal.close();
    throw error;
  }

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    const waiters = [...drainWaiters];
    drainWaiters.clear();
    for (const waiter of waiters) waiter();
    if (!terminal.closed) terminal.close();
  };

  const write = async (chars: string): Promise<void> => {
    if (closed || terminal.closed) {
      throw new Error("PTY stdin is closed.");
    }
    const normalized =
      process.platform === "win32" ? chars.replace(/\r?\n/g, "\r") : chars;
    const bytes = new TextEncoder().encode(normalized);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = terminal.write(bytes.subarray(offset));
      if (written > 0) {
        offset += Math.min(written, bytes.byteLength - offset);
        continue;
      }
      await new Promise<void>((resolve) => {
        drainWaiters.add(resolve);
      });
      if (closed || terminal.closed) {
        throw new Error("PTY stdin closed before all input was written.");
      }
    }
  };

  const resize = (cols: number, rows: number) => terminal.resize(cols, rows);

  return { process: subprocess, terminal, write, resize, close };
};

const killShellProcess = (
  child: SpawnedShell,
  signal: NodeJS.Signals = "SIGTERM",
) => {
  const pid = child.pid;

  if (!pid) {
    return;
  }

  if (process.platform === "win32") {
    const taskkillArgs = ["/pid", String(pid), "/t"];
    if (signal === "SIGKILL") {
      taskkillArgs.push("/f");
    }

    const killer = spawn("taskkill", taskkillArgs, {
      stdio: "ignore",
      windowsHide: true,
    });

    killer.on("error", () => {
      try {
        child.kill(signal);
      } catch {
        // Ignore cleanup errors on fallback kill.
      }
    });
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Ignore cleanup errors when the child already exited.
    }
  }
};

/**
 * TERM→1s→KILL ladder. The escalation is a forked fiber racing the child's
 * `exit` event against a 1s sleep (replacing the unref'd `setTimeout`): if
 * the child is still alive at the deadline it is SIGKILLed; if it exits
 * first the fiber ends immediately. Bounded to 1s of fiber lifetime per
 * invocation, so repeated kills stay cheap and shutdown never inherits an
 * unbounded timer set.
 */
const terminateShellProcess = (child: SpawnedShell) => {
  if (child.exitCode !== null) {
    return;
  }

  killShellProcess(child, "SIGTERM");

  toolsRuntime.runFork(
    Effect.gen(function* () {
      const exited = yield* Deferred.make<void>();
      const onExit = () => {
        Deferred.doneUnsafe(exited, Effect.void);
      };
      child.once("exit", onExit);
      yield* Effect.ensuring(
        Effect.raceFirst(Effect.sleep(1_000), Deferred.await(exited)),
        Effect.sync(() => {
          child.removeListener("exit", onExit);
        }),
      );
      if (child.exitCode === null) {
        killShellProcess(child, "SIGKILL");
      }
    }),
  );
};

const killPtyShellProcess = (
  pty: SpawnedPtyShell,
  signal: NodeJS.Signals = "SIGTERM",
) => {
  const pid = pty.process.pid;
  if (!pid || pty.process.exitCode !== null) return;

  if (process.platform === "win32") {
    const taskkillArgs = ["/pid", String(pid), "/t"];
    if (signal === "SIGKILL") taskkillArgs.push("/f");
    const killer = spawn("taskkill", taskkillArgs, {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => {
      try {
        pty.process.kill(signal);
      } catch {
        // The ConPTY child may already have exited.
      }
    });
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      pty.process.kill(signal);
    } catch {
      // The PTY process may already have exited.
    }
  }
};

const terminatePtyShellProcess = (pty: SpawnedPtyShell) => {
  if (pty.process.exitCode !== null) {
    pty.close();
    return;
  }
  // On pre-24H2 Windows, ClosePseudoConsole can block while a live child is
  // flushing. Kill the process first and close the terminal only after exit.
  killPtyShellProcess(pty, "SIGTERM");
  const forceKillTimer = setTimeout(() => {
    if (pty.process.exitCode === null) {
      killPtyShellProcess(pty, "SIGKILL");
    }
  }, 1_000);
  forceKillTimer.unref?.();
};

const shouldUseStellaComputer = (command: string): boolean =>
  /\bstella-computer\b/.test(command);

const shouldUseStellaMedia = (command: string): boolean =>
  /\bstella-media\b/.test(command);

const shouldUseStellaXApi = (command: string): boolean =>
  /\bstella-x-api\b/.test(command);

const pathInside = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};

/** Validate the trusted host's child credential drop before any spawn. */
export const resolveToolProcessIdentity = (
  context?: ToolContext,
  platform: NodeJS.Platform = process.platform,
): ToolProcessIdentity | undefined => {
  const identity = context?.toolProcessIdentity;
  if (!identity) return undefined;
  if (platform === "win32") {
    throw new Error("Tool process identity is available only on POSIX hosts.");
  }
  if (
    !Number.isSafeInteger(identity.uid) ||
    identity.uid <= 0 ||
    identity.uid > 2_147_483_647 ||
    !Number.isSafeInteger(identity.gid) ||
    identity.gid <= 0 ||
    identity.gid > 2_147_483_647 ||
    !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(identity.user)
  ) {
    throw new Error("Tool process identity is invalid or privileged.");
  }
  const workspaceRoot = context?.toolWorkspaceRoot?.trim();
  if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
    throw new Error(
      "Tool process identity requires an absolute workspace boundary.",
    );
  }
  const home = path.resolve(identity.home);
  const roots = [workspaceRoot, context?.stellaDataDir]
    .filter((candidate): candidate is string => Boolean(candidate?.trim()))
    .map((candidate) => path.resolve(candidate));
  if (
    !path.isAbsolute(identity.home) ||
    !roots.some((root) => pathInside(home, root))
  ) {
    throw new Error(
      "Tool process home must stay inside the workspace or its trusted tool-state directory.",
    );
  }
  return { ...identity, home };
};

export const startShell = (
  state: ShellState,
  command: string,
  cwd: string,
  envOverrides?: Record<string, string>,
  onClose?: () => void,
  startSnapshot?: FileSnapshot | null,
  externalCandidateSnapshots?: ExternalCandidateSnapshot[],
  onActivity?: (record: ManagedShellRecord, delta?: ShellOutputDelta) => void,
  launchOptions: ShellLaunchOptions = {},
  producedFileLimit: number = MAX_PRODUCED_FILES_PER_COMMAND,
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
      startSnapshot,
      externalCandidateSnapshots,
      producedFileLimit,
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
    startSnapshot,
    externalCandidateSnapshots,
    producedFileLimit,
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
 * Joined, bounded teardown of every managed shell. `kill()` alone only
 * *starts* the TERM→1s→KILL ladders — a worker that exits right after would
 * strand TERM-ignoring children as orphans. This joins every running
 * shell's actual exit latch in parallel under a single 3s bound
 * (comfortably past the ladder); anything still alive at the bound is
 * logged and left to the OS, as the ladder's KILL already fired.
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
      for (const record of state.shells.values()) {
        if (record.running) {
          record.kill();
        }
      }
      if (pending.length === 0) {
        return;
      }
      const joined = yield* Effect.raceFirst(
        Effect.forEach(pending, (record) => Deferred.await(record.exitLatch), {
          concurrency: "unbounded",
          discard: true,
        }).pipe(Effect.as("joined" as const)),
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

export const runShell = async (
  state: ShellState,
  command: string,
  cwd: string,
  timeoutMs: number,
  envOverrides?: Record<string, string>,
  launchOptions: ShellLaunchOptions = {},
  processIdentity?: ToolProcessIdentity,
) => {
  maybeSweepDeferredDeletes(state);
  const launch = resolveStateShellLaunch(command, state, launchOptions);

  if ("error" in launch) {
    return launch.error;
  }

  type RunShellSettled =
    | { type: "close"; code: number | null }
    | { type: "error"; error: Error }
    | { type: "timeout" };

  return runToolEffect(
    Effect.scoped(
      Effect.gen(function* () {
        let output = "";
        let processSettled = false;
        const settledLatch = yield* Deferred.make<RunShellSettled>();
        // The spawned shell is a scoped resource: if the process has not
        // settled (close/error) when the scope closes — the timeout path,
        // or an interruption — the release finalizer runs the TERM→1s→KILL
        // ladder, exactly where the legacy timeout branch killed it.
        // A synchronous spawn throw (e.g. posix_spawn failure) must route
        // through the same diagnostic as the managed path rather than escaping
        // as an unhandled defect. Spawn eagerly so a throw returns the
        // diagnostic output; hand the live child to acquireRelease so the
        // scoped TERM->1s->KILL finalizer still owns its lifecycle.
        let spawnedChild: ReturnType<typeof spawnShellProcess>;
        try {
          spawnedChild = spawnShellProcess(
            launch.shell,
            launch.args,
            cwd,
            buildShellEnv(envOverrides, state, launchOptions.tty === true),
            launch.windowsVerbatimArguments,
            processIdentity,
          );
        } catch (error) {
          return describeShellSpawnFailure(
            error instanceof Error ? error : new Error(String(error)),
            launch,
            cwd,
            launchOptions,
          );
        }
        const child = yield* Effect.acquireRelease(
          Effect.sync(() => spawnedChild),
          (spawned) =>
            Effect.sync(() => {
              if (!processSettled) {
                terminateShellProcess(spawned);
              }
            }),
        );

        const stdoutDecoder = new StringDecoder("utf8");
        const stderrDecoder = new StringDecoder("utf8");
        const append = (decoder: StringDecoder, data: Buffer) => {
          output = truncate(`${output}${decoder.write(data)}`);
        };
        child.stdout.on("data", (data: Buffer) => append(stdoutDecoder, data));
        child.stderr.on("data", (data: Buffer) => append(stderrDecoder, data));
        child.stdout.on("end", () => {
          output = truncate(`${output}${stdoutDecoder.end()}`);
        });
        child.stderr.on("end", () => {
          output = truncate(`${output}${stderrDecoder.end()}`);
        });
        child.on("close", (code) => {
          processSettled = true;
          Deferred.doneUnsafe(
            settledLatch,
            Effect.succeed<RunShellSettled>({
              type: "close",
              code: code ?? null,
            }),
          );
        });
        child.on("error", (error) => {
          processSettled = true;
          Deferred.doneUnsafe(
            settledLatch,
            Effect.succeed<RunShellSettled>({ type: "error", error }),
          );
        });

        const settled = yield* Effect.raceFirst(
          Deferred.await(settledLatch),
          Effect.sleep(timeoutMs).pipe(
            Effect.as<RunShellSettled>({ type: "timeout" }),
          ),
        );
        if (settled.type === "timeout") {
          return `Command timed out after ${timeoutMs}ms.\n\n${truncate(output)}`;
        }
        if (settled.type === "error") {
          return describeShellSpawnFailure(
            settled.error,
            launch,
            cwd,
            launchOptions,
          );
        }
        // Clean Windows console noise (chcp output) that confuses LLMs
        const cleanedOutput = sanitizeToolVisibleText(output)
          .replace(/^Active code page: \d+\s*/gm, "")
          .replace(/^\s+/, ""); // Trim leading whitespace after removal
        if (settled.code === 0) {
          return cleanedOutput || "Command completed successfully (no output).";
        }
        return `Command exited with code ${settled.code}.\n\n${truncate(cleanedOutput)}`;
      }),
    ),
  );
};

const resolveManagedShellCommand = (
  state: ShellState,
  args: Record<string, unknown>,
  context?: ToolContext,
): {
  command: string;
  cwd: string;
  envOverrides: Record<string, string>;
  launchOptions: ShellLaunchOptions;
  processIdentity?: ToolProcessIdentity;
} => {
  const command = String(args.cmd ?? args.command ?? "");
  const explicitCwd = args.workdir ?? args.working_directory;
  let cwd =
    explicitCwd !== undefined && explicitCwd !== null
      ? String(explicitCwd)
      : resolveToolFallbackCwd(
          context?.toolWorkspaceRoot ?? context?.stellaAppDir,
        );
  if (context?.storageMode === "cloud") {
    const workspaceRoot = context.toolWorkspaceRoot?.trim();
    if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
      throw new Error("Cloud shell commands require a workspace boundary.");
    }
    const lexicalRoot = path.resolve(workspaceRoot);
    const lexicalCwd = path.resolve(cwd);
    if (!pathInside(lexicalCwd, lexicalRoot)) {
      throw new Error("Cloud shell workdir must stay inside the workspace.");
    }
    let canonicalRoot: string;
    let canonicalCwd: string;
    try {
      canonicalRoot = realpathSync.native(lexicalRoot);
      canonicalCwd = realpathSync.native(lexicalCwd);
    } catch {
      throw new Error("Cloud shell workdir must be an existing real directory.");
    }
    if (
      canonicalRoot !== lexicalRoot ||
      canonicalCwd !== lexicalCwd ||
      !pathInside(canonicalCwd, canonicalRoot)
    ) {
      throw new Error(
        "Cloud shell workdir must be canonical and contain no symbolic links.",
      );
    }
    cwd = canonicalCwd;
  }
  const envOverrides: Record<string, string> = {};
  const processIdentity = resolveToolProcessIdentity(context);
  if (processIdentity) {
    envOverrides.HOME = processIdentity.home;
    envOverrides.USER = processIdentity.user;
    envOverrides.LOGNAME = processIdentity.user;
    envOverrides.XDG_CONFIG_HOME = path.join(processIdentity.home, ".config");
    envOverrides.XDG_CACHE_HOME = path.join(processIdentity.home, ".cache");
    envOverrides.XDG_STATE_HOME = path.join(
      processIdentity.home,
      ".local",
      "state",
    );
  }
  const stellaComputerSessionId = getStellaComputerSessionId(context);
  const localBinPaths = [
    ...(context?.stellaDataDir
      ? [path.join(path.resolve(context.stellaDataDir), "bin")]
      : []),
    path.join(path.resolve(cwd), "node_modules", ".bin"),
    ...(context?.stellaAppDir
      ? [path.join(path.resolve(context.stellaAppDir), "node_modules", ".bin")]
      : []),
  ].filter(
    (entry, index, entries) =>
      existsSync(entry) && entries.indexOf(entry) === index,
  );

  if (localBinPaths.length > 0) {
    envOverrides.PATH = [...localBinPaths, process.env.PATH ?? ""]
      .filter(Boolean)
      .join(path.delimiter);
  }

  if (shouldUseStellaComputer(command) && stellaComputerSessionId) {
    envOverrides.STELLA_COMPUTER_SESSION = stellaComputerSessionId;
  }

  if (shouldUseStellaMedia(command)) {
    const siteAuth = state.getStellaSiteAuth?.();
    if (siteAuth) {
      envOverrides.STELLA_MEDIA_BASE_URL = siteAuth.baseUrl;
      envOverrides.STELLA_MEDIA_AUTH_TOKEN = siteAuth.authToken;
    }
    if (context?.deviceId) {
      envOverrides.STELLA_DEVICE_ID = context.deviceId;
    }
  }

  if (shouldUseStellaXApi(command)) {
    const siteAuth = state.getStellaSiteAuth?.();
    if (siteAuth) {
      envOverrides.STELLA_X_API_BASE_URL = siteAuth.baseUrl;
      envOverrides.STELLA_X_API_AUTH_TOKEN = siteAuth.authToken;
    }
  }

  const requestedShell =
    typeof args.shell === "string" && args.shell.trim()
      ? args.shell.trim()
      : undefined;
  return {
    command,
    cwd,
    envOverrides,
    ...(processIdentity ? { processIdentity } : {}),
    launchOptions: {
      ...(requestedShell ? { shell: requestedShell } : {}),
      login: args.login !== false,
      tty: args.tty === true,
    },
  };
};

const resolveExecYieldTime = (
  value: unknown,
  defaultMs: number = DEFAULT_EXEC_YIELD_MS,
  maxMs: number = MAX_EXEC_YIELD_MS,
): number => {
  const raw =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : defaultMs;
  return Math.max(0, Math.min(raw, maxMs));
};

type ExecDeadlineOutcome<T> =
  | { status: "completed"; value: T }
  | { status: "failed"; error: unknown }
  | { status: "deadline" }
  | { status: "aborted"; error: unknown };

const runUntilDuration = async <T>(
  operation: () => Promise<T>,
  remainingMs: number,
  signal?: AbortSignal,
): Promise<ExecDeadlineOutcome<T>> => {
  if (signal?.aborted) {
    return { status: "aborted", error: signal.reason ?? new Error("Aborted") };
  }
  if (remainingMs <= 0) return { status: "deadline" };
  return await runToolEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const abortLatch = yield* acquireAbortLatch(signal);
        const operationOutcome = Effect.tryPromise({
          try: operation,
          catch: (error) => error,
        }).pipe(
          Effect.match({
            onFailure: (error): ExecDeadlineOutcome<T> => ({
              status: "failed",
              error,
            }),
            onSuccess: (value): ExecDeadlineOutcome<T> => ({
              status: "completed",
              value,
            }),
          }),
        );
        const deadlineOutcome = Effect.sleep(remainingMs).pipe(
          Effect.as<ExecDeadlineOutcome<T>>({ status: "deadline" }),
        );
        const abortOutcome = Deferred.await(abortLatch).pipe(
          Effect.map(
            (reason): ExecDeadlineOutcome<T> => ({
              status: "aborted",
              error: reason ?? new Error("Aborted"),
            }),
          ),
        );
        return yield* Effect.raceFirst(
          Effect.raceFirst(operationOutcome, deadlineOutcome),
          abortOutcome,
        );
      }),
    ),
  );
};

const runUntilExecDeadline = async <T>(
  operation: () => Promise<T>,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<ExecDeadlineOutcome<T>> =>
  runUntilDuration(operation, deadlineAt - Date.now(), signal);

const toolErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

type ShellInteractionOperation =
  | "exec"
  | "write"
  | "poll"
  | "terminate"
  | "close_stdin"
  | "resize";

type ShellInteractionReceipt = {
  operation: ShellInteractionOperation;
  write_id?: string;
  write_deduplicated?: boolean;
  terminal_size?: { cols: number; rows: number };
};

type ExecToolPayload = {
  session_id: string | null;
  /** Stable provenance even after `session_id` becomes non-pollable/null. */
  shell_session_id: string;
  worker_generation: string;
  session_owner?: ShellSessionOwner;
  interaction_sequence: number;
  chunk_id: string;
  output_cursor: number;
  operation: ShellInteractionOperation;
  write_id?: string;
  write_deduplicated?: boolean;
  terminal_size?: { cols: number; rows: number };
  running: boolean;
  exit_code: number | null;
  output: string;
  wall_time_seconds: number;
  original_token_count: number;
  cwd: string;
  command: string;
  hint?: string;
  produced_files_omitted?: ProducedFilesOmission;
};

const buildExecToolPayload = (
  state: ShellState,
  record: ManagedShellRecord,
  drained: DrainedOutput,
  callStartedAt: number,
  interactionReceipt?: ShellInteractionReceipt,
): ExecToolPayload => {
  const wallTimeSeconds = (Date.now() - callStartedAt) / 1000;
  const chunkSequence = record.chunkSequence + 1;
  record.chunkSequence = chunkSequence;
  const receipt = interactionReceipt ??
    record.activeInteractionReceipt ?? { operation: "exec" };
  // Includes wall_time_seconds and original_token_count so the model can
  // detect output omitted by the raw one-MiB collector and react.
  const payload: ExecToolPayload = {
    session_id: record.running ? record.id : null,
    shell_session_id: record.id,
    worker_generation: state.workerGeneration,
    ...(record.owner ? { session_owner: record.owner } : {}),
    interaction_sequence:
      record.activeInteractionSequence ?? record.interactionSequence,
    chunk_id: `${state.workerGeneration}:${record.id}:${chunkSequence}`,
    output_cursor: drained.cursorEnd,
    ...receipt,
    running: record.running,
    exit_code: record.running ? null : record.exitCode,
    output: sanitizeToolVisibleText(drained.text),
    wall_time_seconds: wallTimeSeconds,
    // Always report the pre-collection-cap token estimate so callers can
    // distinguish small output from output whose middle was omitted.
    original_token_count: Math.ceil(
      drained.originalLength / APPROX_BYTES_PER_TOKEN,
    ),
    cwd: record.cwd,
    command: record.command,
  };
  if (!record.running && record.exitCode !== 0) {
    const hint = getTerminalRecoveryHint({
      command: record.command,
      exitCode: record.exitCode,
      output: drained.text,
    });
    if (hint) payload.hint = hint;
  }
  return payload;
};

const buildExecToolDetails = (
  payload: ExecToolPayload,
  drained: DrainedOutput,
) => {
  const { output: _modelOutput, ...metadata } = payload;
  return {
    ...metadata,
    original_output_bytes: drained.originalLength,
    raw_output_omitted_bytes: drained.rawOmittedBytes,
    raw_output_truncated: drained.rawOmittedBytes > 0,
    presentation_output_omitted_bytes: drained.presentationOmittedBytes,
    presentation_output_truncated: drained.presentationOmittedBytes > 0,
    chunk_receipt: {
      kind: drained.receiptKind,
      start_byte: drained.cursorStart,
      end_byte: drained.cursorEnd,
      next_cursor: drained.cursorEnd,
      operation: payload.operation,
      ...(payload.write_id ? { write_id: payload.write_id } : {}),
      ...(payload.write_deduplicated !== undefined
        ? { write_deduplicated: payload.write_deduplicated }
        : {}),
      ...(payload.terminal_size
        ? { terminal_size: payload.terminal_size }
        : {}),
    },
  };
};

const formatExecToolResult = (
  payload: ExecToolPayload,
  drained: DrainedOutput,
): string => {
  const status = payload.running
    ? `Process running with session ID ${payload.session_id}`
    : `Process exited with code ${payload.exit_code ?? "unknown"}`;
  return [
    `Wall time: ${payload.wall_time_seconds.toFixed(4)} seconds`,
    status,
    `Original token count: ${payload.original_token_count}`,
    ...(drained.rawOmittedBytes > 0
      ? [
          `Raw process output exceeded the 1 MiB collection cap; ${drained.rawOmittedBytes} omitted bytes remain marked in Output.`,
        ]
      : []),
    ...(drained.presentationOmittedBytes > 0
      ? [
          `This update was limited to ${EXEC_UPDATE_MAX_BYTES} presentation bytes; ${drained.presentationOmittedBytes} bytes remain available in the final interaction result.`,
        ]
      : []),
    "Output:",
    payload.output,
    ...(payload.hint ? [`Hint: ${payload.hint}`] : []),
  ].join("\n");
};

const boundedUpdateOutput = (delta: ShellOutputDelta): DrainedOutput => {
  const buffer = new HeadTailOutputBuffer(EXEC_UPDATE_MAX_BYTES);
  buffer.pushText(delta.text);
  const bounded = buffer.snapshot();
  return {
    text: bounded.text,
    originalLength: delta.cursorEnd - delta.cursorStart,
    rawOmittedBytes: 0,
    presentationOmittedBytes: bounded.omittedBytes,
    cursorStart: delta.cursorStart,
    cursorEnd: delta.cursorEnd,
    receiptKind: "stream_delta",
  };
};

const terminalUpdateOutput = (record: ManagedShellRecord): DrainedOutput => ({
  text: "",
  originalLength: 0,
  rawOmittedBytes: 0,
  presentationOmittedBytes: 0,
  cursorStart: record.outputCursorBytes,
  cursorEnd: record.outputCursorBytes,
  receiptKind: "terminal",
});

const writeToShellStdin = async (
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

const closeShellStdin = async (record: ManagedShellRecord): Promise<void> => {
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

const resizeShellPty = (
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

const resolveWriteStdinOperation = (
  value: unknown,
  chars: string,
): ShellInteractionOperation | undefined => {
  if (value === undefined || value === null || value === "") {
    return chars ? "write" : "poll";
  }
  return typeof value === "string" &&
    ["write", "poll", "terminate", "close_stdin", "resize"].includes(value)
    ? (value as ShellInteractionOperation)
    : undefined;
};

const writeFingerprint = (chars: string): string =>
  createHash("sha256").update(chars, "utf8").digest("hex");

const pruneAcceptedWriteIds = (
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

const recordAcceptedWriteId = (
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

export const handleExecCommand = async (
  state: ShellState,
  args: Record<string, unknown>,
  context?: ToolContext,
  signal?: AbortSignal,
  onUpdate?: ToolUpdateCallback,
): Promise<ToolResult> => {
  const callStartedAt = Date.now();
  if (invalidExecOutputTokens(args.max_output_tokens)) {
    return { error: "max_output_tokens must be a non-negative safe integer." };
  }
  const modelOutputTokens = resolveExecOutputTokens(args.max_output_tokens);
  const yieldTimeMs = resolveExecYieldTime(
    args.yield_time_ms,
    DEFAULT_EXEC_YIELD_MS,
  );
  const deadlineAt = callStartedAt + yieldTimeMs;
  if (signal?.aborted) {
    return { error: toolErrorMessage(signal.reason ?? new Error("Aborted")) };
  }
  const prepared = resolveManagedShellCommand(state, args, context);
  const dangerReason = isDangerousCommand(prepared.command, prepared.cwd);
  if (dangerReason) {
    return {
      error: `Command blocked: this operation is potentially destructive and has been denied for safety. (${dangerReason})`,
    };
  }
  if (!prepared.command.trim()) {
    return { error: "cmd is required." };
  }
  let beforeSideEffects: {
    rootSnapshot: FileSnapshot | null;
    externalCandidateSnapshots?: ExternalCandidateSnapshot[];
  } = { rootSnapshot: null };
  if (shouldSnapshotShellSideEffects(prepared.command)) {
    const snapshotBudget = createSnapshotBudget(deadlineAt, signal);
    beforeSideEffects = await snapshotShellSideEffects(
      { cmd: prepared.command, workdir: prepared.cwd },
      resolveShellSnapshotRoot(prepared.cwd, context),
      context,
      snapshotBudget,
    );
    const interruption = readSnapshotBudgetInterruption(snapshotBudget);
    if (interruption?.kind === "aborted") {
      return { error: toolErrorMessage(interruption.error) };
    }
    if (interruption?.kind === "deadline") {
      // Produced-file tracking is best effort. Once its budget is exhausted,
      // start the requested process immediately so the caller still receives
      // a session id by the advertised yield deadline.
    }
  }
  let emittedUpdateChunks = 0;
  const emitOneUpdate = (
    record: ManagedShellRecord,
    drained: DrainedOutput,
  ) => {
    if (!onUpdate) return;
    if (emittedUpdateChunks >= MAX_EXEC_UPDATE_CHUNKS) return;
    emittedUpdateChunks += 1;
    const payload = buildExecToolPayload(state, record, drained, callStartedAt);
    try {
      onUpdate({
        result: formatExecToolResult(payload, drained),
        details: buildExecToolDetails(payload, drained),
        modelOutputTokens,
      });
    } catch {
      // Progress consumers must not break process I/O or teardown.
    }
  };
  const emitUpdate = (record: ManagedShellRecord, delta?: ShellOutputDelta) => {
    if (!onUpdate) return;
    if (!delta) {
      if (!record.running) emitOneUpdate(record, terminalUpdateOutput(record));
      return;
    }
    let cursorStart = delta.cursorStart;
    for (const text of splitUtf8TextByBytes(
      delta.text,
      EXEC_UPDATE_MAX_BYTES,
    )) {
      const cursorEnd = cursorStart + Buffer.byteLength(text, "utf8");
      emitOneUpdate(
        record,
        boundedUpdateOutput({ text, cursorStart, cursorEnd }),
      );
      cursorStart = cursorEnd;
    }
  };
  const record = startShell(
    state,
    prepared.command,
    prepared.cwd,
    prepared.envOverrides,
    undefined,
    beforeSideEffects.rootSnapshot,
    beforeSideEffects.externalCandidateSnapshots,
    emitUpdate,
    prepared.launchOptions,
    resolveProducedFileLimit(context),
    prepared.processIdentity,
  );
  setShellOwner(record, context);
  let interaction: ShellInteractionLease;
  try {
    interaction = await acquireShellInteraction(state, record, signal);
  } catch (error) {
    if (record.running) {
      try {
        record.kill();
      } catch {
        // Best effort; the process may already be exiting.
      }
    }
    return { error: toolErrorMessage(error) };
  }
  try {
    try {
      // Keep collecting until exit or the advertised deadline. Progress is
      // delivered as deltas meanwhile, so chatty jobs do not force repeated
      // model-driven polls merely because their first byte arrived quickly.
      await runToolEffect(
        Effect.scoped(
          Effect.gen(function* () {
            // This call started the shell, so until the session id reaches the
            // model the process is run-owned. An interrupted/failed initial
            // window must not leave a hidden orphan. Later write_stdin calls
            // deliberately omit this finalizer because their session id was
            // already delivered and is conversation-scoped.
            yield* Effect.acquireRelease(Effect.void, (_, exit) =>
              Effect.sync(() => {
                if (Exit.isFailure(exit) && record.running) {
                  try {
                    record.kill();
                  } catch {
                    // Best effort; the process may already be exiting.
                  }
                }
              }),
            );
            yield* waitForShellUntilDeadlineEffect(record, deadlineAt, signal);
            yield* settleCompletedShellEffect(record, signal, deadlineAt);
          }),
        ),
      );
    } catch (error) {
      return { error: toolErrorMessage(error) };
    }

    const drained = drainUnreadOutput(record);
    const payload = buildExecToolPayload(state, record, drained, callStartedAt);
    let produced: ProducedFilesOutcome = {};
    if (!record.running) {
      try {
        produced = await takeCompletedProducedFiles(record, signal, deadlineAt);
      } catch (error) {
        return { error: toolErrorMessage(error) };
      }
    }
    // Also expose withholding on the model-visible payload. The agent is the
    // component that can tell the user the files remain in the workspace.
    if (produced.producedFilesOmitted) {
      payload.produced_files_omitted = produced.producedFilesOmitted;
    }
    return {
      result: formatExecToolResult(payload, drained),
      details: buildExecToolDetails(payload, drained),
      modelOutputTokens,
      ...produced,
    };
  } finally {
    interaction.release();
  }
};

export const handleWriteStdin = async (
  state: ShellState,
  args: Record<string, unknown>,
  context?: ToolContext,
  signal?: AbortSignal,
): Promise<ToolResult> => {
  const callStartedAt = Date.now();
  if (invalidExecOutputTokens(args.max_output_tokens)) {
    return { error: "max_output_tokens must be a non-negative safe integer." };
  }
  const modelOutputTokens = resolveExecOutputTokens(args.max_output_tokens);
  const sessionId = String(args.session_id ?? "").trim();
  if (!sessionId) {
    return { error: "session_id is required." };
  }
  if (
    args.write_id !== undefined &&
    args.write_id !== null &&
    typeof args.write_id !== "string"
  ) {
    return { error: "write_id must be a string when provided." };
  }
  const writeId =
    typeof args.write_id === "string" ? args.write_id.trim() : undefined;
  if (typeof args.write_id === "string" && !writeId) {
    return { error: "write_id must not be empty." };
  }
  if (writeId && writeId.length > 256) {
    return { error: "write_id must be at most 256 characters." };
  }
  const chars = typeof args.chars === "string" ? args.chars : "";
  const operation = resolveWriteStdinOperation(args.operation, chars);
  if (!operation || operation === "exec") {
    return {
      error:
        "operation must be one of write, poll, terminate, close_stdin, or resize.",
    };
  }
  if (operation !== "write" && chars) {
    return { error: `chars is only valid with the write operation.` };
  }
  if (writeId && operation !== "write") {
    return { error: "write_id is only valid with the write operation." };
  }
  const cols = Number(args.cols);
  const rows = Number(args.rows);
  if (
    operation === "resize" &&
    (!Number.isSafeInteger(cols) ||
      !Number.isSafeInteger(rows) ||
      cols < 1 ||
      rows < 1 ||
      cols > 1_000 ||
      rows > 1_000)
  ) {
    return {
      error: "resize requires integer cols and rows between 1 and 1000.",
    };
  }
  const interactionYieldTimeMs =
    operation === "poll"
      ? resolveExecYieldTime(
          args.yield_time_ms,
          DEFAULT_EMPTY_POLL_YIELD_MS,
          MAX_EMPTY_POLL_YIELD_MS,
        )
      : resolveExecYieldTime(args.yield_time_ms, DEFAULT_WRITE_STDIN_YIELD_MS);
  const passivePollDeadlineAt = callStartedAt + interactionYieldTimeMs;
  cleanupShellSessions(state);
  const record = state.shells.get(sessionId);
  if (!record || !shellOwnerMatchesContext(record.owner, context)) {
    const pruned = state.prunedSessions.get(sessionId);
    const known = [...state.shells.values()]
      .filter((entry) => shellOwnerMatchesContext(entry.owner, context))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 5)
      .map(
        (entry) =>
          `${entry.id}${entry.running ? " (running)" : " (completed)"}`,
      );
    return {
      error:
        pruned && shellOwnerMatchesContext(pruned.owner, context)
          ? `Session ${sessionId} completed with exit code ${pruned.exitCode ?? "unknown"} and was pruned from runtime worker generation ${state.workerGeneration}.`
          : `Session not found in runtime worker generation ${state.workerGeneration} (runtime_pid=${process.pid}): ${sessionId}.${known.length > 0 ? ` Recent sessions: ${known.join(", ")}.` : " No sessions are registered; the runtime may have restarted or the id may belong to an earlier worker generation."}`,
    };
  }

  // A passive poll must not reserve the mutation queue while it waits for the
  // very write that can wake it. Retain the record against pruning, wait
  // outside the FIFO, then acquire the lease only for the atomic drain and
  // receipt. Writes/resize/close/terminate remain fully serialized.
  let releasePassivePollRetention: (() => void) | undefined;
  if (
    operation === "poll" &&
    record.outputCursorBytes === record.unreadCursorStart
  ) {
    record.pendingInteractions += 1;
    let released = false;
    releasePassivePollRetention = () => {
      if (released) return;
      released = true;
      record.pendingInteractions -= 1;
      pruneCompletedShellSessions(state);
    };
    try {
      await runToolEffect(
        waitForShellActivityEffect(
          record,
          record.outputVersion,
          Math.max(0, passivePollDeadlineAt - Date.now()),
          signal,
        ),
      );
    } catch (error) {
      releasePassivePollRetention();
      return { error: toolErrorMessage(error) };
    }
  }

  let interaction: ShellInteractionLease;
  try {
    interaction = await acquireShellInteraction(state, record, signal);
  } catch (error) {
    releasePassivePollRetention?.();
    return { error: toolErrorMessage(error) };
  }
  releasePassivePollRetention?.();
  const interactionDeadlineAt =
    operation === "poll"
      ? passivePollDeadlineAt
      : Date.now() + interactionYieldTimeMs;
  const receipt: ShellInteractionReceipt = {
    operation,
    ...(writeId ? { write_id: writeId } : {}),
    ...(operation === "resize" ? { terminal_size: { cols, rows } } : {}),
  };
  record.activeInteractionReceipt = receipt;
  try {
    let deduplicated = false;
    if (operation === "write" && writeId) {
      pruneAcceptedWriteIds(record);
      const fingerprint = writeFingerprint(chars);
      const accepted = record.acceptedWriteIds.get(writeId);
      if (accepted && accepted.fingerprint !== fingerprint) {
        return {
          error: `write_id ${JSON.stringify(writeId)} was already accepted with different characters for session ${sessionId}.`,
        };
      }
      deduplicated = Boolean(accepted);
      receipt.write_deduplicated = deduplicated;
      if (accepted) {
        recordAcceptedWriteId(record, writeId, accepted.fingerprint);
      }
    }

    try {
      if (operation === "write" && !deduplicated) {
        await writeToShellStdin(record, chars);
        if (writeId) {
          recordAcceptedWriteId(record, writeId, writeFingerprint(chars));
        }
      } else if (operation === "terminate" && record.running) {
        record.kill();
      } else if (operation === "close_stdin") {
        await closeShellStdin(record);
      } else if (operation === "resize") {
        resizeShellPty(record, cols, rows);
      }
    } catch (error) {
      if (record.running || operation !== "write") {
        return { error: toolErrorMessage(error) };
      }
    }

    try {
      if (operation !== "poll") {
        await runToolEffect(
          Effect.gen(function* () {
            yield* waitForShellUntilDeadlineEffect(
              record,
              interactionDeadlineAt,
              signal,
            );
            // Preserve the short post-yield settle window: pipe/PTY output can
            // land just after the advertised wait. The scoped abort latch is
            // still active here, so cancellation surfaces before any cursor
            // drain instead of being converted into success.
            yield* settleCompletedShellEffect(record, signal);
          }),
        );
      } else if (signal?.aborted) {
        throw signal.reason ?? new Error("Aborted");
      }
    } catch (error) {
      // A poll/write never owns the process lifecycle; cancellation releases
      // only this interaction lease and leaves the session addressable.
      return { error: toolErrorMessage(error) };
    }
    if (signal?.aborted) {
      return {
        error: toolErrorMessage(signal.reason ?? new Error("Aborted")),
      };
    }

    const drained = drainUnreadOutput(record);
    const payload = buildExecToolPayload(
      state,
      record,
      drained,
      callStartedAt,
      receipt,
    );
    let produced: ProducedFilesOutcome;
    try {
      produced = await takeCompletedProducedFiles(
        record,
        signal,
        interactionDeadlineAt,
      );
    } catch (error) {
      return { error: toolErrorMessage(error) };
    }
    if (produced.producedFilesOmitted) {
      payload.produced_files_omitted = produced.producedFilesOmitted;
    }
    return {
      result: formatExecToolResult(payload, drained),
      details: buildExecToolDetails(payload, drained),
      modelOutputTokens,
      ...produced,
    };
  } finally {
    record.activeInteractionReceipt = undefined;
    interaction.release();
  }
};

export const handleBash = async (
  state: ShellState,
  args: Record<string, unknown>,
  context?: ToolContext,
  signal?: AbortSignal,
): Promise<ToolResult> => {
  if (signal?.aborted) {
    return { error: toolErrorMessage(signal.reason ?? new Error("Aborted")) };
  }
  const prepared = resolveManagedShellCommand(state, args, context);
  const command = prepared.command;

  // Safety check: reject dangerous commands
  const dangerReason = isDangerousCommand(command, prepared.cwd);
  if (dangerReason) {
    return {
      error: `Command blocked: this operation is potentially destructive and has been denied for safety. (${dangerReason})`,
    };
  }

  const timeout = Math.min(Number(args.timeout ?? 120_000), 600_000);
  const cwd = prepared.cwd;
  const runInBackground = Boolean(args.run_in_background ?? false);
  const envOverrides = prepared.envOverrides;
  const shouldSnapshotSideEffects = shouldSnapshotShellSideEffects(command);
  const snapshotRoot = shouldSnapshotSideEffects
    ? resolveShellSnapshotRoot(cwd, context)
    : null;
  let beforeSideEffects: {
    rootSnapshot: FileSnapshot | null;
    externalCandidateSnapshots?: ExternalCandidateSnapshot[];
  } = { rootSnapshot: null };
  if (snapshotRoot) {
    const snapshotDeadlineAt =
      Date.now() +
      Math.min(PRODUCED_FILE_COLLECTION_ATTEMPT_MS, Math.max(0, timeout));
    const snapshotBudget = createSnapshotBudget(snapshotDeadlineAt, signal);
    beforeSideEffects = await snapshotShellSideEffects(
      { cmd: command, workdir: cwd },
      snapshotRoot,
      context,
      snapshotBudget,
    );
    const interruption = readSnapshotBudgetInterruption(snapshotBudget);
    if (interruption?.kind === "aborted") {
      return { error: toolErrorMessage(interruption.error) };
    }
  }

  if (runInBackground) {
    const record = startShell(
      state,
      command,
      cwd,
      envOverrides,
      undefined,
      beforeSideEffects.rootSnapshot,
      beforeSideEffects.externalCandidateSnapshots,
      undefined,
      prepared.launchOptions,
      resolveProducedFileLimit(context),
      prepared.processIdentity,
    );
    setShellOwner(record, context);
    const extracted = extractOfficePreviewRef(record.output || "");
    return {
      result: `Command running in background.\nShell ID: ${record.id}\n\n${truncate(
        extracted.cleanedOutput || "(no output yet)",
      )}`,
      ...(extracted.officePreviewRef
        ? {
            details: {
              text: `Command running in background.\nShell ID: ${record.id}\n\n${truncate(
                extracted.cleanedOutput || "(no output yet)",
              )}`,
              officePreviewRef: extracted.officePreviewRef,
            },
          }
        : {}),
    };
  }

  const output = await runShell(
    state,
    command,
    cwd,
    timeout,
    envOverrides,
    prepared.launchOptions,
    prepared.processIdentity,
  );
  let produced: ProducedFilesOutcome = {};
  if (shouldSnapshotSideEffects && snapshotRoot) {
    const snapshotDeadlineAt = Date.now() + PRODUCED_FILE_COLLECTION_ATTEMPT_MS;
    const snapshotBudget = createSnapshotBudget(snapshotDeadlineAt, signal);
    const afterRoot = await snapshotFiles(snapshotRoot, snapshotBudget);
    const external = await diffExternalCandidateSnapshots(
      beforeSideEffects.externalCandidateSnapshots,
      snapshotBudget,
    );
    const interruption = readSnapshotBudgetInterruption(snapshotBudget);
    if (interruption?.kind === "aborted") {
      return { error: toolErrorMessage(interruption.error) };
    }
    produced = mergeProducedFiles(
      resolveProducedFileLimit(context),
      diffFileSnapshots(beforeSideEffects.rootSnapshot, afterRoot),
      external.complete ? external.files : undefined,
    );
  }
  const extracted = extractOfficePreviewRef(sanitizeToolVisibleText(output));
  const text = produced.producedFilesOmitted
    ? `${truncate(extracted.cleanedOutput)}\n\n${producedFilesOmittedNotice(produced.producedFilesOmitted)}`
    : truncate(extracted.cleanedOutput);
  return {
    result: text,
    ...produced,
    ...(extracted.officePreviewRef
      ? {
          details: {
            text,
            officePreviewRef: extracted.officePreviewRef,
          },
        }
      : {}),
  };
};

export const handleShellStatus = async (
  state: ShellState,
  args: Record<string, unknown>,
  context?: ToolContext,
  signal?: AbortSignal,
): Promise<ToolResult> => {
  const snapshotDeadlineAt = Date.now() + PRODUCED_FILE_DELIVERY_WAIT_MS;
  cleanupShellSessions(state);
  const shellId = String(args.shell_id ?? "");

  // If no shell_id provided, list all active shells
  if (!shellId) {
    const shells = [...state.shells.entries()]
      .filter(([, record]) => shellOwnerMatchesContext(record.owner, context))
      .map(([id, r]) => ({
        id,
        command: r.command.slice(0, 100),
        running: r.running,
        exitCode: r.exitCode,
        elapsed: r.running
          ? `${Math.round((Date.now() - r.startedAt) / 1000)}s`
          : undefined,
      }));
    if (shells.length === 0) return { result: "No active shells." };
    return { result: JSON.stringify(shells, null, 2) };
  }

  const record = state.shells.get(shellId);
  if (!record || !shellOwnerMatchesContext(record.owner, context)) {
    return { error: `Shell not found: ${shellId}` };
  }

  const tail_lines = Number(args.tail_lines ?? 50);
  const output = sanitizeToolVisibleText(record.output || "(no output yet)");
  // Get last N lines
  const lines = output.split("\n");
  const tail = truncate(lines.slice(-tail_lines).join("\n"));

  const status = record.running ? "running" : "completed";
  const elapsed = Math.round(
    ((record.completedAt ?? Date.now()) - record.startedAt) / 1000,
  );

  let result = `Shell ${shellId}: ${status}`;
  if (!record.running) result += ` (exit code: ${record.exitCode ?? "?"})`;
  result += ` | elapsed: ${elapsed}s`;
  result += `\nCommand: ${record.command.slice(0, 200)}`;
  result += `\n\n--- Output (last ${Math.min(tail_lines, lines.length)} lines) ---\n${tail}`;

  let produced: ProducedFilesOutcome;
  try {
    produced = await takeCompletedProducedFiles(
      record,
      signal,
      snapshotDeadlineAt,
    );
  } catch (error) {
    return { error: toolErrorMessage(error) };
  }
  if (produced.producedFilesOmitted) {
    result += `\n\n${producedFilesOmittedNotice(produced.producedFilesOmitted)}`;
  }
  return {
    result,
    ...produced,
  };
};

export const handleKillShell = async (
  state: ShellState,
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<ToolResult> => {
  const shellId = String(args.shell_id ?? "");
  const record = state.shells.get(shellId);
  if (!record || !shellOwnerMatchesContext(record.owner, context)) {
    return { error: `Shell not found: ${shellId}` };
  }
  if (!record.running) {
    return {
      result: `Shell ${shellId} already completed.\nExit: ${record.exitCode ?? "?"}`,
    };
  }
  record.kill();
  return {
    result: `Killed shell ${shellId}.\n\nOutput:\n${truncate(
      sanitizeToolVisibleText(record.output),
    )}`,
  };
};
