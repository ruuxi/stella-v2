/**
 * The contract between a BuildSession and the just-bash worker shell.
 *
 * A worker-shell run never changes the world by itself. The Dynamic Worker
 * reads the world through a scoped loopback, stages every write in its own
 * memory, uploads the new file contents as unreferenced blobs, and returns the
 * resulting change set. Only the BuildSession commits that change set, in one
 * WorldStore mutation that also checks nothing the run read or wrote changed
 * underneath it. A run that dies, is cancelled, or reaches anything the shell
 * cannot faithfully do therefore leaves the world exactly as it was, which is
 * what makes handing the same command to the real sandbox afterwards safe.
 */

import type { WorldEntry, WorldListingEntry } from "../world/types.js";

/**
 * What the Dynamic Worker may ask of the world. It is bound by the host to one
 * owner world and one fork, so nothing here names either. Paths are
 * world-relative and never follow symlinks; the shell walks links itself so
 * its own staged writes take part in resolution.
 */
export interface WorldShellFsRpc {
  stat(paths: readonly string[]): Promise<(WorldEntry | null)[]>;
  children(path: string): Promise<WorldEntry[]>;
  read(
    path: string,
    options: { offset: number; length: number },
  ): Promise<Uint8Array<ArrayBufferLike> | null>;
  /** Store content as an unreferenced, pinned blob; nothing becomes visible. */
  putBlob(bytes: Uint8Array<ArrayBufferLike>): Promise<{ sha256: string; size: number }>;
}

export type WorkerShellRequest = Readonly<{
  script: string;
  /** Absolute shell path of the workspace root, e.g. `/workspace/world`. */
  root: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
  /** Wall-clock budget for the interpreter, in milliseconds. */
  timeoutMs: number;
  /**
   * World-relative subtrees only the sandbox may touch, because their
   * current contents arrive when it attaches (the user's drive is hydrated
   * then). Touching one hands the command to the sandbox.
   */
  sandboxOnly: readonly string[];
}>;

export type WorkerShellReadSet = Readonly<{
  /** World paths whose presence or content the run observed. */
  paths: readonly string[];
  /** World directories whose child list the run observed. */
  children: readonly string[];
}>;

export type WorkerShellChanges = Readonly<{
  entries: readonly WorldListingEntry[];
  deleted: readonly string[];
}>;

/**
 * Why a run handed its command to the sandbox instead of finishing. Every one
 * of these is decided before anything is committed.
 */
export type WorkerShellFallbackReason =
  | "unsupported_command"
  | "unsupported_syntax"
  | "outside_workspace"
  | "sandbox_only_path"
  | "unsupported_filesystem_operation"
  | "resource_limit"
  | "timeout";

export type WorkerShellOutcome =
  | Readonly<{
      kind: "fallback";
      reason: WorkerShellFallbackReason;
      detail: string;
    }>
  | Readonly<{
      kind: "completed";
      stdout: string;
      stderr: string;
      exitCode: number;
      /** Output bytes the interpreter produced before its own cap. */
      outputBytes: number;
      reads: WorkerShellReadSet;
      changes: WorkerShellChanges;
      stats: WorkerShellStats;
    }>;

export type WorkerShellStats = Readonly<{
  worldCalls: number;
  bytesRead: number;
  bytesStaged: number;
}>;

/**
 * Bounds for one run. The interpreter never holds more than these in its own
 * isolate; crossing one is a fallback, never a partial result.
 */
export const WORKER_SHELL_LIMITS = Object.freeze({
  scriptBytes: 256 * 1024,
  /** stdout plus stderr, as just-bash counts them. */
  outputBytes: 4 * 1024 * 1024,
  /** A single world file the shell will load. Larger files need the sandbox. */
  fileBytes: 16 * 1024 * 1024,
  /** One loopback read; the WorldStore refuses more than 8 MiB per call. */
  readChunkBytes: 8 * 1024 * 1024,
  /** Everything read from the world in one run. */
  totalReadBytes: 64 * 1024 * 1024,
  /** New file contents held for commit. */
  stagedBytes: 32 * 1024 * 1024,
  stagedFiles: 2_000,
  /** Loopback calls in one run, including lookups. */
  worldCalls: 20_000,
  /** Bytes the shell's private /dev scratch may hold. */
  scratchBytes: 4 * 1024 * 1024,
  /** CPU the Dynamic Worker may spend on one run. */
  cpuMs: 10_000,
});

export const WORKER_SHELL_MAX_TIMEOUT_MS = 20_000;
