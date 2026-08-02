import { spawn } from "node:child_process";
import { Deferred, Effect } from "effect";

import { acquireAbortLatch } from "../agent-core/abort-bridge.js";
import {
  computerUseRuntime,
  runComputerUseEffect,
} from "./effect-runtime.js";
import {
  executeStellaComputerCommand,
  type StellaComputerExecutionOptions,
  type StellaComputerExecutionResult,
} from "./stella-computer-executor.js";

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type ComputerCommandRequest = {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes?: number;
};

export type ComputerCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ComputerCommandRunner = (
  request: ComputerCommandRequest,
) => Promise<ComputerCommandResult>;

export type StellaComputerExecutor = (
  argv: string[],
  options?: StellaComputerExecutionOptions,
) => Promise<StellaComputerExecutionResult>;

export const createInProcessComputerCommandRunner =
  (
    executor: StellaComputerExecutor = executeStellaComputerCommand,
  ): ComputerCommandRunner =>
  async (request) => {
    if (request.signal?.aborted) {
      throw request.signal.reason instanceof Error
        ? request.signal.reason
        : new Error("Computer command aborted.");
    }
    if (request.command !== process.execPath) {
      throw new Error(
        `In-process computer runner only accepts process.execPath requests, received ${request.command}.`,
      );
    }
    if (request.args.length === 0) {
      throw new Error(
        "In-process computer runner requires a CLI adapter path.",
      );
    }
    return await executor(request.args.slice(1), {
      cwd: request.cwd,
      cliPath: request.args[0],
      env: request.env,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
    });
  };

export const runComputerCommandInProcess =
  createInProcessComputerCommandRunner();

type SpawnedComputerChild = ReturnType<typeof spawn>;

/**
 * TERM→1s→KILL ladder (the shell.ts pattern). The escalation is a forked
 * fiber racing the child's `exit` event against a 1s sleep: if the child is
 * still alive at the deadline it is SIGKILLed; if it exits first the fiber
 * ends immediately. Bounded to 1s of fiber lifetime per invocation.
 */
const terminateComputerChild = (child: SpawnedComputerChild) => {
  if (child.exitCode === null) child.kill();
  computerUseRuntime.runFork(
    Effect.gen(function* () {
      const exited = yield* Deferred.make<void>();
      const onExit = () => {
        Deferred.doneUnsafe(exited, Effect.void);
      };
      child.once("exit", onExit);
      yield* Effect.ensuring(
        Effect.raceFirst(Effect.sleep(1_000), Deferred.await(exited)),
        Effect.sync(() => {
          child.removeListener("exit", onExit);
        }),
      );
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore cleanup errors when the child already exited.
        }
      }
    }),
  );
};

// Explicit subprocess path retained for CLI diagnostics and isolated
// execution. Effect-native spine behind the exact pre-Effect signature and
// error strings: the child is a scoped resource (an interrupted or failed
// window provably reaps it via the TERM→1s→KILL ladder), the timeout and
// abort waits are fibers interrupted at scope close, and the caller's
// AbortSignal crosses in through `acquireAbortLatch` (cooperative cancel;
// identical rejection reasons).
export const runComputerCommandSubprocess: ComputerCommandRunner = async (
  request,
) => {
  if (request.signal?.aborted) {
    throw request.signal.reason instanceof Error
      ? request.signal.reason
      : new Error("Computer command aborted.");
  }

  return await runComputerUseEffect(
    Effect.scoped(
      Effect.gen(function* () {
        let stdout = "";
        let stderr = "";
        let outputBytes = 0;
        let settled = false;
        const done = Deferred.makeUnsafe<ComputerCommandResult, Error>();

        const settle = (
          child: SpawnedComputerChild,
          outcome: Effect.Effect<ComputerCommandResult, Error>,
          options: { kill?: boolean } = {},
        ) => {
          if (settled) return;
          settled = true;
          if (options.kill && child.exitCode === null) {
            terminateComputerChild(child);
          }
          Deferred.doneUnsafe(done, outcome);
        };

        // Spawn AND event wiring happen inside one synchronous acquire, so
        // no fiber yield can slip between them and drop a next-tick `error`
        // or early output event (the same atomicity the old promise
        // executor's synchronous body provided).
        const child = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const child = spawn(request.command, request.args, {
              cwd: request.cwd,
              env: request.env ?? process.env,
              stdio: ["ignore", "pipe", "pipe"],
              windowsHide: true,
            });
            const appendOutput = (
              target: "stdout" | "stderr",
              chunk: string,
            ) => {
              outputBytes += Buffer.byteLength(chunk, "utf8");
              const maxOutputBytes =
                request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
              if (outputBytes > maxOutputBytes) {
                settle(
                  child,
                  Effect.fail(
                    new Error(
                      `Computer command output exceeded the ${maxOutputBytes}-byte limit.`,
                    ),
                  ),
                  { kill: true },
                );
                return;
              }
              if (target === "stdout") stdout += chunk;
              else stderr += chunk;
            };
            child.stdout?.setEncoding("utf8");
            child.stderr?.setEncoding("utf8");
            child.stdout?.on("data", (chunk: string) => {
              appendOutput("stdout", chunk);
            });
            child.stderr?.on("data", (chunk: string) => {
              appendOutput("stderr", chunk);
            });
            child.once("error", (error) => settle(child, Effect.fail(error)));
            child.once("close", (exitCode) =>
              settle(
                child,
                Effect.succeed({ exitCode: exitCode ?? 1, stdout, stderr }),
              ),
            );
            return child;
          }),
          (spawned, exit) =>
            Effect.sync(() => {
              // Every settle path already handled the child (kill paths ran
              // the ladder; close/error mean it is gone). A scope exit
              // without a settle — interruption or a defect inside the
              // window — reaps a still-live child so the process provably
              // cannot outlive the operation.
              if (
                exit._tag !== "Success" &&
                !settled &&
                spawned.exitCode === null
              ) {
                terminateComputerChild(spawned);
              }
            }),
        );

        const abortLatch = yield* acquireAbortLatch(request.signal);
        yield* Effect.forkScoped(
          Deferred.await(abortLatch).pipe(
            Effect.flatMap(() =>
              Effect.sync(() =>
                settle(
                  child,
                  Effect.fail(
                    request.signal?.reason instanceof Error
                      ? request.signal.reason
                      : new Error("Computer command aborted."),
                  ),
                  { kill: true },
                ),
              ),
            ),
          ),
        );
        yield* Effect.forkScoped(
          Effect.sleep(request.timeoutMs).pipe(
            Effect.flatMap(() =>
              Effect.sync(() =>
                settle(
                  child,
                  Effect.fail(
                    new Error(
                      `Computer command timed out after ${request.timeoutMs}ms.`,
                    ),
                  ),
                  { kill: true },
                ),
              ),
            ),
          ),
        );
        return yield* Deferred.await(done);
      }),
    ),
  );
};
