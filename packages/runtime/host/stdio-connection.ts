import { spawn } from "node:child_process";
import { attachJsonRpcPeerToStreams } from "@stella/contracts/protocol/jsonl";
import { resolveBunBinaryPath } from "./lifecycle.js";
import type { WorkerConnection } from "./worker-lifecycle.js";

export type StdioWorkerConnectionFactoryOptions = {
  bunBinaryPath?: string;

  env?: NodeJS.ProcessEnv;
  onError?: (error: unknown) => void;
};

export const buildStdioConnectionFactory = (
  options: StdioWorkerConnectionFactoryOptions = {},
) => {
  return async (workerEntryPath: string): Promise<WorkerConnection> => {
    const bunBinaryPath = options.bunBinaryPath ?? resolveBunBinaryPath();
    const child = spawn(bunBinaryPath, ["run", workerEntryPath], {

      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        STELLA_BUN_PATH: bunBinaryPath,
        ...(options.env ?? {}),
      },
    });
    await new Promise<void>((resolve, reject) => {
      const onSpawnError = (error: Error) => {
        reject(
          new Error(
            `Failed to launch runtime worker via ${bunBinaryPath}: ${error.message}`,
            { cause: error },
          ),
        );
      };
      child.once("spawn", () => {
        child.off("error", onSpawnError);

        child.on("error", (error) => {
          console.error("[runtime-host] stdio worker process error:", error);
        });
        resolve();
      });
      child.once("error", onSpawnError);
    });
    const { peer } = attachJsonRpcPeerToStreams({
      input: child.stdout,
      output: child.stdin,
      onError:
        options.onError ??
        ((error) => {
          console.error("[runtime-host] worker RPC error:", error);
        }),
    });
    return {

      process: child as unknown as WorkerConnection["process"],
      peer,
      pid: child.pid ?? -1,
      attachedToExistingWorker: false,
    };
  };
};
