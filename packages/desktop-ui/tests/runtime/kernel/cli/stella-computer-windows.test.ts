import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  canonicalWindowsTargetKey,
  cleanupWindowsStellaComputerSessionDaemon,
  connectWindowsPipe,
  encodeWindowsDaemonPayload,
  exchangeWindowsDaemonRequest,
  getWindowsScreenshotPolicy,
  getWindowsSelectionOptions,
  isReadOnlyWindowsHelperRequest,
  requestWindowsComputerHelper,
  spawnWindowsDaemonProcess,
  waitForWindowsDaemonTeardown,
  withWindowsComputerSessionLock,
} from "@stella/runtime/kernel/cli/stella-computer-windows";
import { runWithComputerExecutionContext } from "@stella/runtime/kernel/computer-use/execution-context";

describe("Windows stella-computer wrapper", () => {
  it("encodes deferred UTF-8 text selection requests without shell rewriting", () => {
    const encoded = encodeWindowsDaemonPayload(42, {
      tool: "select_text",
      app: "notepad.exe",
      text: "Exact text: café",
      prefix: "Before → ",
      suffix: " ← after",
      selection: "cursor-after",
      defer_observation: true,
    });

    expect(encoded.endsWith("\n")).toBe(true);
    expect(JSON.parse(encoded)).toEqual({
      seq: 42,
      operation: {
        tool: "select_text",
        app: "notepad.exe",
        text: "Exact text: café",
        prefix: "Before → ",
        suffix: " ← after",
        selection: "cursor-after",
        defer_observation: true,
      },
    });
  });

  it("validates screenshot and text-selection policies", () => {
    expect(getWindowsScreenshotPolicy([])).toBe("always");
    expect(getWindowsScreenshotPolicy(["--screenshot-policy", "auto"])).toBe(
      "auto",
    );
    expect(getWindowsScreenshotPolicy(["--no-screenshot"])).toBe("never");
    expect(() =>
      getWindowsScreenshotPolicy(["--screenshot-policy", "sometimes"]),
    ).toThrow("Invalid --screenshot-policy");

    expect(
      getWindowsSelectionOptions([
        "--prefix",
        "left",
        "--suffix",
        "right",
        "--selection",
        "cursor-before",
      ]),
    ).toEqual({
      prefix: "left",
      suffix: "right",
      selection: "cursor-before",
    });
    expect(() =>
      getWindowsSelectionOptions(["--selection", "paragraph"]),
    ).toThrow("Invalid --selection");
  });

  it("canonicalizes every alias for a window onto one target key", () => {
    expect(
      canonicalWindowsTargetKey({
        app: { name: "notepad.exe", pid: 91 },
        windowId: 12345,
      }),
    ).toBe("window-12345");
    expect(
      canonicalWindowsTargetKey({
        app: { name: "notepad.exe", pid: 91 },
      }),
    ).toBe("pid-91");
  });

  it("observes daemon spawn failures without an unhandled error event", async () => {
    const child = Object.assign(new EventEmitter(), {
      unref: vi.fn(),
      kill: vi.fn(),
      pid: undefined,
    }) as unknown as ChildProcess;
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        const error = Object.assign(new Error("spawn EACCES"), {
          code: "EACCES",
        });
        child.emit("error", error);
      });
      return child;
    }) as unknown as typeof spawn;

    await expect(
      spawnWindowsDaemonProcess(
        "C:\\Program Files\\Stella\\stella-computer-helper.exe",
        "\\\\.\\pipe\\stella-test",
        "C:\\Temp\\helper.pid",
        undefined,
        spawnProcess,
      ),
    ).rejects.toThrow("failed to spawn: spawn EACCES");

    expect(child.listenerCount("error")).toBeGreaterThan(0);
    expect(() => child.emit("error", new Error("late error"))).not.toThrow();
    expect(child.unref).not.toHaveBeenCalled();
  });

  it("serializes all work for one session even when callers use Promise.all", async () => {
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;

    await Promise.all(
      [0, 1, 2, 3].map((index) =>
        withWindowsComputerSessionLock("parallel-session", async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          events.push(`start-${index}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          events.push(`end-${index}`);
          active -= 1;
        }),
      ),
    );

    expect(maxActive).toBe(1);
    expect(events).toEqual([
      "start-0",
      "end-0",
      "start-1",
      "end-1",
      "start-2",
      "end-2",
      "start-3",
      "end-3",
    ]);
  });

  it("removes an aborted waiter without wedging the session queue", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withWindowsComputerSessionLock(
      "abort-queue-session",
      async () => await firstGate,
    );
    const controller = new AbortController();
    let cancelledRan = false;
    const cancelled = withWindowsComputerSessionLock(
      "abort-queue-session",
      async () => {
        cancelledRan = true;
      },
      controller.signal,
    );
    const final = withWindowsComputerSessionLock(
      "abort-queue-session",
      async () => "final-ran",
    );

    controller.abort(new Error("skip queued request"));
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    releaseFirst();

    await expect(first).resolves.toBeUndefined();
    await expect(final).resolves.toBe("final-ran");
    expect(cancelledRan).toBe(false);
  });

  it("aborts an in-flight pipe request and closes the connection promptly", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "stella-win-pipe-"));
    const pipeName =
      process.platform === "win32"
        ? `\\\\.\\pipe\\stella-test-${randomUUID()}`
        : path.join(tempDir, "helper.sock");
    let requestReceived!: () => void;
    const received = new Promise<void>((resolve) => {
      requestReceived = resolve;
    });
    let peerClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      peerClosed = resolve;
    });
    const server = net.createServer((peer) => {
      peer.once("data", requestReceived);
      peer.once("close", peerClosed);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(pipeName, resolve);
    });

    try {
      const controller = new AbortController();
      const removeListener = vi.spyOn(controller.signal, "removeEventListener");
      const socket = await connectWindowsPipe(
        pipeName,
        1_000,
        controller.signal,
      );
      const baselineListeners = {
        data: socket.listenerCount("data"),
        end: socket.listenerCount("end"),
        close: socket.listenerCount("close"),
      };
      const onTimeoutOrAbort = vi.fn();
      const response = exchangeWindowsDaemonRequest(socket, "request\n", {
        timeoutMs: 5_000,
        signal: controller.signal,
        onTimeoutOrAbort,
      });
      await received;
      controller.abort(new Error("test cancellation"));

      await expect(response).rejects.toMatchObject({
        name: "AbortError",
        message: expect.stringContaining(
          "request cancelled: test cancellation",
        ),
      });
      await closed;
      expect(onTimeoutOrAbort).toHaveBeenCalledTimes(1);
      expect(socket.destroyed).toBe(true);
      expect(socket.listenerCount("data")).toBe(baselineListeners.data);
      expect(socket.listenerCount("end")).toBe(baselineListeners.end);
      expect(socket.listenerCount("error")).toBe(1);
      expect(socket.listenerCount("close")).toBe(baselineListeners.close);
      expect(removeListener).toHaveBeenCalledWith(
        "abort",
        expect.any(Function),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("captures asynchronous pipe-write failures as channel errors", async () => {
    const pipeError = Object.assign(new Error("write EPIPE"), {
      code: "EPIPE",
    });
    const socket = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      write: vi.fn(
        (_payload: string, callback: (error?: Error | null) => void) => {
          queueMicrotask(() => callback(pipeError));
          return true;
        },
      ),
    }) as unknown as net.Socket;

    await expect(
      exchangeWindowsDaemonRequest(socket, "request\n", {
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(
      "Windows stella-computer daemon connection failed: write EPIPE",
    );
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(() => socket.emit("error", new Error("late EPIPE"))).not.toThrow();
  });

  it("accepts a complete response frame before a read-side EPIPE", async () => {
    const response = JSON.stringify({
      seq: 1,
      status: 0,
      stdout: JSON.stringify({ ok: true, text: "received" }),
      stderr: "",
    });
    const pipeError = Object.assign(new Error("broken pipe, read"), {
      code: "EPIPE",
    });
    const socket = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      write: vi.fn(() => {
        queueMicrotask(() => {
          socket.emit("data", Buffer.from(`${response}\n`, "utf8"));
          socket.emit("error", pipeError);
        });
        return true;
      }),
    }) as unknown as net.Socket;

    await expect(
      exchangeWindowsDaemonRequest(socket, "request\n", {
        timeoutMs: 1_000,
      }),
    ).resolves.toBe(response);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  it("recycles and retries a read-only request after an EPIPE", async () => {
    const sockets = [{ attempt: 1 }, { attempt: 2 }] as unknown as net.Socket[];
    const connectDaemon = vi
      .fn()
      .mockResolvedValueOnce(sockets[0])
      .mockResolvedValueOnce(sockets[1]);
    const stopDaemon = vi.fn(() => true);
    const exchangeRequest = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("read EPIPE"), { code: "EPIPE" }),
      )
      .mockImplementationOnce(async (_socket, payload: string) => {
        const { seq } = JSON.parse(payload) as { seq: number };
        return JSON.stringify({
          seq,
          status: 0,
          stdout: JSON.stringify({ ok: true, text: "recovered" }),
          stderr: "",
        });
      });

    await expect(
      requestWindowsComputerHelper(
        "read-only-recovery",
        { tool: "get_app_state", app: "notepad.exe" },
        undefined,
        { connectDaemon, exchangeRequest, stopDaemon },
      ),
    ).resolves.toEqual({ ok: true, text: "recovered" });
    expect(connectDaemon).toHaveBeenCalledTimes(2);
    expect(exchangeRequest).toHaveBeenCalledTimes(2);
    expect(stopDaemon).toHaveBeenCalledTimes(1);
  });

  it("waits for delayed daemon teardown before reconnecting a read-only request", async () => {
    const sockets = [{ attempt: 1 }, { attempt: 2 }] as unknown as net.Socket[];
    const connectDaemon = vi
      .fn()
      .mockResolvedValueOnce(sockets[0])
      .mockResolvedValueOnce(sockets[1]);
    let releaseTeardown!: () => void;
    const teardown = new Promise<void>((resolve) => {
      releaseTeardown = resolve;
    });
    const stopDaemon = vi.fn(async () => {
      await teardown;
      return true;
    });
    const exchangeRequest = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
      )
      .mockImplementationOnce(async (_socket, payload: string) => {
        const { seq } = JSON.parse(payload) as { seq: number };
        return JSON.stringify({
          seq,
          status: 0,
          stdout: JSON.stringify({ ok: true, text: "recovered" }),
          stderr: "",
        });
      });

    const request = requestWindowsComputerHelper(
      "delayed-teardown-recovery",
      { tool: "get_app_state", app: "notepad.exe" },
      undefined,
      { connectDaemon, exchangeRequest, stopDaemon },
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(connectDaemon).toHaveBeenCalledTimes(1);

    releaseTeardown();
    await expect(request).resolves.toEqual({ ok: true, text: "recovered" });
    expect(connectDaemon).toHaveBeenCalledTimes(2);
  });

  it("waits for both the old helper process and stale named pipe to disappear", async () => {
    const pidStates = [true, false, false];
    const pipeStates = [true, true, false];
    const pidRunning = vi.fn(() => pidStates.shift() ?? false);
    const pipeAccepting = vi.fn(async () => pipeStates.shift() ?? false);

    await expect(
      waitForWindowsDaemonTeardown(42, "\\\\.\\pipe\\stella-stale", undefined, {
        pidRunning,
        pipeAccepting,
        timeoutMs: 250,
        pollMs: 1,
      }),
    ).resolves.toBeUndefined();

    expect(pidRunning).toHaveBeenCalledTimes(3);
    expect(pipeAccepting).toHaveBeenCalledTimes(3);
  });

  it("surfaces both failures when the read-only recovery retry also loses its channel", async () => {
    const connectDaemon = vi.fn(async () => ({}) as net.Socket);
    const stopDaemon = vi.fn(async () => true);
    const exchangeRequest = vi
      .fn()
      .mockRejectedValueOnce(new Error("first EPIPE"))
      .mockRejectedValueOnce(new Error("second EPIPE"));

    await expect(
      requestWindowsComputerHelper(
        "double-channel-failure",
        { tool: "get_app_state", app: "notepad.exe" },
        undefined,
        { connectDaemon, exchangeRequest, stopDaemon },
      ),
    ).rejects.toThrow(
      /recovery retry failed[\s\S]*Initial failure: first EPIPE[\s\S]*Retry failure: second EPIPE/u,
    );
    expect(stopDaemon).toHaveBeenCalledTimes(2);
  });

  it("recycles but never replays a mutating request after an EPIPE", async () => {
    const connectDaemon = vi.fn(async () => ({}) as net.Socket);
    const stopDaemon = vi.fn(() => true);
    const exchangeRequest = vi.fn(async () => {
      throw Object.assign(new Error("read EPIPE"), { code: "EPIPE" });
    });

    await expect(
      requestWindowsComputerHelper(
        "mutation-recovery",
        { tool: "click", app: "notepad.exe", x: 10, y: 20 },
        undefined,
        { connectDaemon, exchangeRequest, stopDaemon },
      ),
    ).rejects.toThrow(
      "The daemon was recycled, but Stella did not replay click because the action may already have completed",
    );
    expect(connectDaemon).toHaveBeenCalledTimes(1);
    expect(exchangeRequest).toHaveBeenCalledTimes(1);
    expect(stopDaemon).toHaveBeenCalledTimes(1);
  });

  it("only classifies observation operations as retryable", () => {
    for (const tool of [
      "doctor",
      "get_app_state",
      "list_apps",
      "list_windows",
    ]) {
      expect(isReadOnlyWindowsHelperRequest({ tool })).toBe(true);
    }
    for (const tool of ["batch", "click", "launch_app", "type_text"]) {
      expect(isReadOnlyWindowsHelperRequest({ tool })).toBe(false);
    }
  });

  it("stops a session daemon using the active execution-context state root", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "stella-win-cleanup-"));
    const sessionId = `cleanup-${randomUUID()}`;
    const pidPath = path.join(
      tempDir,
      "stella-computer",
      "sessions",
      sessionId,
      "windows-daemon",
      "helper.pid",
    );
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
      },
    );
    const exited = once(child, "exit");
    await once(child, "spawn");
    mkdirSync(path.dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, String(child.pid));

    try {
      const result = await runWithComputerExecutionContext(
        {
          env: { ...process.env, STELLA_DATA_DIR: tempDir },
        },
        () => cleanupWindowsStellaComputerSessionDaemon(sessionId),
      );
      expect(result.value).toBe(true);
      expect(existsSync(pidPath)).toBe(false);
      await Promise.race([
        exited,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("daemon did not exit")), 2_000),
        ),
      ]);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {

      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("Windows native Computer Use architecture", () => {
  const nativeSource = readFileSync(
    path.resolve(process.cwd(), "../native/src/stella_computer_helper.cpp"),
    "utf8",
  );
  const wrapperSource = readFileSync(
    path.resolve(
      process.cwd(),
      "..",
      "runtime",
      "kernel",
      "cli",
      "stella-computer-windows.ts",
    ),
    "utf8",
  );

  it("enables per-monitor DPI awareness and maps capped screenshot pixels", () => {
    expect(nativeSource).toContain(
      "DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2",
    );
    expect(nativeSource).toContain("screenshotLongEdgeCapPx = 1024");
    expect(nativeSource).toContain("windowFrame.width / screenshotWidth");
    expect(nativeSource).toContain("windowFrame.height / screenshotHeight");
  });

  it("acknowledges deferred actions before settling or materializing state", () => {
    const actionBody = nativeSource.slice(
      nativeSource.indexOf("static std::string executeOperation"),
    );
    const deferred = actionBody.lastIndexOf("if (deferred)");
    const settle = actionBody.lastIndexOf(
      "AdaptiveSettle settle = waitForTargetQuiet",
    );
    const materialize = actionBody.lastIndexOf(
      "Snapshot refreshed = snapshotForTarget",
    );

    expect(deferred).toBeGreaterThan(0);
    expect(settle).toBeGreaterThan(deferred);
    expect(materialize).toBeGreaterThan(deferred);
    expect(actionBody).toContain("defer_observation");
    expect(nativeSource).toContain("AddStructureChangedEventHandler");
    expect(nativeSource).toContain("pendingBaselineRevision");
  });

  it("uses UIA text ranges and canonical cached element identities", () => {
    expect(nativeSource).toContain("selectExactText(");
    expect(nativeSource).toContain("MoveEndpointByUnit(");
    expect(nativeSource).toContain("range->Select()");
    expect(nativeSource).toContain("findValidatedCachedElement");
    expect(nativeSource).toContain(
      "std::map<long long, std::unique_ptr<TargetState>> targetStates",
    );
    expect(wrapperSource).toContain("canonicalWindowsTargetKey(snapshot)");
    expect(wrapperSource).toContain("writeJsonAtomic(statePath, snapshot)");
  });

  it("supports full-state recovery and the shared app instruction block", () => {
    expect(wrapperSource).toContain('target.args.includes("--disable-diff")');
    expect(wrapperSource).toContain(
      "inline=image/png path=${JSON.stringify(path)}",
    );
    expect(wrapperSource).toContain("<app_specific_instructions>");
    expect(wrapperSource).toContain("</app_specific_instructions>");
  });

  it("uses the daemon readiness connection for the request instead of reconnecting", () => {
    const connectStart = wrapperSource.indexOf(
      "const connectWindowsDaemon = async",
    );
    const connectEnd = wrapperSource.indexOf(
      "export const readWindowsComputerSnapshot",
      connectStart,
    );
    const connectBody = wrapperSource.slice(connectStart, connectEnd);
    const requestStart = wrapperSource.indexOf(
      "export const requestWindowsComputerHelper",
    );
    const requestEnd = wrapperSource.indexOf(
      "const appFromSnapshotArgs",
      requestStart,
    );
    const requestBody = wrapperSource.slice(requestStart, requestEnd);

    expect(connectStart).toBeGreaterThan(0);
    expect(connectBody).not.toContain("socket.end()");
    expect(requestBody).toContain(
      "transportOverrides.connectDaemon ?? connectWindowsDaemon",
    );
    expect(requestBody).toContain(
      "const socket = await connectDaemon(sessionId, signal)",
    );
    expect(requestBody).not.toContain("connectWindowsPipeWithRetry");
  });
});
