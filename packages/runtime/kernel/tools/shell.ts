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
import type {
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
import { sanitizeToolVisibleText } from "./safety.js";
import type { OfficePreviewRef } from "@stella/contracts/office-preview";
import { purgeExpiredDeferredDeletes } from "./deferred-delete.js";
import { resolveToolFallbackCwd } from "./cwd.js";
import { isolateToolProcessLaunch } from "./process-isolation.js";

export type ShellState = {
  shells: Map<string, ManagedShellRecord>;
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
const MAX_ACCEPTED_WRITE_IDS = 256;
const ACCEPTED_WRITE_ID_TTL_MS = 10 * 60_000;

const APPROX_BYTES_PER_TOKEN = 4;
/**
 * Cheap byte-count → token estimate. Off by a small constant from any real
 * tokenizer, but stable enough for "did this output get truncated".
 */
export const approxTokenCount = (text: string): number =>
  Math.ceil(text.length / APPROX_BYTES_PER_TOKEN);

const OFFICE_PREVIEW_REF_MARKER = "__STELLA_OFFICE_PREVIEW_REF__";
const DEFERRED_DELETE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

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
const pruneCompletedShellSessions = (
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
  if (context?.executionHost === "sandbox") {
    const workspaceRoot = context.toolWorkspaceRoot?.trim();
    if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
      throw new Error("Sandbox shell commands require a workspace boundary.");
    }
    const lexicalRoot = path.resolve(workspaceRoot);
    const lexicalCwd = path.resolve(cwd);
    if (!pathInside(lexicalCwd, lexicalRoot)) {
      throw new Error("Sandbox shell workdir must stay inside the workspace.");
    }
    let canonicalRoot: string;
    let canonicalCwd: string;
    try {
      canonicalRoot = realpathSync.native(lexicalRoot);
      canonicalCwd = realpathSync.native(lexicalCwd);
    } catch {
      throw new Error(
        "Sandbox shell workdir must be an existing real directory.",
      );
    }
    if (
      canonicalRoot !== lexicalRoot ||
      canonicalCwd !== lexicalCwd ||
      !pathInside(canonicalCwd, canonicalRoot)
    ) {
      throw new Error(
        "Sandbox shell workdir must be canonical and contain no symbolic links.",
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
    emitUpdate,
    prepared.launchOptions,
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
    return {
      result: formatExecToolResult(payload, drained),
      details: buildExecToolDetails(payload, drained),
      modelOutputTokens,
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
    return {
      result: formatExecToolResult(payload, drained),
      details: buildExecToolDetails(payload, drained),
      modelOutputTokens,
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

  if (runInBackground) {
    const record = startShell(
      state,
      command,
      cwd,
      envOverrides,
      undefined,
      undefined,
      prepared.launchOptions,
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
  const extracted = extractOfficePreviewRef(sanitizeToolVisibleText(output));
  const text = truncate(extracted.cleanedOutput);
  return {
    result: text,
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

  return { result };
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
