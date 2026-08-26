import { AsyncLocalStorage } from "node:async_hooks";
import { Deferred, Effect } from "effect";
import { acquireAbortLatch } from "../agent-core/abort-bridge.js";
import { runComputerUseEffect } from "./effect-runtime.js";

type ComputerExecutionContext = {
  cwd: string;
  cliPath?: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  stdout: string[];
  stderr: string[];
  outputBytes: number;
  maxOutputBytes: number;
  timeoutMs?: number;
};

export type ComputerExecutionContextOptions = {
  cwd?: string;
  cliPath?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  timeoutMs?: number;
};

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const storage = new AsyncLocalStorage<ComputerExecutionContext>();

const context = () => storage.getStore();

const abortError = (signal: AbortSignal) =>
  signal.reason instanceof Error
    ? signal.reason
    : new Error("Computer command aborted.");

const append = (target: "stdout" | "stderr", value: string) => {
  const active = context();
  if (!active) {
    (target === "stdout" ? process.stdout : process.stderr).write(value);
    return;
  }
  active.outputBytes += Buffer.byteLength(value, "utf8");
  if (active.outputBytes > active.maxOutputBytes) {
    throw new Error(
      `Computer command output exceeded the ${active.maxOutputBytes}-byte limit.`,
    );
  }
  active[target].push(value);
};

export const writeComputerStdout = (value: string) => append("stdout", value);
export const writeComputerStderr = (value: string) => append("stderr", value);

export const getComputerExecutionEnv = () => context()?.env ?? process.env;
export const getComputerExecutionCwd = () => context()?.cwd ?? process.cwd();
export const getComputerExecutionCliPath = () => context()?.cliPath;
export const getComputerExecutionSignal = () => context()?.signal;
export const getComputerExecutionTimeoutMs = () => context()?.timeoutMs;

export const throwIfComputerExecutionAborted = () => {
  const signal = getComputerExecutionSignal();
  if (signal?.aborted) throw abortError(signal);
};

/**
 * Abortable delay for computer-use polling loops. The wait is an Effect:
 * `Effect.sleep(ms)` raced against the caller's abort latch
 * (`acquireAbortLatch` — a scoped listener registration removed on every
 * exit path), replacing the hand-rolled setTimeout/abort-listener pair.
 * Rejection reasons are byte-identical: `signal.reason` when it is an
 * Error, otherwise `new Error("Computer command aborted.")`.
 */
export const abortableComputerDelay = async (ms: number) => {
  const signal = getComputerExecutionSignal();
  if (signal?.aborted) throw abortError(signal);
  await runComputerUseEffect(
    Effect.scoped(
      Effect.gen(function* () {
        if (!signal) {
          return yield* Effect.sleep(ms);
        }
        const abortLatch = yield* acquireAbortLatch(signal);
        yield* Effect.raceFirst(
          Effect.sleep(ms),
          Deferred.await(abortLatch).pipe(
            Effect.flatMap(() => Effect.fail(abortError(signal))),
          ),
        );
      }),
    ),
  );
};

export const runWithComputerExecutionContext = async <T>(
  options: ComputerExecutionContextOptions,
  operation: () => Promise<T>,
): Promise<{ value: T; stdout: string; stderr: string }> => {
  const active: ComputerExecutionContext = {
    cwd: options.cwd ?? process.cwd(),
    cliPath: options.cliPath,
    env: options.env ?? process.env,
    signal: options.signal,
    stdout: [],
    stderr: [],
    outputBytes: 0,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    timeoutMs: options.timeoutMs,
  };
  return await storage.run(active, async () => {
    throwIfComputerExecutionAborted();
    const value = await operation();
    throwIfComputerExecutionAborted();
    return {
      value,
      stdout: active.stdout.join(""),
      stderr: active.stderr.join(""),
    };
  });
};
