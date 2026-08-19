import { describe, expect, it } from "vitest";

import {
  __testOnlyComputerRequestDeadlineMs,
  executeStellaComputerCommand,
} from "@stella/runtime/kernel/computer-use/stella-computer-executor";
import { runStellaComputerCli } from "@stella/runtime/kernel/cli/stella-computer";

describe("shared Stella computer executor", () => {
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
