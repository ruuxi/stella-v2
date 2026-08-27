import {
  closeSync,
  createWriteStream,
  existsSync,
  openSync,
  promises as fsPromises,
  type WriteStream,
} from "node:fs";
import { getFileLogger } from "../observability/file-logger.js";
import {
  resolveRuntimePaths,
  runtimeIpcPathUsesFilesystem,
  type RuntimePaths,
} from "./runtime-paths.js";

export type LifecycleServerOptions = {
  stellaAppDir: string;
  idleShutdownMs?: number;

  shouldKeepAlive?: () => Promise<boolean> | boolean;

  runtimeBuildStamp?: string;
  onShutdown: (reason: "idle" | "signal") => Promise<void> | void;
};

const DEFAULT_IDLE_SHUTDOWN_MS = 10_000;

const pidIsAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readPidFile = async (pidFile: string): Promise<number | null> => {
  try {
    const raw = await fsPromises.readFile(pidFile, "utf-8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

export class WorkerLifecycleServer {
  readonly paths: RuntimePaths;
  private lockFd: number | null = null;
  private logStream: WriteStream | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private clientCount = 0;
  private shuttingDown = false;
  private readonly idleShutdownMs: number;

  constructor(private readonly options: LifecycleServerOptions) {
    this.paths = resolveRuntimePaths(options.stellaAppDir);
    this.idleShutdownMs = options.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
  }

  async start(): Promise<void> {
    await fsPromises.mkdir(this.paths.rootDir, { recursive: true });

    await fsPromises.mkdir(this.paths.logDir, { recursive: true });

    if (existsSync(this.paths.lockFile)) {
      const stalePid = await readPidFile(this.paths.lockFile);
      if (stalePid != null && !pidIsAlive(stalePid)) {
        await fsPromises.unlink(this.paths.lockFile).catch(() => undefined);
        getFileLogger()?.process("worker.stale-lock-cleared", {
          stalePid,
          rootHash: this.paths.rootHash,
        });
      }
    }

    try {
      this.lockFd = openSync(this.paths.lockFile, "wx");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        throw new Error(
          `Another runtime worker is already running for ${this.options.stellaAppDir} (lock at ${this.paths.lockFile}).`,
        );
      }
      throw error;
    }

    await fsPromises.writeFile(
      this.paths.lockFile,
      String(process.pid),
      "utf-8",
    );
    await fsPromises.writeFile(
      this.paths.pidFile,
      String(process.pid),
      "utf-8",
    );
    await fsPromises.writeFile(
      this.paths.rootMarkerFile,
      `${this.options.stellaAppDir}\n`,
      "utf-8",
    );
    const hostExecutablePath = process.env.STELLA_HOST_EXECUTABLE_PATH;
    if (hostExecutablePath) {
      await fsPromises.writeFile(
        this.paths.hostExecutableFile,
        `${hostExecutablePath}\n`,
        "utf-8",
      );
    }
    if (this.options.runtimeBuildStamp) {
      await fsPromises.writeFile(
        this.paths.buildStampFile,
        `${this.options.runtimeBuildStamp}\n`,
        "utf-8",
      );
    } else {

      await fsPromises.unlink(this.paths.buildStampFile).catch(() => undefined);
    }

    this.logStream = createWriteStream(this.paths.logFile, {
      flags: "a",
      encoding: "utf-8",
    });
    this.logStream.write(
      `\n[${new Date().toISOString()}] worker pid=${process.pid} listening (root=${this.options.stellaAppDir})\n`,
    );
    getFileLogger()?.process("worker.listening", {
      pid: process.pid,
      rootHash: this.paths.rootHash,
      idleShutdownMs: this.idleShutdownMs,

      startupMs: Math.round(process.uptime() * 1000),
    });

    this.scheduleIdleShutdown();
  }

  noteClientConnected() {
    this.clientCount += 1;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  noteClientDisconnected() {
    this.clientCount = Math.max(0, this.clientCount - 1);
    if (this.clientCount > 0) return;
    this.scheduleIdleShutdown();
  }

  private scheduleIdleShutdown() {
    if (this.shuttingDown) return;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.evaluateIdleShutdown();
    }, this.idleShutdownMs);
    this.idleTimer.unref?.();
  }

  private async evaluateIdleShutdown() {
    if (this.shuttingDown || this.clientCount > 0) return;
    const keepAlive = await Promise.resolve(
      this.options.shouldKeepAlive?.() ?? false,
    ).catch((error) => {
      this.logStream?.write(
        `[${new Date().toISOString()}] keep-alive check failed: ${(error as Error).message}\n`,
      );

      return true;
    });
    if (keepAlive) {
      this.logStream?.write(
        `[${new Date().toISOString()}] worker has active work; delaying idle shutdown\n`,
      );
      this.scheduleIdleShutdown();
      return;
    }
    this.logStream?.write(
      `[${new Date().toISOString()}] worker idle for ${this.idleShutdownMs}ms with no active work, shutting down\n`,
    );
    await this.shutdown("idle");
  }

  async shutdown(reason: "idle" | "signal"): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    getFileLogger()?.process("worker.shutdown", {
      pid: process.pid,
      reason,
    });
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    try {
      await this.options.onShutdown(reason);
    } catch (error) {
      this.logStream?.write(
        `[${new Date().toISOString()}] shutdown handler error: ${(error as Error).message}\n`,
      );
      getFileLogger()?.error("worker.shutdown-handler-error", {
        reason,
        error,
      });
    }
    await this.releaseFiles();
    this.logStream?.end();
    this.logStream = null;
  }

  private async releaseFiles() {
    if (this.lockFd != null) {
      try {
        closeSync(this.lockFd);
      } catch {

      }
      this.lockFd = null;
    }
    await fsPromises.unlink(this.paths.lockFile).catch(() => undefined);
    await fsPromises.unlink(this.paths.pidFile).catch(() => undefined);
  }
}

export const probeRunningWorker = async (
  stellaAppDir: string,
): Promise<number | null> => {
  const paths = resolveRuntimePaths(stellaAppDir);
  if (!existsSync(paths.pidFile)) return null;
  const pid = await readPidFile(paths.pidFile);
  if (pid == null || !pidIsAlive(pid)) return null;
  return pid;
};

export const removeStaleRuntimeArtifacts = async (
  stellaAppDir: string,
): Promise<void> => {
  const paths = resolveRuntimePaths(stellaAppDir);
  const maybeFilePaths = [
    paths.pidFile,
    paths.lockFile,
    paths.hostExecutableFile,
    paths.buildStampFile,
  ];
  if (runtimeIpcPathUsesFilesystem(paths.socketPath)) {
    maybeFilePaths.push(paths.socketPath);
  }
  if (runtimeIpcPathUsesFilesystem(paths.cliBridgeSocketPath)) {
    maybeFilePaths.push(paths.cliBridgeSocketPath);
  }
  for (const filePath of maybeFilePaths) {
    await fsPromises.unlink(filePath).catch(() => undefined);
  }
};

export const ensureRuntimeRootDir = async (
  stellaAppDir: string,
): Promise<RuntimePaths> => {
  const paths = resolveRuntimePaths(stellaAppDir);
  await fsPromises.mkdir(paths.rootDir, { recursive: true });
  return paths;
};
