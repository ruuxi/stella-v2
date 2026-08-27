import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  COMPLETED_SHELL_TTL_MS,
  cleanupShellSessions,
  createShellState,
  handleExecCommand,
  handleShellStatus,
  handleWriteStdin,
  type ShellState,
} from "../kernel/tools/shell.ts";
import { isDangerousCommand } from "../kernel/tools/command-safety.ts";
import type { ToolContext, ToolResult } from "../kernel/tools/types.ts";

const context = (
  conversationId: string,
  options: { agentId?: string; requestId?: string; runId?: string } = {},
): ToolContext => ({
  conversationId,
  deviceId: "live-exec-acceptance",
  requestId: options.requestId ?? `request-${conversationId}`,
  ...(options.agentId ? { agentId: options.agentId } : {}),
  ...(options.runId ? { runId: options.runId } : {}),
});

const detailsOf = (result: ToolResult): Record<string, unknown> => {
  assert.equal(result.error, undefined, result.error);
  assert.ok(result.details && typeof result.details === "object");
  return result.details as Record<string, unknown>;
};

const sessionIdOf = (result: ToolResult): string => {
  const details = detailsOf(result);
  const id = details.session_id ?? details.shell_session_id;
  assert.equal(typeof id, "string");
  return id as string;
};

const outputOf = (result: ToolResult): string => {
  assert.equal(result.error, undefined, result.error);
  return String(result.result ?? "");
};

const outputBodyOf = (result: ToolResult): string => {
  const output = outputOf(result);
  const marker = "\nOutput:\n";
  const markerIndex = output.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing output marker in ${output}`);
  return output.slice(markerIndex + marker.length);
};

const stopRunningShells = async (state: ShellState): Promise<void> => {
  for (const record of state.shells.values()) {
    if (record.running) record.kill();
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
};

const root = await mkdtemp(path.join(tmpdir(), "stella-exec-live-"));
const state = createShellState(root);
const ownerAtStart = context("live-owner", {
  requestId: "owner-request-1",
  runId: "owner-run-1",
});
const ownerLater = context("live-owner", {
  requestId: "owner-request-2",
  runId: "owner-run-2",
});
const foreignConversation = context("live-foreign");
const foreignAgent = context("live-owner", { agentId: "foreign-agent" });
const evidence: Record<string, unknown> = {};

try {
  const catastrophicSafetyCases = [
    { kind: "home", command: 'rm -rf "$HOME"' },
    { kind: "root", command: "rm -rf /" },
    { kind: "mount", command: "rm -rf /Volumes/AcceptanceDisk" },
    { kind: "raw-device", command: "dd if=/dev/zero of=/dev/disk0" },
    { kind: "nested-shell", command: "bash -lc 'rm -rf /'" },
    { kind: "xargs", command: "printf / | xargs rm -rf" },
    {
      kind: "powershell",
      command:
        "powershell -Command 'Remove-Item -LiteralPath $env:USERPROFILE\\.. -Recurse -Force'",
    },
  ] as const;
  const blockedSafetyReasons: Record<string, string> = {};
  for (const safetyCase of catastrophicSafetyCases) {

    const reason = isDangerousCommand(safetyCase.command, root);
    assert.ok(reason, `safety gate allowed ${safetyCase.kind}`);
    blockedSafetyReasons[safetyCase.kind] = reason;
  }
  const safeDescendantCases = [
    `rm -rf ${JSON.stringify(path.join(root, "build"))}`,
    "rm -rf /Volumes/AcceptanceDisk/project/build",
    `dd if=/dev/zero of=${JSON.stringify(path.join(root, "disk-image"))} count=1`,
    "bash -lc 'rm -rf ./build'",
    "printf ./build | xargs rm -rf",
    "powershell -Command 'Remove-Item -Recurse C:\\work\\project\\build'",
  ];
  for (const command of safeDescendantCases) {
    assert.equal(
      isDangerousCommand(command, root),
      null,
      `safety gate blocked safe descendant: ${command}`,
    );
  }
  evidence.shell_safety_parser_only = {
    blocked_without_spawn: blockedSafetyReasons,
    safe_descendants_allowed: safeDescendantCases.length,
  };

  const earlyStarted = await handleExecCommand(
    state,
    {
      cmd: `node -e 'setTimeout(() => process.stdout.write("progress\\n"), 60); setTimeout(() => {}, 5000)'`,
      workdir: root,
      yield_time_ms: 10,
    },
    ownerAtStart,
  );
  const earlyId = sessionIdOf(earlyStarted);
  const pollStartedAt = performance.now();
  const earlyPoll = await handleWriteStdin(
    state,
    { session_id: earlyId, operation: "poll", yield_time_ms: 1_000 },
    ownerLater,
  );
  const pollElapsedMs = performance.now() - pollStartedAt;
  assert.match(outputOf(earlyPoll), /progress/);
  assert.equal(detailsOf(earlyPoll).running, true);
  assert.ok(
    pollElapsedMs < 750,
    `empty poll waited ${pollElapsedMs.toFixed(1)} ms for a 60 ms emission`,
  );
  await handleWriteStdin(
    state,
    { session_id: earlyId, operation: "terminate", yield_time_ms: 1_000 },
    ownerLater,
  );
  evidence.early_poll = {
    emitted_after_ms: 60,
    poll_deadline_ms: 1_000,
    returned_after_ms: Math.round(pollElapsedMs),
    remained_running_at_return: true,
  };

  const expectedUtf8 = "🙂漢é";
  const utf8Updates: ToolResult[] = [];
  const utf8Result = await handleExecCommand(
    state,
    {
      cmd: `node -e 'const chunks=["🙂","漢","é"]; let index=0; const emit=()=>{ if(index===chunks.length) return; process.stdout.write(chunks[index++]); setTimeout(emit, 40); }; emit();'`,
      workdir: root,
      yield_time_ms: 1_000,
    },
    ownerAtStart,
    undefined,
    (update) => utf8Updates.push(update),
  );
  const streamUpdates = utf8Updates.filter((update) => {
    const details = detailsOf(update);
    const receipt = details.chunk_receipt as Record<string, unknown>;
    return receipt.kind === "stream_delta";
  });
  assert.ok(streamUpdates.length >= 1);
  let nextCursor = 0;
  let streamedUtf8 = "";
  const cursorRanges: Array<[number, number]> = [];
  for (const update of streamUpdates) {
    const receipt = detailsOf(update).chunk_receipt as Record<string, number>;
    const body = outputBodyOf(update);
    assert.equal(receipt.start_byte, nextCursor);
    assert.equal(
      receipt.end_byte - receipt.start_byte,
      Buffer.byteLength(body, "utf8"),
    );
    cursorRanges.push([receipt.start_byte, receipt.end_byte]);
    nextCursor = receipt.end_byte;
    streamedUtf8 += body;
  }
  assert.equal(streamedUtf8, expectedUtf8);
  assert.equal(nextCursor, Buffer.byteLength(expectedUtf8, "utf8"));
  assert.doesNotMatch(streamedUtf8, /�/);
  const utf8FinalReceipt = detailsOf(utf8Result).chunk_receipt as Record<
    string,
    number
  >;
  assert.equal(utf8FinalReceipt.start_byte, 0);
  assert.equal(
    utf8FinalReceipt.end_byte,
    Buffer.byteLength(expectedUtf8, "utf8"),
  );
  evidence.utf8_receipts = {
    chunks: streamUpdates.length,
    bytes: nextCursor,
    text: streamedUtf8,
    cursor_ranges: cursorRanges,
    final_cursor: utf8FinalReceipt.end_byte,
  };

  const interactiveStarted = await handleExecCommand(
    state,
    {
      cmd: `count=0; while IFS= read -r line; do count=$((count + 1)); printf 'seen:%s:%s\n' "$count" "$line"; [ "$line" = done ] && break; done`,
      workdir: root,
      yield_time_ms: 10,
    },
    ownerAtStart,
  );
  const interactiveId = sessionIdOf(interactiveStarted);

  for (const foreign of [foreignConversation, foreignAgent]) {
    const deniedWrite = await handleWriteStdin(
      state,
      {
        session_id: interactiveId,
        chars: "foreign\n",
        write_id: `foreign-${foreign.conversationId}-${foreign.agentId ?? "root"}`,
      },
      foreign,
    );
    const deniedTerminate = await handleWriteStdin(
      state,
      { session_id: interactiveId, operation: "terminate" },
      foreign,
    );
    assert.match(deniedWrite.error ?? "", /Session not found/);
    assert.match(deniedTerminate.error ?? "", /Session not found/);
    assert.equal(state.shells.get(interactiveId)?.running, true);
    assert.equal(
      (await handleShellStatus(state, {}, foreign)).result,
      "No active shells.",
    );
  }

  const firstWrite = await handleWriteStdin(
    state,
    {
      session_id: interactiveId,
      chars: "alpha\n",
      write_id: "live-alpha",
      yield_time_ms: 100,
    },
    ownerLater,
  );
  const retryWrite = await handleWriteStdin(
    state,
    {
      session_id: interactiveId,
      chars: "alpha\n",
      write_id: "live-alpha",
      yield_time_ms: 100,
    },
    ownerLater,
  );
  const finishWrite = await handleWriteStdin(
    state,
    {
      session_id: interactiveId,
      chars: "done\n",
      write_id: "live-done",
      yield_time_ms: 1_000,
    },
    ownerLater,
  );
  assert.match(outputOf(firstWrite), /seen:1:alpha/);
  assert.doesNotMatch(outputOf(retryWrite), /seen:/);
  assert.equal(detailsOf(retryWrite).write_deduplicated, true);
  assert.match(outputOf(finishWrite), /seen:2:done/);
  evidence.idempotency_and_ownership = {
    first_write_count: 1,
    retry_deduplicated: true,
    final_write_count: 2,
    foreign_conversation_denied: true,
    foreign_agent_denied: true,
    later_owner_run_allowed: true,
  };

  const ptyStarted = await handleExecCommand(
    state,
    {
      cmd: `trap 'printf "PTY_RESIZED:"; stty size' WINCH; printf 'PTY_READY:'; stty size; while :; do sleep 0.1; done`,
      workdir: root,
      tty: true,
      yield_time_ms: 10,
    },
    ownerAtStart,
  );
  const ptyId = sessionIdOf(ptyStarted);
  let ptyReadyOutput = outputBodyOf(ptyStarted);
  const readyDeadline = Date.now() + 3_000;
  while (!/PTY_READY:\s*24 80/u.test(ptyReadyOutput)) {
    assert.ok(
      Date.now() < readyDeadline,
      `PTY never became ready: ${ptyReadyOutput}`,
    );
    ptyReadyOutput += outputBodyOf(
      await handleWriteStdin(
        state,
        { session_id: ptyId, operation: "poll", yield_time_ms: 500 },
        ownerLater,
      ),
    );
  }
  const resized = await handleWriteStdin(
    state,
    {
      session_id: ptyId,
      operation: "resize",
      cols: 101,
      rows: 37,
      yield_time_ms: 500,
    },
    ownerLater,
  );
  let resizedOutput = outputBodyOf(resized);
  const resizedDeadline = Date.now() + 3_000;
  while (!/PTY_RESIZED:\s*37 101/u.test(resizedOutput)) {
    assert.ok(
      Date.now() < resizedDeadline,
      `PTY child did not observe resize: ${resizedOutput}`,
    );
    resizedOutput += outputBodyOf(
      await handleWriteStdin(
        state,
        { session_id: ptyId, operation: "poll", yield_time_ms: 500 },
        ownerLater,
      ),
    );
  }
  assert.deepEqual(detailsOf(resized).terminal_size, {
    cols: 101,
    rows: 37,
  });
  assert.deepEqual(
    (detailsOf(resized).chunk_receipt as Record<string, unknown>).terminal_size,
    { cols: 101, rows: 37 },
  );
  assert.equal(state.shells.get(ptyId)?.running, true);
  const ptyTerminated = await handleWriteStdin(
    state,
    { session_id: ptyId, operation: "terminate", yield_time_ms: 1_000 },
    ownerLater,
  );
  assert.equal(detailsOf(ptyTerminated).running, false);
  evidence.pty = {
    transport: "Bun.Terminal",
    initial_size: { cols: 80, rows: 24 },
    requested_size: { cols: 101, rows: 37 },
    child_observed_resize: true,
    receipt_included_size: true,
    terminate_stopped_live_pty: true,
  };

  const eofStarted = await handleExecCommand(
    state,
    {
      cmd: `node -e 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("EOF\\n"))'`,
      workdir: root,
      yield_time_ms: 10,
    },
    ownerAtStart,
  );
  const eofId = sessionIdOf(eofStarted);
  const closed = await handleWriteStdin(
    state,
    { session_id: eofId, operation: "close_stdin", yield_time_ms: 1_000 },
    ownerLater,
  );
  assert.match(outputOf(closed), /EOF/);
  assert.equal(detailsOf(closed).running, false);

  const terminateStarted = await handleExecCommand(
    state,
    {
      cmd: `node -e 'setInterval(() => {}, 1000)'`,
      workdir: root,
      yield_time_ms: 10,
    },
    ownerAtStart,
  );
  const terminateId = sessionIdOf(terminateStarted);
  const terminated = await handleWriteStdin(
    state,
    {
      session_id: terminateId,
      operation: "terminate",
      yield_time_ms: 1_000,
    },
    ownerLater,
  );
  assert.equal(detailsOf(terminated).running, false);
  evidence.process_controls = {
    close_stdin_observed_eof: true,
    terminate_stopped_live_child: true,
  };

  const tombstoneResult = await handleExecCommand(
    state,
    { cmd: "printf tombstone", workdir: root, yield_time_ms: 1_000 },
    ownerAtStart,
  );
  const tombstoneId = sessionIdOf(tombstoneResult);
  const tombstoneRecord = state.shells.get(tombstoneId);
  assert.ok(tombstoneRecord);
  const cleanupAt = Date.now();
  tombstoneRecord.completedAt = cleanupAt - COMPLETED_SHELL_TTL_MS - 1;
  cleanupShellSessions(state, cleanupAt);
  assert.equal(state.shells.has(tombstoneId), false);
  assert.equal(state.prunedSessions.has(tombstoneId), true);
  const ownerTombstone = await handleWriteStdin(
    state,
    { session_id: tombstoneId, operation: "poll" },
    ownerLater,
  );
  const foreignTombstone = await handleWriteStdin(
    state,
    { session_id: tombstoneId, operation: "poll" },
    foreignConversation,
  );
  assert.match(ownerTombstone.error ?? "", /was pruned/);
  assert.doesNotMatch(foreignTombstone.error ?? "", /was pruned/);
  assert.match(foreignTombstone.error ?? "", /Session not found/);
  evidence.tombstone = {
    owner_received_completion_provenance: true,
    foreign_caller_received_generic_missing: true,
  };

  console.log(
    JSON.stringify(
      {
        ok: true,
        worker_generation: state.workerGeneration,
        runtime_pid: process.pid,
        temp_root: root,
        evidence,
      },
      null,
      2,
    ),
  );
} finally {
  await stopRunningShells(state);
  await rm(root, { recursive: true, force: true });
}
