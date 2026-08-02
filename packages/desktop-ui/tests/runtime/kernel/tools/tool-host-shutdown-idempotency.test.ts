import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createToolHost } from "@stella/runtime/kernel/tools/host";
import type { ToolContext } from "@stella/runtime/kernel/tools/types";

/**
 * Real toolHost.shutdown coverage (final hardening): idempotent —
 * concurrent and repeated calls join the same memoized teardown — and
 * JOINED: a running session shell is actually dead before shutdown
 * resolves, so a worker exiting immediately afterwards cannot strand it.
 */

const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const makeHost = async () => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-host-idempotent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(rootPath, { recursive: true });
  roots.push(rootPath);
  return createToolHost({
    stellaAppDir: rootPath,
    agentApi: {
      createAgent: async () => ({ threadId: "thread-1" }),
      getAgent: async () => null,
      cancelAgent: async () => ({ canceled: false }),
      reportManager: async () => ({ accepted: true, final: false }),
    },
    webSearch: async () => ({ text: "unused" }),
    contextProvider: async () => ({ status: "found" as const, brief: "" }),
  });
};

const toolContext = (workingDirectory: string): ToolContext => ({
  conversationId: "conv-idempotent",
  deviceId: "device-1",
  requestId: "req-1",
  runId: "run-1",
  agentType: "general",
  storageMode: "local",
  workingDirectory,
});

describe("toolHost.shutdown idempotency", () => {
  // Real process teardown rides the TERM -> 1s -> KILL ladder, so give the
  // test headroom beyond the 5s default when the suite runs under load.
  it("joins shell teardown once across concurrent and repeated calls", { timeout: 20_000 }, async () => {
    const host = await makeHost();
    const started = await host.executeTool(
      "exec_command",
      { cmd: "sleep 60", yield_time_ms: 50 },
      toolContext(os.tmpdir()),
    );
    expect(started.error).toBeUndefined();
    const shells = host.getShells();
    expect(shells).toHaveLength(1);
    const pid = shells[0].child?.pid as number;
    expect(pidIsAlive(pid)).toBe(true);

    // Concurrent calls share one teardown; both resolve only after the
    // process is really gone.
    const first = host.shutdown();
    const second = host.shutdown();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(pidIsAlive(pid)).toBe(false);
    expect(host.getShells()[0]?.running).toBe(false);

    // A late repeat is a resolved no-op.
    await host.shutdown();
  });
});
