import { describe, expect, test } from "bun:test";
import {
  APP_BUILD_SESSION_ENV,
  CapturedSessionAbandonedError,
  capturedSessionExec,
  startStrictSessionProcess,
  strictSessionCommand,
  strictSessionExec,
} from "../src/strict-session-process.js";

describe("strict Builder session process boundary", () => {
  test("app and preview sessions receive no reusable turn authority", () => {
    expect(APP_BUILD_SESSION_ENV).toEqual({
      STELLA_CLOUD_WORKSPACE_ROOT: "/workspace/app",
      USER: "stella-tools",
      LOGNAME: "stella-tools",
      HOME: "/workspace/.stella-tool-home",
      XDG_CONFIG_HOME: "/workspace/.stella-tool-home/.config",
      XDG_CACHE_HOME: "/workspace/.stella-tool-home/.cache",
      XDG_STATE_HOME: "/workspace/.stella-tool-home/.local/state",
    });
    expect(JSON.stringify(APP_BUILD_SESSION_ENV)).not.toContain(
      "STELLA_TURN_TOKEN",
    );
  });

  test("serializes an exact setpriv drop and quotes hostile argv", () => {
    const command = strictSessionCommand([
      "/bin/sh",
      "-lc",
      "printf '%s' \"$HOME\"; touch /tmp/pwned",
      "a'b",
    ]);
    expect(command).toBe(
      "/usr/bin/setpriv --reuid=42424 --regid=42424 --clear-groups --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all -- '/bin/sh' '-lc' 'printf '\"'\"'%s'\"'\"' \"$HOME\"; touch /tmp/pwned' 'a'\"'\"'b'",
    );
  });

  test("wraps both foreground and tracked background processes", async () => {
    const calls: Array<{ kind: string; command: string; options: unknown }> =
      [];
    const fake = {
      exec: async (command: string, options?: unknown) => {
        calls.push({ kind: "exec", command, options });
        return { success: true };
      },
      startProcess: async (command: string, options?: unknown) => {
        calls.push({ kind: "start", command, options });
        return { processId: "p" };
      },
    };
    await strictSessionExec(fake as never, ["bun", "entry.ts"], {
      timeout: 123,
    });
    await startStrictSessionProcess(fake as never, ["vite", "--host"], {
      cwd: "/workspace/app",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.command).toStartWith("/usr/bin/setpriv ");
    expect(calls[0]?.command).not.toStartWith("exec ");
    expect(calls[0]?.command).toEndWith("-- 'bun' 'entry.ts'");
    expect(calls[1]?.command).toStartWith("/usr/bin/setpriv ");
    expect(calls[1]?.command).toEndWith("-- 'vite' '--host'");
  });

  test("rejects empty and NUL-bearing argv", () => {
    expect(() => strictSessionCommand([])).toThrow("requires a command");
    expect(() => strictSessionCommand(["/bin/sh", "bad\0arg"])).toThrow(
      "NUL byte",
    );
  });

  test("captures a named trusted sessionless process exactly once without file polling", async () => {
    const calls: Array<{ command: string; options: unknown }> = [];
    let startedCalls = 0;
    let waits = 0;
    let logReads = 0;
    let forbiddenCalls = 0;
    const process = {
      id: "agent-process",
      waitForExit: async () => {
        waits += 1;
        return { exitCode: 1 };
      },
      getLogs: async () => {
        logReads += 1;
        return { stdout: "partial", stderr: "failure" };
      },
    };
    const fake = {
      startProcess: async (command: string, options?: unknown) => {
        calls.push({ command, options });
        return process;
      },
      exec: () => {
        forbiddenCalls += 1;
      },
      readFile: () => {
        forbiddenCalls += 1;
      },
      deleteFile: () => {
        forbiddenCalls += 1;
      },
    };

    await expect(
      capturedSessionExec(fake as never, ["bun", "entry.ts"], 456, {
        processId: "agent-process",
        onStarted: () => {
          startedCalls += 1;
        },
      }),
    ).resolves.toEqual({
      success: false,
      exitCode: 1,
      stdout: "partial",
      stderr: "failure",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toEqual({
      processId: "agent-process",
      autoCleanup: false,
      timeout: 456,
    });
    expect(calls[0]?.command).toBe("'bun' 'entry.ts'");
    expect(calls[0]?.command).not.toContain("setpriv");
    expect(calls[0]?.command).not.toContain("umask");
    expect(startedCalls).toBe(1);
    expect(waits).toBe(1);
    expect(logReads).toBe(1);
    expect(forbiddenCalls).toBe(0);
  });

  test("passes the trusted executor cwd and environment without an explicit session", async () => {
    let capturedOptions: unknown;
    const process = {
      id: "stella-captured-context",
      waitForExit: async () => ({ exitCode: 0 }),
      getLogs: async () => ({ stdout: "done", stderr: "" }),
    };
    const fake = {
      startProcess: async (_command: string, options?: unknown) => {
        capturedOptions = options;
        return process;
      },
    };

    await expect(
      capturedSessionExec(fake as never, ["bun", "entry.ts"], 100, {
        processId: "stella-captured-context",
        cwd: "/opt/stella",
        env: { STELLA_CLOUD_WORKSPACE_ROOT: "/workspace/drive" },
      }),
    ).resolves.toMatchObject({ success: true, exitCode: 0 });
    expect(capturedOptions).toEqual({
      processId: "stella-captured-context",
      autoCleanup: false,
      timeout: 100,
      cwd: "/opt/stella",
      env: { STELLA_CLOUD_WORKSPACE_ROOT: "/workspace/drive" },
    });
    expect(
      (capturedOptions as { sessionId?: string }).sessionId,
    ).toBeUndefined();
  });

  test("observes a fast terminal process from durable status without an exit-stream race", async () => {
    let waitCalls = 0;
    let statusCalls = 0;
    const never = new Promise<never>(() => undefined);
    const startedProcess = {
      id: "stella-captured-fast-exit",
      status: "running",
      waitForExit: () => {
        waitCalls += 1;
        return never;
      },
      getLogs: async () => ({ stdout: "stopped", stderr: "reason" }),
    };
    const fake = {
      startProcess: async () => startedProcess,
      getProcess: async () => {
        statusCalls += 1;
        return {
          ...startedProcess,
          status: "failed",
          exitCode: 7,
        };
      },
    };

    await expect(
      capturedSessionExec(fake as never, ["bun", "entry.ts"], 100, {
        processId: "stella-captured-fast-exit",
      }),
    ).resolves.toEqual({
      success: false,
      exitCode: 7,
      stdout: "stopped",
      stderr: "reason",
    });
    expect(statusCalls).toBe(1);
    expect(waitCalls).toBe(1);
  });

  test("a hung durable status probe degrades to the single exit stream", async () => {
    const never = new Promise<never>(() => undefined);
    let waitCalls = 0;
    let statusCalls = 0;
    const process = {
      id: "stella-captured-hung-status",
      status: "running",
      waitForExit: async () => {
        waitCalls += 1;
        return { exitCode: 0 };
      },
      getLogs: async () => ({ stdout: "done", stderr: "" }),
    };
    const fake = {
      startProcess: async () => process,
      getProcess: () => {
        statusCalls += 1;
        return never;
      },
    };

    await expect(
      capturedSessionExec(fake as never, ["bun", "entry.ts"], 100, {
        processId: "stella-captured-hung-status",
      }),
    ).resolves.toEqual({
      success: true,
      exitCode: 0,
      stdout: "done",
      stderr: "",
    });
    expect(statusCalls).toBe(1);
    expect(waitCalls).toBe(1);
  });

  test("waits for start-uncertainty destruction before rejecting", async () => {
    const never = new Promise<never>(() => undefined);
    const phases: string[] = [];
    let abandoned = false;
    const fake = { startProcess: () => never };

    const failure = await capturedSessionExec(
      fake as never,
      ["bun", "entry.ts"],
      100,
      {
        processId: "uncertain-process",
        startTimeoutMs: 5,
        onAbandon: async (input) => {
          phases.push(input.phase);
          await new Promise((resolve) => setTimeout(resolve, 5));
          abandoned = true;
          return "compute_released";
        },
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CapturedSessionAbandonedError);
    expect((failure as CapturedSessionAbandonedError).message).toContain(
      "start could not be confirmed",
    );
    expect((failure as CapturedSessionAbandonedError).disposition).toBe(
      "compute_released",
    );
    expect(phases).toEqual(["start_uncertain"]);
    expect(abandoned).toBe(true);
  });

  test("does not admit a queued start after an immediate abort", async () => {
    const controller = new AbortController();
    let starts = 0;
    const phases: string[] = [];
    const captured = capturedSessionExec(
      {
        startProcess: async () => {
          starts += 1;
          throw new Error("must not start");
        },
      } as never,
      ["bun", "entry.ts"],
      100,
      {
        processId: "stella-captured-pre-start-abort",
        signal: controller.signal,
        onAbandon: async (input) => {
          phases.push(input.phase);
          return "compute_released";
        },
      },
    );
    controller.abort(new Error("turn canceled before admission"));

    await expect(captured).rejects.toThrow("start could not be confirmed");
    expect(starts).toBe(0);
    expect(phases).toEqual(["start_uncertain"]);
  });

  test("quiesces an admitted process when durable start recording fails", async () => {
    let waits = 0;
    const phases: string[] = [];
    const fake = {
      startProcess: async () => ({
        id: "stella-captured-test-start-recording",
        waitForExit: async () => {
          waits += 1;
          return { exitCode: 0 };
        },
        getLogs: async () => ({ stdout: "", stderr: "" }),
      }),
    };

    await expect(
      capturedSessionExec(fake as never, ["bun", "entry.ts"], 100, {
        processId: "stella-captured-test-start-recording",
        onStarted: () => {
          throw new Error("authority changed");
        },
        onAbandon: async (input) => {
          phases.push(input.phase);
          return "session_quiesced";
        },
      }),
    ).rejects.toThrow("did not reach a terminal state");
    expect(phases).toEqual(["process_unsettled"]);
    expect(waits).toBe(0);
  });

  test("bounds durable start recording and quiesces the admitted process", async () => {
    const never = new Promise<never>(() => undefined);
    const phases: string[] = [];
    const fake = {
      startProcess: async () => ({
        id: "stella-captured-started-timeout",
        waitForExit: async () => ({ exitCode: 0 }),
        getLogs: async () => ({ stdout: "", stderr: "" }),
      }),
    };

    await expect(
      capturedSessionExec(fake as never, ["bun", "entry.ts"], 100, {
        processId: "stella-captured-started-timeout",
        startedTimeoutMs: 5,
        onStarted: () => never,
        onAbandon: async (input) => {
          phases.push(input.phase);
          return "session_quiesced";
        },
      }),
    ).rejects.toThrow("did not reach a terminal state");
    expect(phases).toEqual(["process_unsettled"]);
  });

  test("a command deadline observes one terminal stream and joins before rejecting", async () => {
    const never = new Promise<never>(() => undefined);
    let waits = 0;
    const phases: string[] = [];
    const fake = {
      startProcess: async () => ({
        id: "stella-captured-test-deadline",
        waitForExit: () => {
          waits += 1;
          return never;
        },
        getLogs: async () => ({ stdout: "", stderr: "" }),
      }),
    };

    await expect(
      capturedSessionExec(fake as never, ["bun", "entry.ts"], 5, {
        processId: "stella-captured-test-deadline",
        onAbandon: async (input) => {
          phases.push(input.phase);
          return "session_quiesced";
        },
      }),
    ).rejects.toThrow("did not reach a terminal state");
    expect(waits).toBe(1);
    expect(phases).toEqual(["process_unsettled"]);
  });

  test("an external abort joins the admitted process before rejecting", async () => {
    const controller = new AbortController();
    const never = new Promise<never>(() => undefined);
    const phases: string[] = [];
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fake = {
      startProcess: async () => ({
        id: "stella-captured-test-abort",
        waitForExit: () => never,
        getLogs: async () => ({ stdout: "", stderr: "" }),
      }),
    };

    const captured = capturedSessionExec(
      fake as never,
      ["bun", "entry.ts"],
      10_000,
      {
        processId: "stella-captured-test-abort",
        signal: controller.signal,
        onStarted: markStarted,
        onAbandon: async (input) => {
          phases.push(input.phase);
          return "session_quiesced";
        },
      },
    );
    await started;
    controller.abort(new Error("turn canceled"));

    await expect(captured).rejects.toThrow("did not reach a terminal state");
    expect(phases).toEqual(["process_unsettled"]);
  });

  test("transfers one large authoritative result under its own deadline", async () => {
    const output = "x".repeat(4 * 1024 * 1024);
    let logReads = 0;
    const fake = {
      startProcess: async () => ({
        id: "stella-captured-test-large-result",
        waitForExit: async () => ({ exitCode: 0 }),
        getLogs: async () => {
          logReads += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { stdout: output, stderr: "warning" };
        },
      }),
    };

    const result = await capturedSessionExec(
      fake as never,
      ["bun", "entry.ts"],
      100,
      {
        processId: "stella-captured-test-large-result",
        resultTimeoutMs: 50,
      },
    );
    expect(result.success).toBe(true);
    expect(result.stdout.length).toBe(output.length);
    expect(result.stdout).toBe(output);
    expect(result.stderr).toBe("warning");
    expect(logReads).toBe(1);
  });

  test("a hung final log transfer is attempted once after terminal exit", async () => {
    const never = new Promise<never>(() => undefined);
    let logReads = 0;
    let abandoned = 0;
    const fake = {
      startProcess: async () => ({
        id: "stella-captured-test-hung-logs",
        waitForExit: async () => ({ exitCode: 0 }),
        getLogs: () => {
          logReads += 1;
          return never;
        },
      }),
    };

    await expect(
      capturedSessionExec(fake as never, ["bun", "entry.ts"], 100, {
        processId: "stella-captured-test-hung-logs",
        resultTimeoutMs: 5,
        onAbandon: async () => {
          abandoned += 1;
          return "session_quiesced";
        },
      }),
    ).rejects.toThrow("output exceeded");
    expect(logReads).toBe(1);
    expect(abandoned).toBe(0);
  });
});
