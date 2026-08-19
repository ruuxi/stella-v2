import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  __testOnlyComputerRequestDeadlineMs,
  __testOnlyRecoverAutomationDaemon,
  executeStellaComputerCommand,
} from "@stella/runtime/kernel/computer-use/stella-computer-executor";
import { runStellaComputerCli } from "@stella/runtime/kernel/cli/stella-computer";

describe("shared Stella computer executor", () => {
  const originalDataDir = process.env.STELLA_DATA_DIR;
  const originalHome = process.env.HOME;
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    if (originalDataDir === undefined) delete process.env.STELLA_DATA_DIR;
    else process.env.STELLA_DATA_DIR = originalDataDir;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it("bounds silent observation operations well below the historical 600-second watchdog", () => {
    const base = {
      schemaVersion: 1,
      protocolVersion: 1,
      requestId: "request-1",
      sessionId: "session-1",
    } as const;
    expect(
      __testOnlyComputerRequestDeadlineMs(
        { ...base, type: "get_app_state", target: { app: "Simulator" } },
        600_000,
      ),
    ).toBe(25_000);
    expect(
      __testOnlyComputerRequestDeadlineMs(
        { ...base, type: "list_windows" },
        600_000,
      ),
    ).toBe(10_000);
  });

  it("returns help through the in-process result contract", async () => {
    const result = await executeStellaComputerCommand(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("stella-computer - control");
    expect(result.stdout).toContain("stella-computer list-windows");
    expect(result.stderr).toBe("");
  });

  it("kills and resets a cancelled serial daemon generation", async () => {
    const root = path.join(
      os.tmpdir(),
      `stella-computer-cancel-recovery-${process.pid}-${Date.now()}`,
    );
    temporaryRoots.push(root);
    process.env.STELLA_DATA_DIR = path.join(root, "data");
    process.env.HOME = path.join(root, "home");
    const sessionId = "cancelled-helper";
    const sessionDir = path.join(
      process.env.STELLA_DATA_DIR,
      "stella-computer",
      "sessions",
      sessionId,
    );
    mkdirSync(sessionDir, { recursive: true });

    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref();
    expect(child.pid).toBeTypeOf("number");
    writeFileSync(path.join(sessionDir, "automation.pid"), String(child.pid));

    const recovered = __testOnlyRecoverAutomationDaemon(sessionId);
    mkdirSync(path.dirname(recovered.socketPath), { recursive: true });
    writeFileSync(recovered.socketPath, "stale");
    writeFileSync(recovered.hostPidPath, "123");
    const secondRecovery = __testOnlyRecoverAutomationDaemon(sessionId);

    expect(recovered.pid).toBe(child.pid);
    expect(secondRecovery.pid).toBeNull();
    expect(existsSync(recovered.pidPath)).toBe(false);
    expect(existsSync(recovered.socketPath)).toBe(false);
    expect(existsSync(recovered.hostPidPath)).toBe(false);
    await expect(
      new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 2_000;
        const poll = () => {
          try {
            process.kill(child.pid!, 0);
            if (Date.now() >= deadline)
              reject(new Error("daemon still running"));
            else setTimeout(poll, 20);
          } catch {
            resolve();
          }
        };
        poll();
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps command validation and session option errors in the shared path", async () => {
    const missingSession = await executeStellaComputerCommand(["--session"]);
    const unknown = await executeStellaComputerCommand(["not-a-command"]);

    expect(missingSession).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "--session requires a value.\n",
    });
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("Unknown command: not-a-command");
    expect(unknown.stderr).toContain("Usage:");
  });

  it("keeps the CLI as a thin adapter over the same executor output", async () => {
    let stdout = "";
    let stderr = "";
    const exitCode = await runStellaComputerCli(["--help"], {
      stdout: (value) => {
        stdout += value;
      },
      stderr: (value) => {
        stderr += value;
      },
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("stella-computer - control");
    expect(stderr).toBe("");
  });
});
