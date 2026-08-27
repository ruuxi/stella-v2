import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  promises as fsPromises,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  runtimeIpcListenUrl,
  runtimeIpcPathUsesFilesystem,
  resolveRuntimePaths,
  type RuntimePaths,
} from "../worker/runtime-paths.js";
import {
  STELLA_RUNTIME_READY_METHOD,
  type RuntimeInitializeResult,
} from "@stella/contracts/protocol";
import {
  probeRunningWorker,
  removeStaleRuntimeArtifacts,
} from "../worker/lifecycle-server.js";
import { rotateLogIfOversized } from "../observability/rotate-file.js";
import { getFileLogger } from "../observability/file-logger.js";

const START_POLL_INTERVAL_MS = 50;

const START_TIMEOUT_MS = 30_000;
const SOCKET_CONNECT_TIMEOUT_MS = 1_000;
const HOST_LOCK_TIMEOUT_MS = 75_000;
const WORKER_READY_PROBE_ID = "__stella_runtime_ready_probe__";

type ReadyProbeResult = "ready" | "version-mismatch" | "unavailable";

export type LifecycleConnection = {
  socket: Socket;
  pid: number;
  paths: RuntimePaths;

  spawned: boolean;
};

export type LifecycleStartOptions = {
  stellaAppDir: string;
  workerEntryPath: string;
  bunBinaryPath?: string;
  idleShutdownMs?: number;

  env?: NodeJS.ProcessEnv;
  expectedProtocolVersion?: string;
  hostExecutablePath?: string;
};

const tryConnectSocket = async (
  socketPath: string,
  timeoutMs: number,
): Promise<Socket | null> => {
  if (runtimeIpcPathUsesFilesystem(socketPath) && !existsSync(socketPath)) {
    return null;
  }
  return await new Promise<Socket | null>((resolve) => {
    let socket: Socket;
    try {
      socket = createConnection(socketPath);
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (result: Socket | null) => {
      if (settled) return;
      settled = true;
      if (result == null) {
        try {
          socket.destroy();
        } catch {

        }
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      finish(socket);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      finish(null);
    });
  });
};

const probeWorkerRpcReadiness = async (
  socket: Socket,
  timeoutMs: number,
  expectedProtocolVersion?: string,
): Promise<ReadyProbeResult> => {
  return await new Promise<ReadyProbeResult>((resolve) => {
    let buffer = "";
    let settled = false;
    const finish = (result: ReadyProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            const message = JSON.parse(line) as {
              id?: unknown;
              result?: unknown;
              error?: unknown;
            };
            if (message.id === WORKER_READY_PROBE_ID) {
              if (message.error) {
                finish("unavailable");
                return;
              }
              const result = message.result as
                | Partial<RuntimeInitializeResult>
                | undefined;
              if (
                expectedProtocolVersion &&
                result?.protocolVersion !== expectedProtocolVersion
              ) {
                finish("version-mismatch");
                return;
              }
              finish("ready");
              return;
            }
          } catch {

          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    };
    const onError = () => finish("unavailable");
    const timer = setTimeout(() => finish("unavailable"), timeoutMs);
    timer.unref?.();
    socket.on("data", onData);
    socket.once("error", onError);
    socket.write(
      `${JSON.stringify({
        id: WORKER_READY_PROBE_ID,
        method: STELLA_RUNTIME_READY_METHOD,
      })}\n`,
    );
  });
};

const tryConnectReadySocket = async (
  socketPath: string,
  timeoutMs: number,
  expectedProtocolVersion?: string,
): Promise<
  | { status: "ready"; socket: Socket }
  | { status: "version-mismatch" | "unavailable" }
> => {
  const probeSocket = await tryConnectSocket(socketPath, timeoutMs);
  if (!probeSocket) return { status: "unavailable" };
  const ready = await probeWorkerRpcReadiness(
    probeSocket,
    timeoutMs,
    expectedProtocolVersion,
  );
  probeSocket.destroy();
  if (ready !== "ready") return { status: ready };

  const socket = await tryConnectSocket(socketPath, timeoutMs);
  return socket ? { status: "ready", socket } : { status: "unavailable" };
};

const hostExecutableMatches = async (
  paths: RuntimePaths,
  expectedHostExecutablePath?: string,
): Promise<boolean> => {
  if (!expectedHostExecutablePath) return true;
  try {
    const raw = await fsPromises.readFile(paths.hostExecutableFile, "utf-8");
    return raw.trim() === expectedHostExecutablePath;
  } catch {
    return false;
  }
};

const acquireHostLock = async (lockFile: string): Promise<number> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < HOST_LOCK_TIMEOUT_MS) {
    try {
      const fd = openSync(lockFile, "wx");
      try {
        writeFileSync(fd, String(process.pid), "utf-8");
      } catch (error) {
        closeSync(fd);
        await fsPromises.unlink(lockFile).catch(() => undefined);
        throw error;
      }
      return fd;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      await delay(50);

      try {
        const raw = await fsPromises.readFile(lockFile, "utf-8");
        const pid = Number.parseInt(raw.trim(), 10);
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);

            continue;
          } catch {

          }
        }

        const stalePath = `${lockFile}.${process.pid}.stale`;
        try {
          await fsPromises.rename(lockFile, stalePath);
        } catch {

          continue;
        }
        await fsPromises.unlink(stalePath).catch(() => undefined);
      } catch {

      }
    }
  }
  throw new Error(
    `Timed out acquiring runtime host lock at ${lockFile} after ${HOST_LOCK_TIMEOUT_MS}ms.`,
  );
};

const releaseHostLock = async (
  lockFile: string,
  fd: number,
): Promise<void> => {
  try {
    closeSync(fd);
  } catch {

  }
  await fsPromises.unlink(lockFile).catch(() => undefined);
};

let cachedBunBinaryPath: string | null = null;
export const resolveBunBinaryPath = (): string => {
  if (cachedBunBinaryPath) return cachedBunBinaryPath;
  const candidates: string[] = [];
  const add = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed) candidates.push(trimmed);
  };
  add(process.env.STELLA_BUN_PATH);
  add(process.env.BUN_PATH);
  const resourcesPath = process.env.STELLA_APP_RESOURCES_PATH?.trim();
  if (resourcesPath) {
    add(
      join(
        resourcesPath,
        "bin",
        process.platform === "win32" ? "bun.exe" : "bun",
      ),
    );
  }
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

const spawnDetachedWorker = (
  options: LifecycleStartOptions,
  paths: RuntimePaths,
): { child: ChildProcess; bunBinaryPath: string } => {
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

  mkdirSync(paths.logDir, { recursive: true });
  rotateLogIfOversized(paths.logFile);
  const logFd = openSync(paths.logFile, "a");

  let transpilerCachePath: string | undefined;
  try {
    transpilerCachePath = join(paths.rootDir, "bun-transpiler-cache");
    mkdirSync(transpilerCachePath, { recursive: true });
  } catch {
    transpilerCachePath = undefined;
  }
  let child: ChildProcess;
  const bunBinaryPath = options.bunBinaryPath ?? resolveBunBinaryPath();
  try {
    if (options.env?.NODE_ENV === "development") {
      console.warn(`[runtime-host] Detached worker logs: ${paths.logFile}`);
    }
    child = spawn(bunBinaryPath, args, {
      detached: process.platform !== "win32",
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        STELLA_BUN_PATH: bunBinaryPath,
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
  return { child, bunBinaryPath };
};

const waitForWorkerSpawn = ({
  child,
  bunBinaryPath,
}: ReturnType<typeof spawnDetachedWorker>): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);

      child.on("error", (error) => {
        console.error("[runtime-host] Detached worker process error:", error);
      });
      resolve();
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(
        new Error(
          `Failed to launch Stella's bundled runtime at ${bunBinaryPath}: ${error.message}`,
          { cause: error },
        ),
      );
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });

const pollForWorkerReady = async (
  paths: RuntimePaths,
  timeoutMs: number,
  expectedProtocolVersion?: string,
): Promise<Socket> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const socket = await tryConnectReadySocket(
      paths.socketPath,
      SOCKET_CONNECT_TIMEOUT_MS,
      expectedProtocolVersion,
    );
    if (socket.status === "ready") return socket.socket;
    if (socket.status === "version-mismatch") {
      throw new Error(
        `Runtime worker protocol mismatch while waiting for socket=${paths.socketPath}.`,
      );
    }
    await delay(START_POLL_INTERVAL_MS);
  }
  throw new Error(
    `Timed out waiting for runtime worker to become ready (socket=${paths.socketPath}).`,
  );
};

const findSameRootWorkerPids = async (
  workerEntryPath: string,
  stellaAppDir: string,
): Promise<number[]> => {
  if (process.platform === "win32") {
    const powerShellLiteral = (value: string) =>
      `'${value.replace(/'/g, "''")}'`;
    const uniquePathVariants = (value: string) =>
      [value, value.replace(/\//g, "\\"), value.replace(/\\/g, "/")].filter(
        (entry, index, list) => entry && list.indexOf(entry) === index,
      );
    const powerShellArray = (values: string[]) =>
      `@(${values.map(powerShellLiteral).join(",")})`;
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$entries = ${powerShellArray(uniquePathVariants(workerEntryPath))}`,
      `$roots = ${powerShellArray(uniquePathVariants(stellaAppDir))}`,
      `$currentPid = ${process.pid}`,
      "$stellaPids = @()",
      "$processes = Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%--stella-root%'\"",
      "foreach ($proc in $processes) {",
      "  $line = [string]$proc.CommandLine",
      "  if (-not $line -or [int]$proc.ProcessId -eq $currentPid) { continue }",
      "  $entryMatch = $false",
      "  foreach ($entry in $entries) { if ($line.Contains($entry)) { $entryMatch = $true; break } }",
      "  if (-not $entryMatch) { continue }",
      "  $rootMatch = $false",
      "  foreach ($root in $roots) { if ($line.Contains('--stella-root') -and $line.Contains($root)) { $rootMatch = $true; break } }",
      "  if ($rootMatch) { $stellaPids += [int]$proc.ProcessId }",
      "}",
      "$stellaPids | ConvertTo-Json -Compress",
    ].join("; ");
    const output = await new Promise<string>((resolve) => {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          script,
        ],
        { windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          resolve(error ? "" : stdout);
        },
      );
    });
    const raw = output.trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      const values = Array.isArray(parsed) ? parsed : [parsed];
      return values
        .map((value) =>
          typeof value === "number"
            ? value
            : typeof value === "string"
              ? Number.parseInt(value, 10)
              : Number.NaN,
        )
        .filter(
          (pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid,
        );
    } catch {
      return [];
    }
  }
  const psOutput = await new Promise<string>((resolve) => {
    execFile("ps", ["-axo", "pid=,args="], (error, stdout) => {
      resolve(error ? "" : stdout);
    });
  });
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1] ?? "", 10);
    const args = match[2] ?? "";
    if (
      Number.isInteger(pid) &&
      pid > 0 &&
      pid !== process.pid &&
      args.includes(workerEntryPath) &&
      (args.includes(`--stella-root ${stellaAppDir}`) ||
        args.includes(`--stella-root=${stellaAppDir}`))
    ) {
      pids.push(pid);
    }
  }
  return pids;
};

const killWorkerProcess = async (
  pid: number,
  graceMs: number,
): Promise<{ stopped: boolean; escalatedToSigkill: boolean }> => {
  try {
    process.kill(pid, "SIGTERM");
  } catch {

    return { stopped: false, escalatedToSigkill: false };
  }
  const graceDeadline = Date.now() + graceMs;
  while (Date.now() < graceDeadline) {
    try {
      process.kill(pid, 0);
      await delay(50);
    } catch {
      return { stopped: true, escalatedToSigkill: false };
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return { stopped: true, escalatedToSigkill: true };
  }
  const killDeadline = Date.now() + 1_000;
  while (Date.now() < killDeadline) {
    try {
      process.kill(pid, 0);
      await delay(50);
    } catch {
      return { stopped: true, escalatedToSigkill: true };
    }
  }

  return { stopped: false, escalatedToSigkill: true };
};

const stopPids = async (pids: number[], graceMs = 750): Promise<void> => {
  if (pids.length === 0) return;

  await Promise.all(pids.map((pid) => killWorkerProcess(pid, graceMs)));
};

export const startOrAttachWorker = async (
  options: LifecycleStartOptions,
): Promise<LifecycleConnection> => {
  const paths = resolveRuntimePaths(options.stellaAppDir);
  await fsPromises.mkdir(paths.rootDir, { recursive: true });
  const hostLockFile = `${paths.lockFile}.host`;
  const fd = await acquireHostLock(hostLockFile);
  try {
    const existingPid = await probeRunningWorker(options.stellaAppDir);
    if (existingPid != null) {
      const executableMatches = await hostExecutableMatches(
        paths,
        options.hostExecutablePath,
      );
      if (!executableMatches) {
        console.warn(
          `[runtime-host] Existing worker executable mismatch; restarting detached worker (pid=${existingPid}). In-flight work cannot be preserved across host bundle changes.`,
        );
        await stopRunningWorker(options.stellaAppDir);
        await removeStaleRuntimeArtifacts(options.stellaAppDir);
      } else {
        const ready = await tryConnectReadySocket(
          paths.socketPath,
          SOCKET_CONNECT_TIMEOUT_MS,
          options.expectedProtocolVersion,
        );
        if (ready.status === "ready") {
          return { socket: ready.socket, pid: existingPid, paths, spawned: false };
        }
        if (ready.status === "version-mismatch") {
          console.warn(
            `[runtime-host] Existing worker protocol mismatch; restarting detached worker (pid=${existingPid}). In-flight work cannot be preserved across protocol changes.`,
          );
          await stopRunningWorker(options.stellaAppDir);
          await removeStaleRuntimeArtifacts(options.stellaAppDir);
        } else {

          const retry = await pollForWorkerReady(
            paths,
            2_000,
            options.expectedProtocolVersion,
          ).catch(() => null);
          if (retry) {
            return { socket: retry, pid: existingPid, paths, spawned: false };
          }

          const orphanPids = await findSameRootWorkerPids(
            options.workerEntryPath,
            options.stellaAppDir,
          );
          if (!orphanPids.includes(existingPid)) {
            console.warn(
              `[runtime-host] Stale runtime pidfile pointed at pid ${existingPid}, but that pid no longer matches this worker root; leaving the process alone.`,
            );
          }
          if (orphanPids.length > 0) {
            console.warn(
              `[runtime-host] Reaping ${orphanPids.length} stale runtime worker(s) for ${options.stellaAppDir} before spawning a fresh worker.`,
            );
            await stopPids(orphanPids);
          }
          await removeStaleRuntimeArtifacts(options.stellaAppDir);
        }
      }
    } else {

      await removeStaleRuntimeArtifacts(options.stellaAppDir);
    }

    await waitForWorkerSpawn(spawnDetachedWorker(options, paths));
    const socket = await pollForWorkerReady(
      paths,
      START_TIMEOUT_MS,
      options.expectedProtocolVersion,
    );
    const newPid = (await probeRunningWorker(options.stellaAppDir)) ?? 0;
    return { socket, pid: newPid, paths, spawned: true };
  } finally {
    await releaseHostLock(hostLockFile, fd);
  }
};

export const stopRunningWorker = async (
  stellaAppDir: string,
  options?: { graceMs?: number },
): Promise<{ stopped: boolean; pid: number | null }> => {
  const pid = await probeRunningWorker(stellaAppDir);
  if (pid == null) return { stopped: false, pid: null };
  const startedAt = Date.now();
  const result = await killWorkerProcess(pid, options?.graceMs ?? 1_500);

  getFileLogger()?.process("worker.kill-latency", {
    pid,
    ms: Date.now() - startedAt,
    escalatedToSigkill: result.escalatedToSigkill,
    stopped: result.stopped,
  });
  return { stopped: result.stopped, pid };
};
