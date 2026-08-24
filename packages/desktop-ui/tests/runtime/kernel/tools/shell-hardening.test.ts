import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  readdir: vi.fn(),
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  mocks.spawn.mockImplementation((...args: Parameters<typeof actual.spawn>) =>
    actual.spawn(...args),
  );
  return { ...actual, spawn: mocks.spawn };
});

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  mocks.readdir.mockImplementation(
    (...args: Parameters<typeof actual.readdir>) => actual.readdir(...args),
  );
  return { ...actual, readdir: mocks.readdir };
});

import {
  createShellState,
  handleExecCommand,
  runShell,
  startShell,
} from "@stella/runtime/kernel/tools/shell";

const tempDirs: string[] = [];

const createTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-shell-hardening-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  mocks.spawn.mockClear();
  mocks.readdir.mockClear();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("shell hardening", () => {
  it("routes a synchronous spawn throw through the managed diagnostic record", () => {
    const root = createTempDir();
    const spawnError = Object.assign(new Error("posix_spawn '/bin/bash'"), {
      code: "ENOTDIR",
    });
    mocks.spawn.mockImplementationOnce(() => {
      throw spawnError;
    });

    const state = createShellState(root);
    const record = startShell(state, "printf unreachable", root);

    expect(record).toMatchObject({
      running: false,
      exitCode: 1,
      cwd: root,
    });
    expect(record.output).toContain("Failed to start exec_command shell");
    expect(record.output).toContain(`cwd=${JSON.stringify(root)}`);
    expect(record.output).toContain("cause=Error: posix_spawn '/bin/bash'");
    expect(state.shells.get(record.id)).toBe(record);
  });

  it("routes a synchronous one-shot spawn throw through the same diagnostic", async () => {
    const root = createTempDir();
    mocks.spawn.mockImplementationOnce(() => {
      throw new Error("synchronous spawn failure");
    });

    const output = await runShell(
      createShellState(root),
      "printf unreachable",
      root,
      500,
    );

    expect(output).toContain("Failed to start exec_command shell");
    expect(output).toContain(`cwd=${JSON.stringify(root)}`);
    expect(output).toContain("cause=Error: synchronous spawn failure");
  });

  it("returns a running session by the yield deadline when the pre-snapshot stalls", async () => {
    const root = createTempDir();
    mocks.readdir.mockImplementationOnce(
      () => new Promise<never>(() => undefined),
    );
    const state = createShellState(root);
    const startedAt = Date.now();

    const result = await handleExecCommand(
      state,
      {
        cmd: 'node -e "setTimeout(() => {}, 5000)"',
        workdir: root,
        yield_time_ms: 25,
      },
      {
        conversationId: "c-slow-snapshot",
        deviceId: "d-slow-snapshot",
        requestId: "r-slow-snapshot",
        stellaAppDir: root,
      },
    );

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(result.error).toBeUndefined();
    expect(result.details).toMatchObject({ running: true, cwd: root });
    const sessionId = (result.details as { session_id: string }).session_id;
    expect(typeof sessionId).toBe("string");
    state.shells.get(sessionId)?.kill();
  });

  it("does not run a completion walk when the start snapshot is null", async () => {
    const root = createTempDir();
    mocks.readdir.mockClear();

    const result = await handleExecCommand(
      createShellState(root),
      { cmd: "pwd", workdir: root, yield_time_ms: 500 },
      {
        conversationId: "c-null-snapshot",
        deviceId: "d-null-snapshot",
        requestId: "r-null-snapshot",
        stellaAppDir: root,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.details).toMatchObject({ running: false, exit_code: 0 });
    expect(mocks.readdir).not.toHaveBeenCalled();
  });

  it("does not let a stalled completion snapshot exceed the original yield deadline", async () => {
    const root = createTempDir();
    mocks.readdir
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(() => new Promise<never>(() => undefined));
    const startedAt = Date.now();

    const result = await handleExecCommand(
      createShellState(root),
      {
        cmd: "printf artifact > completed.txt",
        workdir: root,
        yield_time_ms: 50,
      },
      {
        conversationId: "c-slow-post-snapshot",
        deviceId: "d-slow-post-snapshot",
        requestId: "r-slow-post-snapshot",
        stellaAppDir: root,
      },
    );

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(result.error).toBeUndefined();
    expect(result.details).toMatchObject({ running: false, exit_code: 0 });
  });
});
