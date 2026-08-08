import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

/**
 * Per-stellaAppDir resolution of the on-disk worker lifecycle artifacts.
 *
 * We key everything on a content-derived hash of the absolute root path
 * so that multiple Stella installs on the same machine (e.g. dev tree at
 * a source checkout plus a packaged install) don't share
 * a pidfile/socket and accidentally talk to each other's worker.
 *
 * Layout:
 *   ~/.stella/runtime/<rootHash>/   <- machine control files
 *     ├── runtime.lock     <- flock for serializing start/stop
 *     ├── runtime.pid      <- pid of the currently-running worker
 *     ├── runtime.sock     <- Unix domain socket the host connects to on POSIX
 *     ├── host-executable.txt <- Electron executable path that spawned it
 *     └── root.txt         <- the literal stellaAppDir, for debugging
 *   ~/.stella/logs/<rootHash>/      <- human-readable logs (colocated)
 *     ├── runtime.log      <- worker stdout/stderr (rotating)
 *     ├── error-YYYY-MM-DD.txt   <- crashes / uncaught errors
 *     └── process-YYYY-MM-DD.txt <- lifecycle events
 *
 * The raw `runtime.log` lives alongside the diagnostic logs (not next to
 * the sock/pid/lock control files) so "Open logs folder" / `bun run logs`
 * surface every human-readable log in one place.
 *
 * Windows uses named pipes instead of socket files:
 *   \\.\pipe\stella-runtime-<rootHash>
 *   \\.\pipe\stella-cli-bridge-<rootHash>
 */

const RUNTIME_DIR_NAME = ".stella";
const RUNTIME_SUBDIR = "runtime";
const LOGS_SUBDIR = "logs";

/**
 * Per-stellaAppDir directory for human-readable logs (worker stdout/stderr
 * plus the diagnostic error/process channels). Single source of truth shared
 * with `runtime/observability/log-paths.ts`.
 */
export const resolveLogDir = (
  stellaAppDir: string,
  options?: { homeDir?: string },
): string =>
  path.join(
    options?.homeDir ?? os.homedir(),
    RUNTIME_DIR_NAME,
    LOGS_SUBDIR,
    hashStellaAppDir(stellaAppDir),
  );

export type RuntimePaths = {
  rootHash: string;
  rootDir: string;
  pidFile: string;
  lockFile: string;
  socketPath: string;
  /**
   * Companion local-IPC endpoint the worker listens on for sidecar
   * processes (e.g. the `stella-computer` daemon spawn path) and the
   * in-process node_repl `connect` client — credential dialogs, brokered
   * connector actions, permission prompts.
   * Sidecars discover the path via the `STELLA_CLI_BRIDGE_SOCK` env var
   * injected by `runtime/kernel/tools/shell.ts`. Kept under the same
   * per-root namespace so multi-install machines don't collide. POSIX
   * socket paths are len(homedir)-dependent and capped at 104 bytes on
   * macOS (BSD `sun_path`, 103 usable), so the per-session endpoint from
   * `createSecureCliBridgeEndpoint` keeps its components short
   * (`<rootDir>/<22-char nonce>/b.sock` = homedir + 63 bytes) and
   * `startCliBridgeServer` enforces a defensive ceiling before binding.
   */
  cliBridgeSocketPath: string;
  /** Directory holding `runtime.log` and the diagnostic log channels. */
  logDir: string;
  logFile: string;
  hostExecutableFile: string;
  /**
   * Runtime build stamp of the code the currently-running worker loaded at
   * boot (see `runtime/worker/runtime-build-stamp.ts`). Written by the
   * worker's `WorkerLifecycleServer.start`; read by the host on attach to
   * detect a stale worker after a desktop update.
   */
  buildStampFile: string;
  /**
   * Host-written flag recording that the worker is known-stale but was busy
   * (active run / streaming turn) when detected, so the restart was
   * deferred. Survives Electron restarts; the next host's reconnect
   * handshake picks it up and restarts the worker at the first quiescent
   * moment. Cleared whenever a freshly spawned worker connects.
   */
  pendingWorkerRestartFile: string;
  rootMarkerFile: string;
};

export const hashStellaAppDir = (stellaAppDir: string): string => {
  const normalized = path.resolve(stellaAppDir);
  return crypto
    .createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 16);
};

const windowsNamedPipePath = (name: string, rootHash: string): string =>
  `\\\\.\\pipe\\stella-${name}-${rootHash}`;

export const createSecureCliBridgeEndpoint = (
  paths: Pick<RuntimePaths, "rootDir" | "rootHash">,
  options?: { platform?: NodeJS.Platform; nonce?: string },
): string => {
  const platform = options?.platform ?? process.platform;
  const nonce = (
    options?.nonce ?? crypto.randomBytes(16).toString("base64url")
  ).replace(/[^A-Za-z0-9_-]/gu, "");
  // 22 base64url chars carry the full 128 bits of randomBytes(16); legacy
  // hex nonces (32+ chars) clear the same floor. Both alphabets survive the
  // sanitize regex above unchanged (base64url uses `-`/`_`, never `+/=`).
  if (nonce.length < 22) {
    throw new Error(
      "CLI bridge nonce must contain at least 128 bits of entropy.",
    );
  }
  if (platform === "win32") {
    return `\\\\.\\pipe\\stella-cli-bridge-${paths.rootHash}-${nonce}`;
  }
  // The nonce MUST stay its own directory component: startCliBridgeServer
  // chmods the socket's parent directory to 0700 (that per-session dir is
  // the unpredictability barrier) and removes it on stop. Components are
  // deliberately terse — `<rootDir>/<nonce>/b.sock` is homedir + 63 bytes,
  // keeping well under the 104-byte BSD `sun_path` cap even for long
  // usernames.
  return path.join(paths.rootDir, nonce, "b.sock");
};

export const isWindowsNamedPipePath = (socketPath: string): boolean =>
  /^\\\\[.?]\\pipe\\/i.test(socketPath);

export const runtimeIpcPathUsesFilesystem = (socketPath: string): boolean =>
  !isWindowsNamedPipePath(socketPath);

export const runtimeIpcListenUrl = (socketPath: string): string =>
  isWindowsNamedPipePath(socketPath)
    ? `pipe://${socketPath}`
    : `unix://${socketPath}`;

export const resolveRuntimePaths = (
  stellaAppDir: string,
  options?: { platform?: NodeJS.Platform; homeDir?: string },
): RuntimePaths => {
  const rootHash = hashStellaAppDir(stellaAppDir);
  const baseDir = path.join(
    options?.homeDir ?? os.homedir(),
    RUNTIME_DIR_NAME,
    RUNTIME_SUBDIR,
  );
  const rootDir = path.join(baseDir, rootHash);
  const logDir = resolveLogDir(stellaAppDir, options);
  const platform = options?.platform ?? process.platform;
  const socketPath =
    platform === "win32"
      ? windowsNamedPipePath("runtime", rootHash)
      : path.join(rootDir, "runtime.sock");
  const cliBridgeSocketPath =
    platform === "win32"
      ? windowsNamedPipePath("cli-bridge", rootHash)
      : path.join(rootDir, "cli-bridge.sock");
  return {
    rootHash,
    rootDir,
    pidFile: path.join(rootDir, "runtime.pid"),
    lockFile: path.join(rootDir, "runtime.lock"),
    // macOS caps Unix domain socket paths at 104 chars (BSD), Linux at 108.
    // The hash + base dir keep POSIX socket files well under that.
    socketPath,
    cliBridgeSocketPath,
    logDir,
    logFile: path.join(logDir, "runtime.log"),
    hostExecutableFile: path.join(rootDir, "host-executable.txt"),
    buildStampFile: path.join(rootDir, "build-stamp.txt"),
    pendingWorkerRestartFile: path.join(rootDir, "pending-worker-restart.json"),
    rootMarkerFile: path.join(rootDir, "root.txt"),
  };
};
