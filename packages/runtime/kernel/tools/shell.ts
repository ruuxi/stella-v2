/**
 * Shell tools: platform shell plus `exec_command` / `write_stdin` handlers.
 */

import { spawn } from "child_process";
import path from "path";
import os from "os";
import { StringDecoder } from "node:string_decoder";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { readdir, stat } from "fs/promises";
import {
  fileChange,
  isNoiseProducedPath,
  MAX_PRODUCED_FILES_PER_COMMAND,
  type FileChangeRecord,
  type ProducedFileRecord,
} from "@stella/contracts/file-changes";
import type {
  ToolContext,
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
import { isDangerousCommand } from "./command-safety.js";
import { getStellaComputerSessionId } from "./stella-computer-session.js";
import { inferShellMentionedPaths } from "./path-inference.js";
import { isKnownSafeCommand } from "./safe-commands.js";
import { sanitizeToolVisibleText } from "./safety.js";
import type { OfficePreviewRef } from "@stella/contracts/office-preview";
import { purgeExpiredDeferredDeletes } from "./deferred-delete.js";
import { resolveToolFallbackCwd } from "./cwd.js";

export type ShellState = {
  shells: Map<string, ManagedShellRecord>;
  /** Changes whenever the runtime worker reconstructs its in-memory state. */
  workerGeneration: string;
  /** Compact receipts retained after completed shell records are pruned. */
  prunedSessions: Map<string, PrunedShellSession>;
  /** Produced-file recovery detached from pruned shell output records. */
  prunedProducedFiles: Map<
    string,
    {
      prunedAt: number;
      pending: Promise<ProducedFileRecord[] | undefined>;
    }
  >;
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

type ManagedShellRecord = ShellRecord & {
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
  startSnapshot?: FileSnapshot | null;
  externalCandidateSnapshots?: ExternalCandidateSnapshot[];
  producedFilesReported?: boolean;
  producedFilesCollection?: Promise<ProducedFileRecord[] | undefined>;
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
export const COMPLETED_SHELL_TTL_MS = 30 * 60_000;
export const PRUNED_SHELL_RECEIPT_TTL_MS = 10 * 60_000;
const PRUNED_PRODUCED_FILES_TTL_MS = 30 * 60_000;
const MAX_ACCEPTED_WRITE_IDS = 256;
const ACCEPTED_WRITE_ID_TTL_MS = 10 * 60_000;
const MAX_SNAPSHOT_FILES = 20_000;
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

const normalizeSnapshotRoot = (cwd: string): string | null => {
  const resolved = path.resolve(cwd);
  try {
    if (!existsSync(resolved)) return null;
  } catch {
    return null;
  }
  return resolved;
};

const shouldSkipSnapshotDir = (relativeDir: string): boolean => {
  const normalized = relativeDir.split(path.sep).join("/");
  return (
    SNAPSHOT_IGNORED_DIRS.has(normalized) ||
    normalized.split("/").some((segment) => SNAPSHOT_IGNORED_DIRS.has(segment))
  );
};

const snapshotFiles = async (
  cwd: string,
  signal?: AbortSignal,
): Promise<FileSnapshot | null> => {
  const root = normalizeSnapshotRoot(cwd);
  if (!root) return null;

  const files = new Map<string, FileSnapshotEntry>();
  let complete = true;

  const walk = async (dir: string): Promise<void> => {
    if (!complete || signal?.aborted) {
      complete = false;
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!complete || signal?.aborted) {
        complete = false;
        return;
      }
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(root, fullPath);
      if (entry.isDirectory()) {
        if (!shouldSkipSnapshotDir(relativePath)) {
          await walk(fullPath);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.size >= MAX_SNAPSHOT_FILES) {
        complete = false;
        return;
      }
      try {
        const info = await stat(fullPath);
        files.set(fullPath, {
          size: info.size,
          mtimeMs: info.mtimeMs,
        });
      } catch {
        // File changed while walking; the next snapshot will catch stable state.
      }
    }
  };

  await walk(root);
  return { root, files, complete };
};

const resolveShellSnapshotRoot = (
  cwd: string,
  context?: ToolContext,
): string => {
  const resolvedCwd = normalizeSnapshotRoot(cwd);
  const resolvedStellaAppDir = context?.stellaAppDir?.trim()
    ? normalizeSnapshotRoot(context.stellaAppDir)
    : null;
  if (
    resolvedCwd &&
    resolvedStellaAppDir &&
    (resolvedCwd === resolvedStellaAppDir ||
      resolvedCwd.startsWith(`${resolvedStellaAppDir}${path.sep}`))
  ) {
    return resolvedStellaAppDir;
  }
  return resolvedCwd ?? cwd;
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
  signal?: AbortSignal,
): Promise<ExternalCandidateSnapshot> => {
  try {
    const info = await stat(candidatePath);
    if (info.isDirectory()) {
      return {
        path: candidatePath,
        kind: "directory",
        snapshot: await snapshotFiles(candidatePath, signal),
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
  } catch {
    // Missing or unreadable paths are still useful: if they appear after the
    // command, we can report them as produced files.
  }
  return { path: candidatePath, kind: "missing" };
};

const snapshotExternalCandidates = async (
  candidatePaths: string[],
  snapshotRoot: string,
  signal?: AbortSignal,
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
  return Promise.all(
    paths.map((candidate) => snapshotExternalCandidate(candidate, signal)),
  );
};

const diffExternalCandidateSnapshots = async (
  beforeSnapshots: ExternalCandidateSnapshot[] | undefined,
): Promise<ProducedFileRecord[] | undefined> => {
  if (!beforeSnapshots || beforeSnapshots.length === 0) return undefined;
  const changes: ProducedFileRecord[] = [];

  for (const before of beforeSnapshots) {
    const after = await snapshotExternalCandidate(before.path);
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
      changes.push(
        ...(diffFileSnapshots(before.snapshot, after.snapshot) ?? []),
      );
      continue;
    }
    if (after.snapshot?.complete) {
      for (const filePath of after.snapshot.files.keys()) {
        changes.push(fileChange(filePath, { type: "add" }));
      }
    }
  }

  return changes.length > 0 ? changes : undefined;
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
 *     `MAX_PRODUCED_FILES_PER_COMMAND` files, the diff is environment churn
 *     (spawned app bootstrap seeding its data dir, git checkout/worktree
 *     mtime rewrites, dependency installs) — not deliverables. Drop the
 *     whole batch; deliberate writes still surface via explicit
 *     `fileChanges` from Write/Edit/apply_patch, which never pass through
 *     snapshot detection.
 */
const mergeProducedFiles = (
  ...groups: Array<ProducedFileRecord[] | undefined>
): ProducedFileRecord[] | undefined => {
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
  if (out.length > MAX_PRODUCED_FILES_PER_COMMAND) return undefined;
  return out.length > 0 ? out : undefined;
};

const snapshotShellSideEffects = async (
  args: Record<string, unknown>,
  snapshotRoot: string,
  context?: ToolContext,
  signal?: AbortSignal,
): Promise<{
  rootSnapshot: FileSnapshot | null;
  externalCandidateSnapshots?: ExternalCandidateSnapshot[];
}> => {
  const rootSnapshot = await snapshotFiles(snapshotRoot, signal);
  const externalCandidateSnapshots = await snapshotExternalCandidates(
    inferShellMentionedPaths(args, context),
    snapshotRoot,
    signal,
  );
  return { rootSnapshot, externalCandidateSnapshots };
};

const shouldSnapshotShellSideEffects = (command: string): boolean =>
  !isKnownSafeCommand(command);

const takeCompletedProducedFiles = async (
  record: ManagedShellRecord,
  signal?: AbortSignal,
): Promise<ProducedFileRecord[] | undefined> => {
  if (record.running || record.producedFilesReported) return undefined;
  if (
    !record.startSnapshot &&
    (!record.externalCandidateSnapshots ||
      record.externalCandidateSnapshots.length === 0)
  ) {
    record.producedFilesReported = true;
    record.child = undefined;
    record.pty = undefined;
    return undefined;
  }
  if (!record.producedFilesCollection) {
    const startSnapshot = record.startSnapshot;
    const externalCandidateSnapshots = record.externalCandidateSnapshots;
    record.producedFilesCollection = (async () =>
      mergeProducedFiles(
        // A missing start snapshot can never produce a root diff. In
        // particular, known-safe commands deliberately set it to null; do not
        // turn their completion into an unconditional full-tree walk.
        startSnapshot
          ? diffFileSnapshots(
              startSnapshot,
              await snapshotFiles(startSnapshot.root),
            )
          : undefined,
        await diffExternalCandidateSnapshots(externalCandidateSnapshots),
      ))().finally(() => {
      // The shell is terminated and collection no longer needs its snapshot
      // maps or child-process handle. Keep the cached promise until a caller
      // actually consumes it, which lets an exec deadline win without losing
      // a later produced-file drain.
      record.startSnapshot = null;
      record.externalCandidateSnapshots = undefined;
      record.child = undefined;
      record.pty = undefined;
    });
  }
  const produced = await record.producedFilesCollection;
  if (signal?.aborted || record.producedFilesReported) return undefined;
  record.producedFilesReported = true;
  record.producedFilesCollection = undefined;
  return produced;
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
 * Keep rich process/output records bounded while detaching produced-file
 * recovery into a much smaller promise map. Running shells and records with
 * queued interactions are never candidates; the release path retries pruning
 * after the interaction completes.
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
    if (now - recovery.prunedAt >= PRUNED_PRODUCED_FILES_TTL_MS) {
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

    if (!record.producedFilesReported) {
      state.prunedProducedFiles.set(record.id, {
        prunedAt: now,
        pending: takeCompletedProducedFiles(record).catch(() => undefined),
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
 * Scope with `sessionIds` to the sessions a run actually touched (omit to
 * sweep every session). Delegates to `takeCompletedProducedFiles`, so the
 * one-shot `producedFilesReported` flag, `isNoiseProducedPath` guards,
 * per-command dedup, and the `MAX_PRODUCED_FILES_PER_COMMAND` cap all still
 * apply, and a session already drained inline yields nothing here.
 */
export const drainCompletedProducedFiles = async (
  state: ShellState,
  sessionIds?: Iterable<string>,
): Promise<ProducedFileRecord[]> => {
  const requestedIds = sessionIds ? [...new Set(sessionIds)] : undefined;
  const records = requestedIds
    ? requestedIds
        .map((id) => state.shells.get(id))
        .filter((record): record is ManagedShellRecord => Boolean(record))
    : [...state.shells.values()];
  const drained: ProducedFileRecord[] = [];
  for (const record of records) {
    const produced = await takeCompletedProducedFiles(record);
    if (produced) drained.push(...produced);
  }
  const prunedIds = requestedIds ?? [...state.prunedProducedFiles.keys()];
  for (const id of prunedIds) {
    const recovery = state.prunedProducedFiles.get(id);
    if (!recovery) continue;
    const produced = await recovery.pending;
    state.prunedProducedFiles.delete(id);
    if (produced) drained.push(...produced);
  }
  return drained;
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

const ensureNodeShim = (secretStateRoot: string): string | undefined => {
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
    if (process.platform !== "win32") chmodSync(shimPath, 0o700);
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

  const nodeShimDir = ensureNodeShim(secretStateRoot);
  const windowsCliShimDir =
    process.platform === "win32"
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

const buildPosixShellCommand = (
  command: string,
  options?: {
    stellaBrowserBinPath?: string;
    stellaOfficeBinPath?: string;
    stellaComputerCliPath?: string;
    stellaMediaCliPath?: string;
    stellaXApiCliPath?: string;
  },
) => {
  const stellaOfficeBin =
    options?.stellaOfficeBinPath && existsSync(options.stellaOfficeBinPath)
      ? options.stellaOfficeBinPath
      : "";
  const stellaComputerCli =
    options?.stellaComputerCliPath && existsSync(options.stellaComputerCliPath)
      ? options.stellaComputerCliPath
      : "";
  const stellaMediaCli =
    options?.stellaMediaCliPath && existsSync(options.stellaMediaCliPath)
      ? options.stellaMediaCliPath
      : "";
  const stellaXApiCli =
    options?.stellaXApiCliPath && existsSync(options.stellaXApiCliPath)
      ? options.stellaXApiCliPath
      : "";

  const preamble = `
__stella_git_exec() {
  if [ -n "$STELLA_GIT_BIN" ]; then
    "$STELLA_GIT_BIN" "$@"
  else
    command git "$@"
  fi
}
__stella_git_stage_feature_dependencies() {
  local repo_root
  repo_root="$(__stella_git_exec rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -z "$repo_root" ]; then
    return 0
  fi
  local dep_files=(
    "$repo_root/package.json"
    "$repo_root/bun.lock"
    "$repo_root/bun.lockb"
    "$repo_root/package-lock.json"
    "$repo_root/pnpm-lock.yaml"
    "$repo_root/yarn.lock"
    "$repo_root/npm-shrinkwrap.json"
  )
  local existing_files=()
  for dep_file in "\${dep_files[@]}"; do
    if [ -f "$dep_file" ]; then
      existing_files+=("$dep_file")
    fi
  done
  if [ "\${#existing_files[@]}" -gt 0 ]; then
    __stella_git_exec add -- "\${existing_files[@]}" >/dev/null 2>&1 || true
  fi
}
git() {
  if [ "$1" = "commit" ]; then
    local has_feature_tag=0
    for arg in "$@"; do
      case "$arg" in
        *"[feature:"*)
          has_feature_tag=1
          ;;
      esac
    done
    if [ "$has_feature_tag" -eq 1 ]; then
      __stella_git_stage_feature_dependencies
    fi
  fi
  __stella_git_exec "$@"
}
${stellaOfficeBin ? `stella-office() { ELECTRON_RUN_AS_NODE=1 "$STELLA_NODE_BIN" "$STELLA_OFFICE_BIN" "$@"; }` : ""}
${stellaComputerCli ? `stella-computer() { ELECTRON_RUN_AS_NODE=1 "$STELLA_NODE_BIN" "$STELLA_COMPUTER_CLI" "$@"; }` : ""}
${stellaMediaCli ? `stella-media() { ELECTRON_RUN_AS_NODE=1 "$STELLA_NODE_BIN" "$STELLA_MEDIA_CLI" "$@"; }` : ""}
${stellaXApiCli ? `stella-x-api() { ELECTRON_RUN_AS_NODE=1 "$STELLA_NODE_BIN" "$STELLA_X_API_CLI" "$@"; }` : ""}
export -f __stella_git_exec __stella_git_stage_feature_dependencies git${stellaOfficeBin ? " stella-office" : ""}${stellaComputerCli ? " stella-computer" : ""}${stellaMediaCli ? " stella-media" : ""}${stellaXApiCli ? " stella-x-api" : ""} >/dev/null 2>&1 || true
`;

  return `${preamble}\n${command}`;
};

export const buildShellCommand = (
  command: string,
  state: ShellState,
  platform: NodeJS.Platform = process.platform,
): string => {
  if (platform === "win32") {
    return command;
  }
  return buildPosixShellCommand(command, state);
};

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

  // Tests and non-Electron embeddings commonly run the kernel under Node.
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

// macOS ships /bin/bash on every install. Linux's FHS guarantees /bin/bash
// for any system that has bash at all. Some Stella launch contexts (notably
// the Electron app launched via Finder/Dock with a stripped GUI environment)
// hand the runtime a `process.env` whose PATH does not include /bin, so
// spawning bare "bash" fails with `ENOENT: posix_spawn 'bash'`. Probe for
// /bin/bash first; fall back to PATH-resolved "bash" only if it isn't there
// (e.g. a stripped-down BSD jail), which keeps test environments working.
const UNIX_BASH_CANDIDATES = [
  "/bin/bash",
  "/usr/bin/bash",
  "/usr/local/bin/bash",
];

const resolveUnixBash = (): string => {
  for (const candidate of UNIX_BASH_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return "bash";
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

const isWindowsPowerShell = (shell: string): boolean =>
  ["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(
    windowsShellName(shell),
  );

const encodePowerShellCommand = (command: string): string =>
  Buffer.from(command, "utf16le").toString("base64");

export const resolveShellLaunch = (
  command: string,
  options: ShellLaunchOptions = {},
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedShellLaunch | { error: string } => {
  if (platform !== "win32") {
    const requestedShell = options.shell?.trim();
    return {
      shell: requestedShell || resolveUnixBash(),
      args: [options.login === false ? "-c" : "-lc", command],
    };
  }

  const shell =
    options.shell?.trim() ||
    environment.ComSpec ||
    environment.COMSPEC ||
    "cmd.exe";
  if (isWindowsPowerShell(shell)) {
    // `-EncodedCommand` avoids routing PowerShell source through the native
    // Windows argv quoting rules at all. PowerShell requires UTF-16LE here.
    return {
      shell,
      args: [
        "-NoLogo",
        "-NoProfile",
        ...(options.tty ? [] : ["-NonInteractive"]),
        "-EncodedCommand",
        encodePowerShellCommand(command),
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
  agentId: string,
): string[] => {
  const owned: string[] = [];
  for (const shell of state.shells.values()) {
    if (!shell.running || shell.owner?.agentId !== agentId) continue;
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
const shellOwnerMatchesContext = (
  owner: ShellSessionOwner | undefined,
  context?: ToolContext,
): boolean => {
  if (!owner) return !context?.conversationId;
  if (!context?.conversationId) return false;
  return (
    owner.conversationId === context.conversationId &&
    owner.agentId === context.agentId
  );
};

const waitForShellActivity = async (
  record: ManagedShellRecord,
  observedVersion: number,
  timeoutMs: number,
  signal?: AbortSignal,
) => {
  if (!record.running || record.outputVersion !== observedVersion) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error("Aborted"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      record.waiters.delete(finish);
      signal?.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(finish, timeoutMs);
    record.waiters.add(finish);
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
};

const waitForShellUntilDeadline = async (
  record: ManagedShellRecord,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<void> => {
  while (record.running && Date.now() < deadlineAt) {
    const observedVersion = record.outputVersion;
    await waitForShellActivity(
      record,
      observedVersion,
      Math.max(0, deadlineAt - Date.now()),
      signal,
    );
  }
};

type ShellInteractionLease = {
  sequence: number;
  release: () => void;
};

const waitForInteractionTurn = async (
  previous: Promise<void>,
  signal?: AbortSignal,
): Promise<void> => {
  if (!signal) {
    await previous;
    return;
  }
  if (signal.aborted) {
    throw signal.reason ?? new Error("Aborted");
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Aborted"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void previous.then(
      () => {
        cleanup();
        resolve();
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
};

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
    await waitForInteractionTurn(previous, signal);
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

const settleCompletedShell = async (
  record: ManagedShellRecord,
  signal?: AbortSignal,
  hardDeadlineAt = Number.POSITIVE_INFINITY,
) => {
  const deadline = Math.min(Date.now() + 250, hardDeadlineAt);
  while (record.running && Date.now() < deadline) {
    const observedVersion = record.outputVersion;
    try {
      await waitForShellActivity(
        record,
        observedVersion,
        Math.min(25, Math.max(1, deadline - Date.now())),
        signal,
      );
    } catch {
      return;
    }
  }
};

const spawnShellProcess = (
  shell: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  windowsVerbatimArguments = false,
) =>
  spawn(shell, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments,
    // On Unix, make the shell the leader of its own process group so timeouts
    // and manual kills can terminate the entire command tree.
    detached: process.platform !== "win32",
  });

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

  let subprocess: Bun.Subprocess;
  try {
    subprocess = bunRuntime.spawn([shell, ...args], {
      cwd,
      env: {
        ...env,
        TERM: env.TERM?.trim() || "xterm-256color",
      },
      terminal,
      windowsHide: true,
      windowsVerbatimArguments,
      detached: process.platform !== "win32",
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

const terminateShellProcess = (child: SpawnedShell) => {
  if (child.exitCode !== null) {
    return;
  }

  killShellProcess(child, "SIGTERM");

  const forceKillTimer = setTimeout(() => {
    if (child.exitCode !== null) {
      return;
    }
    killShellProcess(child, "SIGKILL");
  }, 1_000);
  forceKillTimer.unref?.();
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
) => {
  maybeSweepDeferredDeletes(state);
  const id = crypto.randomUUID();
  const shellCommand = buildShellCommand(command, state);
  const launch = resolveShellLaunch(shellCommand, launchOptions);

  const failedRecord = (message: string, exitCode: number) => {
    const safeLaunchError = sanitizeToolVisibleText(message);
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
      startSnapshot,
      externalCandidateSnapshots,
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
    startSnapshot,
    externalCandidateSnapshots,
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
    child.stdout.on("data", (data: Buffer) => appendPipe(stdoutDecoder, data));
    child.stderr.on("data", (data: Buffer) => appendPipe(stderrDecoder, data));
    child.stdout.on("end", () => append(stdoutDecoder.end(), true));
    child.stderr.on("end", () => append(stderrDecoder.end(), true));
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

export const runShell = async (
  state: ShellState,
  command: string,
  cwd: string,
  timeoutMs: number,
  envOverrides?: Record<string, string>,
  launchOptions: ShellLaunchOptions = {},
) => {
  maybeSweepDeferredDeletes(state);
  const shellCommand = buildShellCommand(command, state);
  const launch = resolveShellLaunch(shellCommand, launchOptions);

  if ("error" in launch) {
    return launch.error;
  }

  return new Promise<string>((resolve) => {
    let child: SpawnedShell;
    try {
      child = spawnShellProcess(
        launch.shell,
        launch.args,
        cwd,
        buildShellEnv(envOverrides, state, launchOptions.tty === true),
        launch.windowsVerbatimArguments,
      );
    } catch (error) {
      resolve(
        describeShellSpawnFailure(
          error instanceof Error ? error : new Error(String(error)),
          launch,
          cwd,
          launchOptions,
        ),
      );
      return;
    }

    let output = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      terminateShellProcess(child);
      resolve(`Command timed out after ${timeoutMs}ms.\n\n${truncate(output)}`);
    }, timeoutMs);

    const append = (data: Buffer) => {
      output = truncate(`${output}${data.toString()}`);
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Clean Windows console noise (chcp output) that confuses LLMs
      const cleanedOutput = sanitizeToolVisibleText(output)
        .replace(/^Active code page: \d+\s*/gm, "")
        .replace(/^\s+/, ""); // Trim leading whitespace after removal
      if (code === 0) {
        resolve(cleanedOutput || "Command completed successfully (no output).");
      } else {
        resolve(
          `Command exited with code ${code}.\n\n${truncate(cleanedOutput)}`,
        );
      }
    });
    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(describeShellSpawnFailure(error, launch, cwd, launchOptions));
    });
  });
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
} => {
  const command = String(args.cmd ?? args.command ?? "");
  const explicitCwd = args.workdir ?? args.working_directory;
  const cwd =
    explicitCwd !== undefined && explicitCwd !== null
      ? String(explicitCwd)
      : resolveToolFallbackCwd(
          context?.toolWorkspaceRoot ?? context?.stellaAppDir,
        );
  const envOverrides: Record<string, string> = {};
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

const runUntilExecDeadline = async <T>(
  operation: () => Promise<T>,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<ExecDeadlineOutcome<T>> => {
  if (signal?.aborted) {
    return { status: "aborted", error: signal.reason ?? new Error("Aborted") };
  }
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) return { status: "deadline" };

  return await new Promise<ExecDeadlineOutcome<T>>((resolve) => {
    let settled = false;
    const finish = (outcome: ExecDeadlineOutcome<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = () =>
      finish({
        status: "aborted",
        error: signal?.reason ?? new Error("Aborted"),
      });
    const timer = setTimeout(() => finish({ status: "deadline" }), remainingMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (error) {
      finish({ status: "failed", error });
      return;
    }
    void pending.then(
      (value) => finish({ status: "completed", value }),
      (error) => finish({ status: "failed", error }),
    );
  });
};

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
    const snapshotAbort = new AbortController();
    const snapshotOutcome = await runUntilExecDeadline(
      () =>
        snapshotShellSideEffects(
          { cmd: prepared.command, workdir: prepared.cwd },
          resolveShellSnapshotRoot(prepared.cwd, context),
          context,
          snapshotAbort.signal,
        ),
      deadlineAt,
      signal,
    );
    if (snapshotOutcome.status === "completed") {
      beforeSideEffects = snapshotOutcome.value;
    } else {
      snapshotAbort.abort(
        snapshotOutcome.status === "aborted"
          ? snapshotOutcome.error
          : new Error("exec_command pre-snapshot deadline reached"),
      );
      if (snapshotOutcome.status === "aborted") {
        return { error: toolErrorMessage(snapshotOutcome.error) };
      }
      if (snapshotOutcome.status === "failed") {
        throw snapshotOutcome.error;
      }
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
      await waitForShellUntilDeadline(record, deadlineAt, signal);
    } catch (error) {
      // This call started the shell and is aborting before its id safely
      // reaches the model. Preserve Stella's no-hidden-orphan policy.
      if (record.running) {
        try {
          record.kill();
        } catch {
          // Best effort; the process may already be exiting.
        }
      }
      return { error: toolErrorMessage(error) };
    }
    await settleCompletedShell(record, signal, deadlineAt);

    const drained = drainUnreadOutput(record);
    const payload = buildExecToolPayload(state, record, drained, callStartedAt);
    let producedFiles: ProducedFileRecord[] | undefined;
    if (!record.running) {
      const collectionDelivery = new AbortController();
      const collectionOutcome = await runUntilExecDeadline(
        () => takeCompletedProducedFiles(record, collectionDelivery.signal),
        deadlineAt,
        signal,
      );
      if (collectionOutcome.status === "completed") {
        producedFiles = collectionOutcome.value;
      } else {
        collectionDelivery.abort(
          collectionOutcome.status === "aborted"
            ? collectionOutcome.error
            : new Error("exec_command post-snapshot deadline reached"),
        );
        if (collectionOutcome.status === "aborted") {
          return { error: toolErrorMessage(collectionOutcome.error) };
        }
        if (collectionOutcome.status === "failed") {
          throw collectionOutcome.error;
        }
        // The cached collection continues without pinning this call. Because
        // delivery was aborted, it remains available to a later drain.
      }
    }
    return {
      result: formatExecToolResult(payload, drained),
      details: buildExecToolDetails(payload, drained),
      modelOutputTokens,
      ...(producedFiles ? { producedFiles } : {}),
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

  let interaction: ShellInteractionLease;
  try {
    interaction = await acquireShellInteraction(state, record, signal);
  } catch (error) {
    return { error: toolErrorMessage(error) };
  }
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

    const yieldTimeMs =
      operation !== "poll"
        ? resolveExecYieldTime(args.yield_time_ms, DEFAULT_WRITE_STDIN_YIELD_MS)
        : resolveExecYieldTime(
            args.yield_time_ms,
            DEFAULT_EMPTY_POLL_YIELD_MS,
            MAX_EMPTY_POLL_YIELD_MS,
          );
    try {
      if (operation === "poll") {
        // Empty polling is a first-activity wait. Keeping the interaction open
        // until the full yield deadline after output has already arrived makes
        // interactive subprocesses feel hung and delays the next write.
        if (record.outputCursorBytes === record.unreadCursorStart) {
          await waitForShellActivity(
            record,
            record.outputVersion,
            yieldTimeMs,
            signal,
          );
        }
      } else {
        await waitForShellUntilDeadline(
          record,
          Date.now() + yieldTimeMs,
          signal,
        );
      }
    } catch (error) {
      // A poll/write never owns the process lifecycle; cancellation releases
      // only this interaction lease and leaves the session addressable.
      return { error: toolErrorMessage(error) };
    }
    await settleCompletedShell(record, signal);

    const drained = drainUnreadOutput(record);
    const payload = buildExecToolPayload(
      state,
      record,
      drained,
      callStartedAt,
      receipt,
    );
    const producedFiles = await takeCompletedProducedFiles(record, signal);
    return {
      result: formatExecToolResult(payload, drained),
      details: buildExecToolDetails(payload, drained),
      modelOutputTokens,
      ...(producedFiles ? { producedFiles } : {}),
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
  _signal?: AbortSignal,
): Promise<ToolResult> => {
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

  if (runInBackground) {
    const beforeSideEffects = shouldSnapshotShellSideEffects(command)
      ? await snapshotShellSideEffects(
          { cmd: command, workdir: cwd },
          resolveShellSnapshotRoot(cwd, context),
          context,
        )
      : { rootSnapshot: null };
    const record = startShell(
      state,
      command,
      cwd,
      envOverrides,
      undefined,
      beforeSideEffects.rootSnapshot,
      beforeSideEffects.externalCandidateSnapshots,
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

  const shouldSnapshotSideEffects = shouldSnapshotShellSideEffects(command);
  const snapshotRoot = shouldSnapshotSideEffects
    ? resolveShellSnapshotRoot(cwd, context)
    : null;
  const beforeSideEffects =
    shouldSnapshotSideEffects && snapshotRoot
      ? await snapshotShellSideEffects(
          { cmd: command, workdir: cwd },
          snapshotRoot,
          context,
        )
      : { rootSnapshot: null };
  const output = await runShell(state, command, cwd, timeout, envOverrides);
  const producedFiles =
    shouldSnapshotSideEffects && snapshotRoot
      ? mergeProducedFiles(
          diffFileSnapshots(
            beforeSideEffects.rootSnapshot,
            await snapshotFiles(snapshotRoot),
          ),
          await diffExternalCandidateSnapshots(
            beforeSideEffects.externalCandidateSnapshots,
          ),
        )
      : undefined;
  const extracted = extractOfficePreviewRef(sanitizeToolVisibleText(output));
  return {
    result: truncate(extracted.cleanedOutput),
    ...(producedFiles ? { producedFiles } : {}),
    ...(extracted.officePreviewRef
      ? {
          details: {
            text: truncate(extracted.cleanedOutput),
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
): Promise<ToolResult> => {
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

  const producedFiles = await takeCompletedProducedFiles(record);
  return {
    result,
    ...(producedFiles ? { producedFiles } : {}),
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
