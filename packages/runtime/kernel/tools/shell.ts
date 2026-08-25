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
  ProducedFilesOmission,
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

export type ShellState = {
  shells: Map<string, ManagedShellRecord>;
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
  producedFilesCollection?: Promise<ProducedFilesOutcome>;
  /** Cap resolved from the host's ToolContext when the shell was started. */
  producedFileLimit: number;
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
 * The `producedFiles` / `producedFilesOmitted` slice of a `ToolResult`, so
 * every shell handler can spread one object instead of rebuilding the pair.
 */
type ProducedFilesOutcome = {
  producedFiles?: ProducedFileRecord[];
  producedFilesOmitted?: ProducedFilesOmission;
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
): Promise<ProducedFilesOutcome> => {
  if (record.running || record.producedFilesReported) return {};
  if (
    !record.startSnapshot &&
    (!record.externalCandidateSnapshots ||
      record.externalCandidateSnapshots.length === 0)
  ) {
    record.producedFilesReported = true;
    record.child = undefined;
    record.pty = undefined;
    return {};
  }
  if (!record.producedFilesCollection) {
    const startSnapshot = record.startSnapshot;
    const externalCandidateSnapshots = record.externalCandidateSnapshots;
    record.producedFilesCollection = (async () =>
      mergeProducedFiles(
        record.producedFileLimit,
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
  if (signal?.aborted || record.producedFilesReported) return {};
  record.producedFilesReported = true;
  record.producedFilesCollection = undefined;
  return produced;
};

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
  sessionIds?: Iterable<string>,
): Promise<{
  files: ProducedFileRecord[];
  omitted?: ProducedFilesOmission;
}> => {
  const records = sessionIds
    ? [...new Set(sessionIds)]
        .map((id) => state.shells.get(id))
        .filter((record): record is ManagedShellRecord => Boolean(record))
    : [...state.shells.values()];
  const files: ProducedFileRecord[] = [];
  let count = 0;
  let limit = 0;
  for (const record of records) {
    const produced = await takeCompletedProducedFiles(record);
    if (produced.producedFiles) files.push(...produced.producedFiles);
    if (produced.producedFilesOmitted) {
      count += produced.producedFilesOmitted.count;
      limit = Math.max(limit, produced.producedFilesOmitted.limit);
    }
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
) => {
  const mergedEnv: NodeJS.ProcessEnv = {
    ...(envOverrides ? { ...process.env, ...envOverrides } : process.env),
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
// (e.g. a stripped-down BSD jail), which keeps constrained environments working.
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
  close: () => void;
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
  truncated: boolean;
};

const drainUnreadOutput = (record: ManagedShellRecord): DrainedOutput => {
  const unread = record.unreadOutputBuffer.drain();
  record.unreadOutput = "";
  return {
    text: unread.text,
    originalLength: unread.totalBytes,
    truncated: unread.omittedBytes > 0,
  };
};

const refreshShellOutputText = (record: ManagedShellRecord): void => {
  record.output = record.outputBuffer.snapshot().text;
  record.unreadOutput = record.unreadOutputBuffer.snapshot().text;
};

const appendShellOutput = (record: ManagedShellRecord, text: string): void => {
  record.outputBuffer.pushText(text);
  record.unreadOutputBuffer.pushText(text);
  refreshShellOutputText(record);
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
  };
};

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

const settleCompletedShellEffect = (
  record: ManagedShellRecord,
  signal?: AbortSignal,
  hardDeadlineAt = Number.POSITIVE_INFINITY,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const deadline = Math.min(Date.now() + 250, hardDeadlineAt);
    while (record.running && Date.now() < deadline) {
      const observedVersion = record.outputVersion;
      const attempt = yield* Effect.exit(
        waitForShellActivityEffect(
          record,
          observedVersion,
          Math.min(25, Math.max(1, deadline - Date.now())),
          signal,
        ),
      );
      if (Exit.isFailure(attempt)) {
        return;
      }
    }
  });

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

  return { process: subprocess, terminal, write, close };
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

export const startShell = (
  state: ShellState,
  command: string,
  cwd: string,
  envOverrides?: Record<string, string>,
  onClose?: () => void,
  startSnapshot?: FileSnapshot | null,
  externalCandidateSnapshots?: ExternalCandidateSnapshot[],
  onActivity?: (record: ManagedShellRecord) => void,
  launchOptions: ShellLaunchOptions = {},
  producedFileLimit: number = MAX_PRODUCED_FILES_PER_COMMAND,
) => {
  maybeSweepDeferredDeletes(state);
  const id = crypto.randomUUID();
  const shellCommand = buildShellCommand(command, state);
  const launch = resolveShellLaunch(shellCommand, launchOptions);

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
    };
    record.outputBuffer.pushText(safeLaunchError);
    record.unreadOutputBuffer.pushText(safeLaunchError);
    state.shells.set(id, record);
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
  };

  const append = (chunk: string, sanitizeImmediately: boolean) => {
    // Pipe output is sanitized chunk-by-chunk for compatibility. PTY escape
    // sequences can straddle native read boundaries, so retain those chunks
    // until the existing payload-level sanitizer sees the complete drain.
    appendShellOutput(
      record,
      sanitizeImmediately ? sanitizeToolVisibleText(chunk) : chunk,
    );
    notifyShellActivity(record);
    onActivity?.(record);
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
  };

  const shellEnv = buildShellEnv(envOverrides, state);
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

    const appendPipe = (data: Buffer) => append(data.toString(), true);
    child.stdout?.on("data", appendPipe);
    child.stderr?.on("data", appendPipe);
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
        if (record.running && record.child && record.child.exitCode === null) {
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
        Effect.forEach(
          pending,
          (record) => Deferred.await(record.exitLatch),
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.as("joined" as const)),
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
) => {
  maybeSweepDeferredDeletes(state);
  const shellCommand = buildShellCommand(command, state);
  const launch = resolveShellLaunch(shellCommand, launchOptions);

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
            buildShellEnv(envOverrides, state),
            launch.windowsVerbatimArguments,
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

        const append = (data: Buffer) => {
          output = truncate(`${output}${data.toString()}`);
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
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

type ExecToolPayload = {
  session_id: string | null;
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
  record: ManagedShellRecord,
  drained: DrainedOutput,
  callStartedAt: number,
): ExecToolPayload => {
  const wallTimeSeconds = (Date.now() - callStartedAt) / 1000;
  // Includes wall_time_seconds and original_token_count so the model can
  // detect output omitted by the raw one-MiB collector and react.
  const payload: ExecToolPayload = {
    session_id: record.running ? record.id : null,
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
    raw_output_truncated: drained.truncated,
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
    `Wall time: ${payload.wall_time_seconds} seconds`,
    status,
    `Original token count: ${payload.original_token_count}`,
    ...(drained.truncated
      ? [
          "Raw process output exceeded the 1 MiB collection cap; omitted bytes remain marked in Output.",
        ]
      : []),
    "Output:",
    payload.output,
    ...(payload.hint ? [`Hint: ${payload.hint}`] : []),
  ].join("\n");
};

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
  const dangerReason = isDangerousCommand(prepared.command);
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
  let lastUpdateAt = 0;
  const emitUpdate = (record: ManagedShellRecord) => {
    if (!onUpdate) return;
    const now = Date.now();
    if (record.running && now - lastUpdateAt < 250) return;
    lastUpdateAt = now;
    const unread = record.unreadOutputBuffer.snapshot();
    const drained = {
      text: unread.text,
      originalLength: unread.totalBytes,
      truncated: unread.omittedBytes > 0,
    };
    const payload = buildExecToolPayload(record, drained, callStartedAt);
    onUpdate({
      result: formatExecToolResult(payload, drained),
      details: buildExecToolDetails(payload, drained),
      modelOutputTokens,
    });
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
  );
  setShellOwner(record, context);
  const observedVersion = record.outputVersion;
  try {
    await runToolEffect(
      Effect.scoped(
        Effect.gen(function* () {
          // Ownership classification (run-owned vs conversation-scoped):
          // this call STARTED the shell, so until the session id reaches
          // the model the shell is run-owned — an abort before then would
          // otherwise orphan it until toolHost shutdown. The window's
          // exit-aware scope finalizer kills it through the TERM→1s→KILL
          // ladder on any failing exit (abort). Session shells whose id
          // was already delivered (later write_stdin polls) are
          // conversation-scoped and deliberately exempt: aborting a poll
          // never kills the shell.
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
          yield* waitForShellActivityEffect(
            record,
            observedVersion,
            Math.max(0, deadlineAt - Date.now()),
            signal,
          );
        }),
      ),
    );
  } catch (error) {
    // Ownership classification (run-owned vs conversation-scoped): this
    // call STARTED the shell and is aborting before the session id ever
    // reaches the model — nothing can address the shell later, so it is
    // run-owned and would otherwise orphan until toolHost shutdown. Kill
    // it through the TERM→1s→KILL ladder as the aborted call's finalizer.
    // Session shells whose id was already delivered (later write_stdin
    // polls) are conversation-scoped and deliberately exempt: aborting a
    // poll never kills the shell.
    if (record.running) {
      try {
        record.kill();
      } catch {
        // Best effort; the process may already be exiting.
      }
    }
    return { error: toolErrorMessage(error) };
  }
  await runToolEffect(settleCompletedShellEffect(record, signal, deadlineAt));

  const drained = drainUnreadOutput(record);
  const payload = buildExecToolPayload(record, drained, callStartedAt);
  let produced: ProducedFilesOutcome = {};
  if (!record.running) {
    const collectionDelivery = new AbortController();
    const collectionOutcome = await runUntilExecDeadline(
      () => takeCompletedProducedFiles(record, collectionDelivery.signal),
      deadlineAt,
      signal,
    );
    if (collectionOutcome.status === "completed") {
      produced = collectionOutcome.value;
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
      // The cached collection continues without pinning this call. Because the
      // delivery signal is aborted, it remains available to a later drain.
    }
  }
  // Also on the model-visible payload, not just the structured side channel:
  // the agent is the one that can tell the user its 31 charts are sitting in
  // the workspace undelivered.
  if (produced.producedFilesOmitted) {
    payload.produced_files_omitted = produced.producedFilesOmitted;
  }
  return {
    result: formatExecToolResult(payload, drained),
    details: buildExecToolDetails(payload, drained),
    modelOutputTokens,
    ...produced,
  };
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
  const record = state.shells.get(sessionId);
  if (!record) {
    return { error: `Session not found: ${sessionId}` };
  }

  const chars = typeof args.chars === "string" ? args.chars : "";
  const observedVersion = record.outputVersion;
  try {
    await writeToShellStdin(record, chars);
  } catch (error) {
    if (record.running) {
      return { error: (error as Error).message };
    }
  }

  try {
    await runToolEffect(
      waitForShellActivityEffect(
        record,
        observedVersion,
        chars
          ? resolveExecYieldTime(
              args.yield_time_ms,
              DEFAULT_WRITE_STDIN_YIELD_MS,
            )
          : // An empty write is a pure poll on a silent process, so it gets a
            // far higher ceiling than an interactive write — matching Codex,
            // whose background-terminal poll budget is 5 minutes. The wait
            // still returns the instant the process emits anything or exits,
            // so a chatty build is unaffected; this only stops a quiet
            // 10-minute job from costing twenty round-trips.
            resolveExecYieldTime(
              args.yield_time_ms,
              DEFAULT_EMPTY_POLL_YIELD_MS,
              MAX_EMPTY_POLL_YIELD_MS,
            ),
        signal,
      ),
    );
  } catch (error) {
    return { error: (error as Error).message };
  }
  await runToolEffect(settleCompletedShellEffect(record, signal));

  const drained = drainUnreadOutput(record);
  const payload = buildExecToolPayload(record, drained, callStartedAt);
  const produced = await takeCompletedProducedFiles(record);
  if (produced.producedFilesOmitted) {
    payload.produced_files_omitted = produced.producedFilesOmitted;
  }
  return {
    result: formatExecToolResult(payload, drained),
    details: buildExecToolDetails(payload, drained),
    modelOutputTokens,
    ...produced,
  };
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
  const dangerReason = isDangerousCommand(command);
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
      undefined,
      prepared.launchOptions,
      resolveProducedFileLimit(context),
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
  const produced =
    shouldSnapshotSideEffects && snapshotRoot
      ? mergeProducedFiles(
          resolveProducedFileLimit(context),
          diffFileSnapshots(
            beforeSideEffects.rootSnapshot,
            await snapshotFiles(snapshotRoot),
          ),
          await diffExternalCandidateSnapshots(
            beforeSideEffects.externalCandidateSnapshots,
          ),
        )
      : {};
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
): Promise<ToolResult> => {
  const shellId = String(args.shell_id ?? "");

  // If no shell_id provided, list all active shells
  if (!shellId) {
    const shells = [...state.shells.entries()].map(([id, r]) => ({
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
  if (!record) return { error: `Shell not found: ${shellId}` };

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

  const produced = await takeCompletedProducedFiles(record);
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
): Promise<ToolResult> => {
  const shellId = String(args.shell_id ?? "");
  const record = state.shells.get(shellId);
  if (!record) {
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
