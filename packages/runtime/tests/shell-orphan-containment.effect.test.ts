import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createShellState,
  handleExecCommand,
  handleWriteStdin,
} from "../kernel/tools/shell.js";

/**
 * Shell ownership classification (phase 3 batch 2): an exec_command that
 * aborts BEFORE its session id reaches the model owns its shell (nothing
 * can ever address it) and must kill it; a session whose id was already
 * delivered is conversation-scoped and an aborted write_stdin poll must
 * NOT kill it.
 */

const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for predicate");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const makeRoot = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-shell-scope-"));
  roots.push(root);
  return root;
};

describe("shell ownership on abort", () => {
  it("kills a run-owned shell when exec_command aborts before returning", async () => {
    const root = await makeRoot();
    const state = createShellState(root);
    const abort = new AbortController();

    const execution = handleExecCommand(
      state,
      // Long sleep: still running when the call aborts.
      { cmd: "sleep 60", yield_time_ms: 60_000 },
      { conversationId: "conv-1", workingDirectory: root } as never,
      abort.signal,
    );
    // Let the shell spawn, then cancel the call.
    const record = await (async () => {
      await waitFor(() => state.shells.size === 1);
      return [...state.shells.values()][0];
    })();
    await waitFor(() => Boolean(record.child?.pid));
    const pid = record.child!.pid!;
    expect(pidIsAlive(pid)).toBe(true);

    abort.abort(new Error("run canceled"));
    const result = await execution;
    expect(result.error).toBe("run canceled");

    // The orphan is reaped through the TERM→KILL ladder.
    await waitFor(() => !pidIsAlive(pid));
    await waitFor(() => record.running === false);
  });

  it("leaves a conversation-scoped session alive when a write_stdin poll aborts", async () => {
    const root = await makeRoot();
    const state = createShellState(root);

    // Start the session normally: the session id is delivered to the model.
    const started = await handleExecCommand(
      state,
      { cmd: "sleep 60", yield_time_ms: 50 },
      { conversationId: "conv-2", workingDirectory: root } as never,
    );
    expect(started.error).toBeUndefined();
    const payload = started.details as { session_id?: string };
    expect(payload.session_id).toBeTruthy();
    const record = state.shells.get(payload.session_id!);
    const pid = record?.child?.pid;
    expect(pid && pidIsAlive(pid)).toBe(true);

    // Abort a later poll: the session must survive.
    const abort = new AbortController();
    const poll = handleWriteStdin(
      state,
      { session_id: payload.session_id, chars: "", yield_time_ms: 60_000 },
      { conversationId: "conv-2", workingDirectory: root } as never,
      abort.signal,
    );
    abort.abort(new Error("run canceled"));
    const polled = await poll;
    expect(polled.error).toBe("run canceled");
    expect(pidIsAlive(pid!)).toBe(true);

    // Cleanup for the test itself.
    record?.kill();
    await waitFor(() => !pidIsAlive(pid!));
  });
});
