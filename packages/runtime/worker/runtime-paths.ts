import crypto from "node:crypto";
import { promises as fs } from "node:fs";
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
 * Layout under Electron's userData runtime-state root:
 *   runtime/<rootHash>/   <- machine control files
 *     ├── runtime.lock     <- flock for serializing start/stop
 *     ├── runtime.pid      <- pid of the currently-running worker
 *     ├── runtime.sock     <- Unix domain socket the host connects to on POSIX
 *     ├── host-executable.txt <- Electron executable path that spawned it
 *     └── root.txt         <- the literal stellaAppDir, for debugging
 *   logs/<rootHash>/      <- human-readable logs (colocated)
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

const RUNTIME_SUBDIR = "runtime";
const LOGS_SUBDIR = "logs";

type RuntimePathOptions = {
  platform?: NodeJS.Platform;
  /** Electron userData root for ephemeral runtime state. */
  runtimeStateDir?: string;
  /** Legacy/test-only home injection preserving the old ~/.stella layout. */
  homeDir?: string;
  /** Short POSIX socket root; defaults to a per-user directory under /tmp. */
  runtimeIpcDir?: string;
};

const resolveRuntimeStateDir = (options?: RuntimePathOptions): string => {
  if (options?.runtimeStateDir) return path.resolve(options.runtimeStateDir);
  if (options?.homeDir) {
    return path.join(path.resolve(options.homeDir), ".stella");
  }
  const configured = process.env.STELLA_RUNTIME_STATE_DIR?.trim();
  return configured
    ? path.resolve(configured)
    : path.join(os.homedir(), ".stella");
};

/**
 * Per-stellaAppDir directory for human-readable logs (worker stdout/stderr
 * plus the diagnostic error/process channels). Single source of truth shared
 * with `runtime/observability/log-paths.ts`.
 */
export const resolveLogDir = (
  stellaAppDir: string,
  options?: RuntimePathOptions,
): string =>
  path.join(
    resolveRuntimeStateDir(options),
    LOGS_SUBDIR,
    hashStellaAppDir(stellaAppDir),
  );

export type RuntimePaths = {
  rootHash: string;
  rootDir: string;
  /** Short ephemeral directory for POSIX sockets (outside long userData paths). */
  ipcDir: string;
  pidFile: string;
  lockFile: string;
  socketPath: string;
  /**
   * Companion local-IPC endpoint the worker listens on for sidecar CLI tools (e.g.
   * `stella-connect`) that need to call back into the host — currently
   * just to pop a credential dialog when an MCP call returns 401/403.
   * CLIs discover the path via the `STELLA_CLI_BRIDGE_SOCK` env var
   * injected by `runtime/kernel/tools/shell.ts`. Kept under the same
   * per-root namespace so multi-install machines don't collide; POSIX
   * socket files stay well under the 104-char BSD UDS path cap.
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
  paths: Pick<RuntimePaths, "rootDir" | "rootHash"> &
    Partial<Pick<RuntimePaths, "ipcDir">>,
  options?: { platform?: NodeJS.Platform; nonce?: string },
): string => {
  const platform = options?.platform ?? process.platform;
  const nonce = (
    options?.nonce ?? crypto.randomBytes(16).toString("hex")
  ).replace(/[^A-Za-z0-9_-]/gu, "");
  if (nonce.length < 32) {
    throw new Error(
      "CLI bridge nonce must contain at least 128 bits of entropy.",
    );
  }
  if (platform === "win32") {
    return `\\\\.\\pipe\\stella-cli-bridge-${paths.rootHash}-${nonce}`;
  }
  return path.join(paths.ipcDir ?? paths.rootDir, `b-${nonce}.sock`);
};

export const isWindowsNamedPipePath = (socketPath: string): boolean =>
  /^\\\\[.?]\\pipe\\/i.test(socketPath);

export const runtimeIpcPathUsesFilesystem = (socketPath: string): boolean =>
  !isWindowsNamedPipePath(socketPath);

export const runtimeIpcListenUrl = (socketPath: string): string =>
  isWindowsNamedPipePath(socketPath)
    ? `pipe://${socketPath}`
    : `unix://${socketPath}`;

const ensureOwnedPrivateDirectory = async (
  directory: string,
): Promise<void> => {
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await fs.lstat(directory);
  const expectedUid =
    typeof process.getuid === "function" ? process.getuid() : null;
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (expectedUid != null && stat.uid !== expectedUid) ||
    (stat.mode & 0o777) !== 0o700
  ) {
    throw new Error(
      `Runtime IPC directory is not a private owner-only directory: ${directory}`,
    );
  }
};

export const ensurePrivateRuntimeIpcDir = async (
  ipcDir: string,
): Promise<void> => {
  await ensureOwnedPrivateDirectory(path.dirname(ipcDir));
  await ensureOwnedPrivateDirectory(ipcDir);
};

export const ensureRuntimeIpcDir = async (
  paths: Pick<RuntimePaths, "ipcDir" | "socketPath">,
): Promise<void> => {
  if (!runtimeIpcPathUsesFilesystem(paths.socketPath)) return;
  await ensurePrivateRuntimeIpcDir(paths.ipcDir);
};

export const resolveRuntimePaths = (
  stellaAppDir: string,
  options?: RuntimePathOptions,
): RuntimePaths => {
  const rootHash = hashStellaAppDir(stellaAppDir);
  const baseDir = path.join(resolveRuntimeStateDir(options), RUNTIME_SUBDIR);
  const rootDir = path.join(baseDir, rootHash);
  const logDir = resolveLogDir(stellaAppDir, options);
  const platform = options?.platform ?? process.platform;
  const ipcBaseDir = path.resolve(
    options?.runtimeIpcDir?.trim() || "/tmp",
    `stella-${typeof process.getuid === "function" ? process.getuid() : "user"}`,
  );
  const ipcDir = path.join(ipcBaseDir, rootHash);
  const socketPath =
    platform === "win32"
      ? windowsNamedPipePath("runtime", rootHash)
      : path.join(ipcDir, "r.sock");
  const cliBridgeSocketPath =
    platform === "win32"
      ? windowsNamedPipePath("cli-bridge", rootHash)
      : path.join(ipcDir, "c.sock");
  return {
    rootHash,
    rootDir,
    ipcDir,
    pidFile: path.join(rootDir, "runtime.pid"),
    lockFile: path.join(rootDir, "runtime.lock"),
    // macOS caps Unix domain socket paths at 104 bytes (BSD), Linux at 108.
    // Keep sockets in a short per-user /tmp namespace; durable control files
    // and logs remain under Electron userData.
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
