import { spawn } from "node:child_process";
import { attachJsonRpcPeerToStreams } from "@stella/contracts/protocol/jsonl";
import { resolveBunBinaryPath } from "./lifecycle.js";
import type { WorkerConnection } from "./worker-lifecycle.js";

/**
 * Private-worker WorkerConnection factory: spawns the worker entry as a
 * regular stdio child owned by this host process (the worker's default
 * `stdio://` listen mode). Unlike the detached UDS factory, the child's
 * lifetime is tied to the host — closing stdin or SIGTERM tears it down —
 * and it never touches the shared `~/.stella/runtime/<rootHash>/` control
 * files, so a headless/test host can run alongside a live desktop app
 * without attaching to (or restarting) the desktop's detached worker.
 */
export type StdioWorkerConnectionFactoryOptions = {
  bunBinaryPath?: string;
  /** Extra env merged onto the inherited process env for the child. */
  env?: NodeJS.ProcessEnv;
  onError?: (error: unknown) => void;
};

export const buildStdioConnectionFactory = (
  options: StdioWorkerConnectionFactoryOptions = {},
) => {
  return async (workerEntryPath: string): Promise<WorkerConnection> => {
    const bunBinaryPath = options.bunBinaryPath ?? resolveBunBinaryPath();
    const child = spawn(bunBinaryPath, ["run", workerEntryPath], {
      // stderr is inherited so worker diagnostics surface on the host's
      // stderr instead of disappearing (stdout carries the JSON-RPC frames).
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
        // Post-spawn child errors should be diagnostic, never an uncaught
        // host-process exception.
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
      // The lifecycle controller only reads pid/exitCode/kill()/events from
      // this shape; a real stdio child satisfies it directly (stderr is
      // inherited rather than piped, hence the cast).
      process: child as unknown as WorkerConnection["process"],
      peer,
      pid: child.pid ?? -1,
      attachedToExistingWorker: false,
    };
  };
};
