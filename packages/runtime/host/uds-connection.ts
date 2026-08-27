import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { attachJsonRpcPeerToStreams } from "@stella/contracts/protocol/jsonl";
import {
  startOrAttachWorker,
  stopRunningWorker,
} from "../host/lifecycle.js";
import {
  probeRunningWorker,
  removeStaleRuntimeArtifacts,
} from "../worker/lifecycle-server.js";
import { resolveRuntimePaths } from "../worker/runtime-paths.js";
import type { WorkerConnection } from "./worker-lifecycle.js";

export type UdsWorkerConnectionFactoryOptions = {
  stellaAppDir: string;
  bunBinaryPath?: string;
  idleShutdownMs?: number;
  expectedProtocolVersion?: string;
  hostExecutablePath?: string;
  env?: NodeJS.ProcessEnv;
  onError?: (error: unknown) => void;
};

const buildProcessShim = (
  socket: Socket,
  workerPid: number,
): WorkerConnection["process"] => {
  const emitter = new EventEmitter() as WorkerConnection["process"];

  Object.assign(emitter, {
    pid: workerPid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: socket as unknown as WorkerConnection["process"]["stdin"],
    stdout: socket as unknown as WorkerConnection["process"]["stdout"],
    stderr: new EventEmitter() as unknown as WorkerConnection["process"]["stderr"],
  });

  emitter.kill = ((_signal?: string): boolean => {
    try {
      socket.end();
      return true;
    } catch {
      return false;
    }
  }) as WorkerConnection["process"]["kill"];

  const writableShim = emitter as unknown as {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  const markExited = (code: number | null, signal: NodeJS.Signals | null) => {
    if (writableShim.exitCode != null || writableShim.signalCode != null) return;
    writableShim.exitCode = code;
    writableShim.signalCode = signal;
    emitter.emit("exit", code, signal);
  };

  socket.once("close", () => markExited(0, null));
  socket.once("end", () => markExited(0, null));
  socket.once("error", () => markExited(1, null));

  return emitter;
};

export const buildUdsConnectionFactory = (
  options: UdsWorkerConnectionFactoryOptions,
) => {
  return async (workerEntryPath: string): Promise<WorkerConnection> => {
    const lifecycle = await startOrAttachWorker({
      stellaAppDir: options.stellaAppDir,
      workerEntryPath,
      ...(options.bunBinaryPath ? { bunBinaryPath: options.bunBinaryPath } : {}),
      ...(options.idleShutdownMs
        ? { idleShutdownMs: options.idleShutdownMs }
        : {}),
      ...(options.expectedProtocolVersion
        ? { expectedProtocolVersion: options.expectedProtocolVersion }
        : {}),
      ...(options.hostExecutablePath
        ? { hostExecutablePath: options.hostExecutablePath }
        : {}),
      env: options.env ?? {},
    });

    const { peer } = attachJsonRpcPeerToStreams({
      input: lifecycle.socket,
      output: lifecycle.socket,
      onError: options.onError ?? ((error) => {
        console.error("[runtime-host] worker RPC error:", error);
      }),
    });

    return {
      process: buildProcessShim(lifecycle.socket, lifecycle.pid),
      peer,
      pid: lifecycle.pid,
      attachedToExistingWorker: !lifecycle.spawned,
    };
  };
};

export const killDetachedWorker = async (
  stellaAppDir: string,
): Promise<void> => {
  await stopRunningWorker(stellaAppDir, { graceMs: 1_500 });
};

export const retireDetachedWorkerRoot = async (
  stellaAppDir: string,
): Promise<{ stopped: boolean; pid: number | null }> => {
  const result = await stopRunningWorker(stellaAppDir, { graceMs: 1_500 });
  const remainingPid = await probeRunningWorker(stellaAppDir);
  if (remainingPid != null) {
    throw new Error(
      `Runtime worker ${remainingPid} did not stop while retiring ${JSON.stringify(stellaAppDir)}.`,
    );
  }
  await removeStaleRuntimeArtifacts(stellaAppDir);
  await rm(resolveRuntimePaths(stellaAppDir).rootDir, {
    recursive: true,
    force: true,
  });
  return result;
};
