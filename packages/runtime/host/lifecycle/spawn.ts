import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { Cause, Effect, Exit, type Scope } from "effect";
import { runtimeIpcListenUrl, type RuntimePaths } from "../../worker/runtime-paths.js";
import { rotateLogIfOversized } from "../../observability/rotate-file.js";
import { killWorkerProcess } from "./kill.js";
import type { LifecycleStartOptions } from "./options.js";

/**
 * Resolve the `bun` executable to an absolute path once, falling back to the
 * bare `"bun"` PATH lookup when no known install location exists. Spawning a
 * bare command name on Windows forces a PATHEXT + every-PATH-entry filesystem
 * probe to locate `bun.exe`; pointing `spawn` at an absolute path skips that.
 * Mirrors the candidate order used elsewhere (STELLA_BUN_PATH / BUN_PATH /
 * ~/.bun/bin). Only an existing absolute path is used, so behavior is
 * otherwise identical to the previous bare-`"bun"` spawn.
 */
let cachedBunBinaryPath: string | null = null;
const resolveBunBinaryPath = (): string => {
  if (cachedBunBinaryPath) return cachedBunBinaryPath;
  const candidates: string[] = [];
  const add = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed) candidates.push(trimmed);
  };
  add(process.env.STELLA_BUN_PATH);
  add(process.env.BUN_PATH);
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (homeDir) {
    add(
      join(
        homeDir,
        ".bun",
        "bin",
        process.platform === "win32" ? "bun.exe" : "bun",
      ),
    );
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedBunBinaryPath = candidate;
      return candidate;
    }
  }
  return "bun";
};

const spawnDetachedWorkerProcess = (
  options: LifecycleStartOptions,
  paths: RuntimePaths,
): ChildProcess => {
  const args = [
    "run",
    options.workerEntryPath,
    "--listen",
    runtimeIpcListenUrl(paths.socketPath),
    "--stella-root",
    options.stellaAppDir,
  ];
  if (options.idleShutdownMs && options.idleShutdownMs > 0) {
    args.push("--idle-shutdown-ms", String(options.idleShutdownMs));
  }
  // Bound the raw stdout/stderr sink before the fresh worker appends to it.
  // The log dir is separate from the runtime control dir, so ensure it exists.
  mkdirSync(paths.logDir, { recursive: true });
  rotateLogIfOversized(paths.logFile);
  const logFd = openSync(paths.logFile, "a");
  // bun ignores NODE_COMPILE_CACHE, so every cold spawn re-parses the ~2.5MB
  // kernel entry bundle from scratch. Point bun's runtime transpiler cache at a
  // dedicated per-root dir so re-spawns (the common Electron-restart churn case)
  // skip re-transpiling. Best-effort: if the dir can't be created we simply fall
  // back to the uncached spawn, so behavior is otherwise unchanged.
  let transpilerCachePath: string | undefined;
  try {
    transpilerCachePath = join(paths.rootDir, "bun-transpiler-cache");
    mkdirSync(transpilerCachePath, { recursive: true });
  } catch {
    transpilerCachePath = undefined;
  }
  let child: ChildProcess;
  try {
    if (options.env?.NODE_ENV === "development") {
      console.warn(`[runtime-host] Detached worker logs: ${paths.logFile}`);
    }
    child = spawn(options.bunBinaryPath ?? resolveBunBinaryPath(), args, {
      detached: process.platform !== "win32",
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        ...(transpilerCachePath
          ? { BUN_RUNTIME_TRANSPILER_CACHE_PATH: transpilerCachePath }
          : {}),
        ...(options.env ?? {}),
        ...(options.hostExecutablePath
          ? { STELLA_HOST_EXECUTABLE_PATH: options.hostExecutablePath }
          : {}),
      },
      windowsHide: true,
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();
  return child;
};

/**
 * Spawn the detached worker as a scope-managed resource with adoption
 * semantics:
 *
 * - Success: the worker outlives the scope by design — it is detached and
 *   self-supervises (idle-shutdown timer, own lockfile). Release is a no-op.
 * - Failure (e.g. readiness timeout): the worker is ALSO left running, on
 *   purpose — this preserves the old observable behavior where a
 *   slow-booting worker survives the host's poll budget and the next start
 *   attaches to it instead of triggering a spawn-retry cascade.
 * - Interruption: nobody is coming back for this attach, so the release
 *   reaps the just-spawned child (SIGTERM→750ms→SIGKILL). This is the one
 *   new path — the old promise code could not be cancelled at all.
 */
export const spawnAdoptedWorker = (
  options: LifecycleStartOptions,
  paths: RuntimePaths,
): Effect.Effect<ChildProcess, unknown, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => spawnDetachedWorkerProcess(options, paths),
      catch: (error) => error,
    }),
    (child, exit) => {
      const interrupted =
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
      if (!interrupted || !child.pid) return Effect.void;
      return Effect.asVoid(killWorkerProcess(child.pid, 750));
    },
  );
