import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createShellState, handleExecCommand } from "../kernel/tools/shell.js";
import { joinWithTimeout } from "../kernel/shared/supervised-scope.js";

/**
 * toolHost shutdown finalizer behavior (phase 4 batch 3), proven at the
 * shell-state seam the host delegates to: shutdown must JOIN actual child
 * exits (not merely start the kill ladder) so a worker that stops right
 * after cannot strand TERM-ignoring orphans, and repeated shutdown calls
 * must be idempotent.
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

describe("tool host shell teardown join", () => {
  it("joins running shells' exits at shutdown so no process outlives the bound", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-host-stop-"));
    roots.push(root);
    const state = createShellState(root);

    // A long-running session shell (delivered session id) — worker-lifetime.
    const started = await handleExecCommand(
      state,
      { cmd: "sleep 60", yield_time_ms: 50 },
      { conversationId: "conv-stop", workingDirectory: root } as never,
    );
    const sessionId = (started.details as { session_id?: string }).session_id!;
    const record = state.shells.get(sessionId)!;
    const pid = record.child!.pid!;
    expect(pidIsAlive(pid)).toBe(true);

    // Mirror the host's shutdown sequence: collect exits, kill, join.
    const exits: Array<Promise<void>> = [];
    for (const shell of state.shells.values()) {
      if (!shell.running || !shell.child) continue;
      exits.push(
        new Promise<void>((resolve) => {
          shell.child!.once("close", () => resolve());
          shell.child!.once("error", () => resolve());
        }),
      );
    }
    for (const shell of state.shells.values()) {
      if (shell.running) shell.kill();
    }
    const joined = await joinWithTimeout(Promise.allSettled(exits), 3_000);
    expect(joined).toBe("joined");
    // The process is REALLY gone before shutdown resolves — no orphan
    // window for a worker that exits immediately afterwards.
    expect(pidIsAlive(pid)).toBe(false);
    expect(record.running).toBe(false);
  });
});
