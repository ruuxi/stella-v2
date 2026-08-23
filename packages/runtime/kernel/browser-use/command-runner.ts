import { spawn } from "node:child_process";
import { Deferred, Effect } from "effect";

import { acquireAbortLatch } from "../agent-core/abort-bridge.js";
import {
  browserUseRuntime,
  runBrowserUseEffect,
} from "./effect-runtime.js";

export const DEFAULT_BROWSER_COMMAND_TIMEOUT_MS = 30_000;
export const DEFAULT_BROWSER_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type BrowserCommandRequest = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
};

export type BrowserCommandProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type BrowserCommandRunner = (
  request: BrowserCommandRequest,
) => Promise<BrowserCommandProcessResult>;

export type BrowserCommandRunnerErrorCode =
  | "aborted"
  | "output_limit"
  | "spawn_failed"
  | "timeout";

export class BrowserCommandRunnerError extends Error {
  readonly code: BrowserCommandRunnerErrorCode;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    code: BrowserCommandRunnerErrorCode,
    message: string,
    options: {
      stdout?: string;
      stderr?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "BrowserCommandRunnerError";
    this.code = code;
    this.stdout = options.stdout ?? "";
    this.stderr = options.stderr ?? "";
  }
}

const requirePositiveInteger = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
};

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new BrowserCommandRunnerError("aborted", "Browser command aborted.");

const diagnosticSuffix = (stdout: string, stderr: string): string => {
  const detail = stderr.trim() || stdout.trim();
  if (!detail) return "";
  const maxChars = 4_096;
  const bounded =
    detail.length <= maxChars
      ? detail
      : `${detail.slice(0, maxChars)}\n[diagnostic truncated]`;
  return `\n${bounded}`;
};

type SpawnedBrowserChild = ReturnType<typeof spawn>;

/**
 * TERM→1s→KILL ladder (the shell.ts pattern). The escalation is a forked
 * fiber racing the child's `exit` event against a 1s sleep: if the child is
 * still alive at the deadline it is SIGKILLed; if it exits first the fiber
 * ends immediately. Bounded to 1s of fiber lifetime per invocation.
 */
const terminateBrowserChild = (child: SpawnedBrowserChild) => {
  if (child.exitCode === null && !child.killed) child.kill();
  browserUseRuntime.runFork(
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

// Effect-native spine behind the exact pre-Effect signature, error codes,
// and error strings: the spawned stella-browser helper is a scoped resource
// (an interrupted or failed command window provably reaps it via the
// TERM→1s→KILL ladder), the timeout and abort waits are fibers interrupted
// at scope close, and the caller's AbortSignal crosses in through
// `acquireAbortLatch` (cooperative cancel; identical rejection reasons).
export const runBrowserCommand: BrowserCommandRunner = async (request) => {
  requirePositiveInteger(request.timeoutMs, "timeoutMs");
  requirePositiveInteger(request.maxOutputBytes, "maxOutputBytes");

  if (request.signal?.aborted) {
    throw abortReason(request.signal);
  }

  return await runBrowserUseEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const done = Deferred.makeUnsafe<
          BrowserCommandProcessResult,
          Error
        >();
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let outputBytes = 0;
        let settled = false;

        const capturedOutput = () => ({
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
        });
        const settle = (
          child: SpawnedBrowserChild,
          outcome: Effect.Effect<BrowserCommandProcessResult, Error>,
          kill = false,
        ) => {
          if (settled) return;
          settled = true;
          if (kill && child.exitCode === null && !child.killed) {
            terminateBrowserChild(child);
          }
          Deferred.doneUnsafe(done, outcome);
        };

        // Spawn AND event wiring happen inside one synchronous acquire, so
        // no fiber yield can slip between them and drop a next-tick `error`
        // or early output event (the same atomicity the old promise
        // executor's synchronous body provided).
        const child = yield* Effect.acquireRelease(
          Effect.try({
            try: () => {
              const spawned = spawn(request.command, request.args, {
                cwd: request.cwd,
                env: request.env,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
              });
              const failWithOutput = (
                code: BrowserCommandRunnerErrorCode,
                message: string,
                cause?: unknown,
              ) => {
                const output = capturedOutput();
                settle(
                  spawned,
                  Effect.fail(
                    new BrowserCommandRunnerError(
                      code,
                      `${message}${diagnosticSuffix(output.stdout, output.stderr)}`,
                      { ...output, cause },
                    ),
                  ),
                  true,
                );
              };
              const append = (target: Buffer[], chunk: Buffer) => {
                if (settled) return;
                const remaining = request.maxOutputBytes - outputBytes;
                if (chunk.byteLength <= remaining) {
                  target.push(chunk);
                  outputBytes += chunk.byteLength;
                  return;
                }
                if (remaining > 0) {
                  target.push(chunk.subarray(0, remaining));
                }
                outputBytes = request.maxOutputBytes;
                failWithOutput(
                  "output_limit",
                  `stella-browser output exceeded the ${request.maxOutputBytes}-byte limit.`,
                );
              };
              spawned.stdout?.on("data", (chunk: Buffer) =>
                append(stdoutChunks, chunk),
              );
              spawned.stderr?.on("data", (chunk: Buffer) =>
                append(stderrChunks, chunk),
              );
              spawned.once("error", (cause) => {
                failWithOutput(
                  "spawn_failed",
                  `Failed to run stella-browser: ${cause.message}`,
                  cause,
                );
              });
              spawned.once("close", (exitCode) => {
                const output = capturedOutput();
                settle(
                  spawned,
                  Effect.succeed({
                    exitCode: exitCode ?? 1,
                    ...output,
                  }),
                );
              });
              return spawned;
            },
            catch: (cause) =>
              new BrowserCommandRunnerError(
                "spawn_failed",
                `Failed to start stella-browser: ${cause instanceof Error ? cause.message : String(cause)}`,
                { cause },
              ),
          }),
          (spawned, exit) =>
            Effect.sync(() => {
              // Every settle path already handled the child (kill paths ran
              // the ladder; close means it is gone). A scope exit without a
              // settle — interruption or a defect inside the window — reaps
              // a still-live child so the process provably cannot outlive
              // the command window.
              if (
                exit._tag !== "Success" &&
                !settled &&
                spawned.exitCode === null &&
                !spawned.killed
              ) {
                terminateBrowserChild(spawned);
              }
            }),
        );

        const failWithOutputLate = (
          code: BrowserCommandRunnerErrorCode,
          message: string,
          cause?: unknown,
        ) => {
          const output = capturedOutput();
          settle(
            child,
            Effect.fail(
              new BrowserCommandRunnerError(
                code,
                `${message}${diagnosticSuffix(output.stdout, output.stderr)}`,
                { ...output, cause },
              ),
            ),
            true,
          );
        };

        const abortLatch = yield* acquireAbortLatch(request.signal);
        yield* Effect.forkScoped(
          Deferred.await(abortLatch).pipe(
            Effect.flatMap(() =>
              Effect.sync(() =>
                settle(child, Effect.fail(abortReason(request.signal!)), true),
              ),
            ),
          ),
        );
        yield* Effect.forkScoped(
          Effect.sleep(request.timeoutMs).pipe(
            Effect.flatMap(() =>
              Effect.sync(() =>
                failWithOutputLate(
                  "timeout",
                  `stella-browser timed out after ${request.timeoutMs}ms.`,
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
