import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const RUNTIME_DIR_NAME = ".stella";
const RUNTIME_SUBDIR = "runtime";
const LOGS_SUBDIR = "logs";

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

  cliBridgeSocketPath: string;

  logDir: string;
  logFile: string;
  hostExecutableFile: string;

  buildStampFile: string;

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

  if (nonce.length < 22) {
    throw new Error(
      "CLI bridge nonce must contain at least 128 bits of entropy.",
    );
  }
  if (platform === "win32") {
    return `\\\\.\\pipe\\stella-cli-bridge-${paths.rootHash}-${nonce}`;
  }

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
