/**
 * Shell processes: spawning a pipe or PTY shell, the TERM→1s→KILL ladders
 * that tear down a whole process group, and `runShell`, the one-shot
 * foreground runner.
 */

import { Deferred, Effect } from "effect";
import { spawn } from "child_process";
import { StringDecoder } from "node:string_decoder";
import type { ToolProcessIdentity } from "../types.js";
import { truncate } from "../utils.js";
import { runToolEffect, toolsRuntime } from "../effect-runtime.js";
import { sanitizeToolVisibleText } from "../safety.js";
import { isolateToolProcessLaunch } from "../process-isolation.js";
import {
  buildShellEnv,
  describeShellSpawnFailure,
  maybeSweepDeferredDeletes,
  resolveStateShellLaunch,
  type ShellLaunchOptions,
} from "./launch.js";
import type { ShellState } from "./sessions.js";

export type SpawnedShell = ReturnType<typeof spawn>;

export type SpawnedPtyShell = {
  process: Bun.Subprocess;
  terminal: Bun.Terminal;
  write: (chars: string) => Promise<void>;
  resize: (cols: number, rows: number) => void;
  close: () => void;
};

export const spawnShellProcess = (
  shell: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  windowsVerbatimArguments = false,
  processIdentity?: ToolProcessIdentity,
) => {
  const launch = isolateToolProcessLaunch({
    command: shell,
    commandArgs: args,
    identity: processIdentity,
  });
  return spawn(launch.command, launch.args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments,
    // On Unix, make the shell the leader of its own process group so timeouts
    // and manual kills can terminate the entire command tree.
    detached: process.platform !== "win32",
    ...(launch.nativeIdentity
      ? {
          uid: launch.nativeIdentity.uid,
          gid: launch.nativeIdentity.gid,
        }
      : {}),
  });
};

const DEFAULT_PTY_COLUMNS = 80;
const DEFAULT_PTY_ROWS = 24;
export const PTY_OUTPUT_SETTLE_MS = 15;
export const PTY_OUTPUT_MAX_SETTLE_MS = 100;

type PtyShellCallbacks = {
  onData: (data: string) => void;
  onExit: (
    exitCode: number | null,
    signalCode: number | null,
    error?: Error,
  ) => void;
  onTerminalExit: (exitCode: number) => void;
};

/**
 * Spawn a shell through Bun's native terminal transport. Bun maps this to
 * openpty(3) on macOS/Linux and CreatePseudoConsole (ConPTY) on Windows.
 *
 * Bun may invoke spawn callbacks before `Bun.spawn` returns, so every callback
 * crosses a microtask boundary. That guarantees startShell has installed the
 * returned transport on its managed record before lifecycle events arrive.
 */
export const spawnPtyShellProcess = (
  shell: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  windowsVerbatimArguments: boolean,
  callbacks: PtyShellCallbacks,
  processIdentity?: ToolProcessIdentity,
): SpawnedPtyShell => {
  const bunRuntime = (globalThis as typeof globalThis & { Bun?: typeof Bun })
    .Bun;
  if (!bunRuntime || typeof bunRuntime.Terminal !== "function") {
    throw new Error(
      "PTY execution requires Stella's bundled Bun runtime with Bun.Terminal support.",
    );
  }

  const drainWaiters = new Set<() => void>();
  const outputDecoder = new TextDecoder();
  const terminal = new bunRuntime.Terminal({
    cols: DEFAULT_PTY_COLUMNS,
    rows: DEFAULT_PTY_ROWS,
    name: "xterm-256color",
    data: (_terminal, data) => {
      const chunk = outputDecoder.decode(data, { stream: true });
      if (chunk) queueMicrotask(() => callbacks.onData(chunk));
    },
    drain: () => {
      const waiters = [...drainWaiters];
      drainWaiters.clear();
      for (const waiter of waiters) waiter();
    },
    exit: (_terminal, exitCode) => {
      const finalChunk = outputDecoder.decode();
      queueMicrotask(() => {
        if (finalChunk) callbacks.onData(finalChunk);
        callbacks.onTerminalExit(exitCode);
      });
    },
  });

  const launch = isolateToolProcessLaunch({
    command: shell,
    commandArgs: args,
    identity: processIdentity,
  });
  let subprocess: Bun.Subprocess;
  try {
    subprocess = bunRuntime.spawn([launch.command, ...launch.args], {
      cwd,
      env: {
        ...env,
        TERM: env.TERM?.trim() || "xterm-256color",
      },
      terminal,
      windowsHide: true,
      windowsVerbatimArguments,
      detached: process.platform !== "win32",
      ...(launch.nativeIdentity
        ? {
            uid: launch.nativeIdentity.uid,
            gid: launch.nativeIdentity.gid,
          }
        : {}),
      onExit: (_subprocess, exitCode, signalCode, error) => {
        const normalizedError = error
          ? error instanceof Error
            ? error
            : new Error(String(error))
          : undefined;
        queueMicrotask(() =>
          callbacks.onExit(exitCode, signalCode, normalizedError),
        );
      },
    });
  } catch (error) {
    terminal.close();
    throw error;
  }

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    const waiters = [...drainWaiters];
    drainWaiters.clear();
    for (const waiter of waiters) waiter();
    if (!terminal.closed) terminal.close();
  };

  const write = async (chars: string): Promise<void> => {
    if (closed || terminal.closed) {
      throw new Error("PTY stdin is closed.");
    }
    const normalized =
      process.platform === "win32" ? chars.replace(/\r?\n/g, "\r") : chars;
    const bytes = new TextEncoder().encode(normalized);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = terminal.write(bytes.subarray(offset));
      if (written > 0) {
        offset += Math.min(written, bytes.byteLength - offset);
        continue;
      }
      await new Promise<void>((resolve) => {
        drainWaiters.add(resolve);
      });
      if (closed || terminal.closed) {
        throw new Error("PTY stdin closed before all input was written.");
      }
    }
  };

  const resize = (cols: number, rows: number) => terminal.resize(cols, rows);

  return { process: subprocess, terminal, write, resize, close };
};

const killShellProcess = (
  child: SpawnedShell,
  signal: NodeJS.Signals = "SIGTERM",
) => {
  const pid = child.pid;

  if (!pid) {
    return;
  }

  if (process.platform === "win32") {
    const taskkillArgs = ["/pid", String(pid), "/t"];
    if (signal === "SIGKILL") {
      taskkillArgs.push("/f");
    }

    const killer = spawn("taskkill", taskkillArgs, {
      stdio: "ignore",
      windowsHide: true,
    });

    killer.on("error", () => {
      try {
        child.kill(signal);
      } catch {
        // Ignore cleanup errors on fallback kill.
      }
    });
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Ignore cleanup errors when the child already exited.
    }
  }
};

/**
 * TERM→1s→KILL ladder. The escalation is a forked fiber racing the child's
 * `exit` event against a 1s sleep (replacing the unref'd `setTimeout`): if
 * the child is still alive at the deadline it is SIGKILLed; if it exits
 * first the fiber ends immediately. Bounded to 1s of fiber lifetime per
 * invocation, so repeated kills stay cheap and shutdown never inherits an
 * unbounded timer set.
 */
export const terminateShellProcess = (child: SpawnedShell) => {
  if (child.exitCode !== null) {
    return;
  }

  killShellProcess(child, "SIGTERM");

  toolsRuntime.runFork(
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
        killShellProcess(child, "SIGKILL");
      }
    }),
  );
};

const killPtyShellProcess = (
  pty: SpawnedPtyShell,
  signal: NodeJS.Signals = "SIGTERM",
) => {
  const pid = pty.process.pid;
  if (!pid || pty.process.exitCode !== null) return;

  if (process.platform === "win32") {
    const taskkillArgs = ["/pid", String(pid), "/t"];
    if (signal === "SIGKILL") taskkillArgs.push("/f");
    const killer = spawn("taskkill", taskkillArgs, {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => {
      try {
        pty.process.kill(signal);
      } catch {
        // The ConPTY child may already have exited.
      }
    });
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      pty.process.kill(signal);
    } catch {
      // The PTY process may already have exited.
    }
  }
};

export const terminatePtyShellProcess = (pty: SpawnedPtyShell) => {
  if (pty.process.exitCode !== null) {
    pty.close();
    return;
  }
  // On pre-24H2 Windows, ClosePseudoConsole can block while a live child is
  // flushing. Kill the process first and close the terminal only after exit.
  killPtyShellProcess(pty, "SIGTERM");
  const forceKillTimer = setTimeout(() => {
    if (pty.process.exitCode === null) {
      killPtyShellProcess(pty, "SIGKILL");
    }
  }, 1_000);
  forceKillTimer.unref?.();
};

export const runShell = async (
  state: ShellState,
  command: string,
  cwd: string,
  timeoutMs: number,
  envOverrides?: Record<string, string>,
  launchOptions: ShellLaunchOptions = {},
  processIdentity?: ToolProcessIdentity,
) => {
  maybeSweepDeferredDeletes(state);
  const launch = resolveStateShellLaunch(command, state, launchOptions);

  if ("error" in launch) {
    return launch.error;
  }

  type RunShellSettled =
    | { type: "close"; code: number | null }
    | { type: "error"; error: Error }
    | { type: "timeout" };

  return runToolEffect(
    Effect.scoped(
      Effect.gen(function* () {
        let output = "";
        let processSettled = false;
        const settledLatch = yield* Deferred.make<RunShellSettled>();
        // The spawned shell is a scoped resource: if the process has not
        // settled (close/error) when the scope closes — the timeout path,
        // or an interruption — the release finalizer runs the TERM→1s→KILL
        // ladder, exactly where the legacy timeout branch killed it.
        // A synchronous spawn throw (e.g. posix_spawn failure) must route
        // through the same diagnostic as the managed path rather than escaping
        // as an unhandled defect. Spawn eagerly so a throw returns the
        // diagnostic output; hand the live child to acquireRelease so the
        // scoped TERM->1s->KILL finalizer still owns its lifecycle.
        let spawnedChild: ReturnType<typeof spawnShellProcess>;
        try {
          spawnedChild = spawnShellProcess(
            launch.shell,
            launch.args,
            cwd,
            buildShellEnv(envOverrides, state, launchOptions.tty === true),
            launch.windowsVerbatimArguments,
            processIdentity,
          );
        } catch (error) {
          return describeShellSpawnFailure(
            error instanceof Error ? error : new Error(String(error)),
            launch,
            cwd,
            launchOptions,
          );
        }
        const child = yield* Effect.acquireRelease(
          Effect.sync(() => spawnedChild),
          (spawned) =>
            Effect.sync(() => {
              if (!processSettled) {
                terminateShellProcess(spawned);
              }
            }),
        );

        const stdoutDecoder = new StringDecoder("utf8");
        const stderrDecoder = new StringDecoder("utf8");
        const append = (decoder: StringDecoder, data: Buffer) => {
          output = truncate(`${output}${decoder.write(data)}`);
        };
        child.stdout.on("data", (data: Buffer) => append(stdoutDecoder, data));
        child.stderr.on("data", (data: Buffer) => append(stderrDecoder, data));
        child.stdout.on("end", () => {
          output = truncate(`${output}${stdoutDecoder.end()}`);
        });
        child.stderr.on("end", () => {
          output = truncate(`${output}${stderrDecoder.end()}`);
        });
        child.on("close", (code) => {
          processSettled = true;
          Deferred.doneUnsafe(
            settledLatch,
            Effect.succeed<RunShellSettled>({
              type: "close",
              code: code ?? null,
            }),
          );
        });
        child.on("error", (error) => {
          processSettled = true;
          Deferred.doneUnsafe(
            settledLatch,
            Effect.succeed<RunShellSettled>({ type: "error", error }),
          );
        });

        const settled = yield* Effect.raceFirst(
          Deferred.await(settledLatch),
          Effect.sleep(timeoutMs).pipe(
            Effect.as<RunShellSettled>({ type: "timeout" }),
          ),
        );
        if (settled.type === "timeout") {
          return `Command timed out after ${timeoutMs}ms.\n\n${truncate(output)}`;
        }
        if (settled.type === "error") {
          return describeShellSpawnFailure(
            settled.error,
            launch,
            cwd,
            launchOptions,
          );
        }
        // Clean Windows console noise (chcp output) that confuses LLMs
        const cleanedOutput = sanitizeToolVisibleText(output)
          .replace(/^Active code page: \d+\s*/gm, "")
          .replace(/^\s+/, ""); // Trim leading whitespace after removal
        if (settled.code === 0) {
          return cleanedOutput || "Command completed successfully (no output).";
        }
        return `Command exited with code ${settled.code}.\n\n${truncate(cleanedOutput)}`;
      }),
    ),
  );
};
