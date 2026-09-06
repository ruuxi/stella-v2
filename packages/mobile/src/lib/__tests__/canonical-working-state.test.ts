import { describe, expect, test } from "bun:test";
import { canonicalWorkingState } from "../canonical-working-state";
import type { JournalRecord, TurnPhase } from "../cloud-conversation-protocol";

const prompt: JournalRecord = {
  kind: "message", seq: 1, createdAtMs: 1, turnId: "turn-1",
  role: "user", hidden: false, clientMsgId: "dispatch-1", payload: { content: "hi" },
};
const answer: JournalRecord = {
  kind: "message", seq: 3, createdAtMs: 3, turnId: "turn-1",
  role: "assistant", hidden: false, payload: { content: "hello" },
};
const phase = (phase: TurnPhase): JournalRecord => ({
  kind: "turn", seq: phase === "started" ? 2 : 4, createdAtMs: 4,
  turnId: "turn-1", phase,
});
const base = {
  localSending: true,
  localIndicator: { active: true, exitImmediately: false, status: "Starting" },
  activeDispatchId: "dispatch-1",
  live: { turnId: "turn-1", toolName: null, toolLabel: null },
};

describe("canonical mobile working state", () => {
  test("a second send queued during terminal-before-poll handoff becomes busy immediately", () => {
    const records = [prompt, phase("started"), answer, phase("completed")];
    expect(canonicalWorkingState({ ...base, records })).toMatchObject({ sending: false });
    expect(canonicalWorkingState({ ...base, records, hasQueuedSend: true }))
      .toMatchObject({ sending: true, workingIndicator: { active: true, exitImmediately: false } });
    expect(canonicalWorkingState({ ...base, records, hasQueuedSend: false }))
      .toMatchObject({ sending: false, workingIndicator: { active: false } });
  });
  test("a queued send preserves the current turn's live tool status", () => {
    expect(canonicalWorkingState({
      ...base, records: [prompt, phase("started")], hasQueuedSend: true,
      live: { ...base.live, toolName: "exec_command", toolLabel: "Running command" },
    })).toMatchObject({ sending: true, workingIndicator: { active: true,
      toolName: "exec_command", status: "Running command" } });
  });
  test("an answer does not hide pending queued work before terminal", () => {
    expect(canonicalWorkingState({ ...base, records: [prompt, phase("started"), answer], hasQueuedSend: true }))
      .toMatchObject({ sending: true, workingIndicator: { active: true, exitImmediately: false } });
  });
  test("the canonical origin acknowledges an answer before admission HTTP returns", () => {
    expect(canonicalWorkingState({
      ...base, activeDispatchId: null, activeSendMessageId: "mobile-1",
      records: [{ ...prompt, payload: { content: "hi", originUserMessageId: "mobile-1" } }, phase("started"), answer],
    })).toMatchObject({ workingIndicator: { active: false, exitImmediately: true } });
  });
  test("a committed answer hands off immediately while placement is still polling", () => {
    expect(canonicalWorkingState({ ...base, records: [prompt, phase("started"), answer] }))
      .toMatchObject({ sending: true, workingIndicator: { active: false, exitImmediately: true } });
  });
  for (const terminal of ["completed", "failed", "canceled", "timeout"] as const) {
    test(`${terminal} clears busy despite stale live tool and pending placement poll`, () => {
      expect(canonicalWorkingState({
        ...base,
        live: { ...base.live, toolName: "exec_command" },
        records: [prompt, phase("started"), phase(terminal)],
      })).toMatchObject({ sending: false, workingIndicator: { active: false, exitImmediately: true } });
    });
  }
  test("a new prompt stays busy when only the previous turn has finished", () => {
    expect(canonicalWorkingState({
      ...base, activeDispatchId: "dispatch-2",
      records: [prompt, phase("started"), answer, phase("completed")],
    })).toMatchObject({ sending: true, workingIndicator: base.localIndicator });
  });
  test("tool work after an assistant preamble remains visible", () => {
    const tool: JournalRecord = { ...answer, seq: 4, payload: { content: [
      { type: "toolCall", id: "tool-1", name: "exec_command", arguments: {} },
    ] } };
    expect(canonicalWorkingState({
      ...base, records: [prompt, phase("started"), answer, tool],
      live: { ...base.live, toolName: "exec_command" },
    })).toMatchObject({ sending: true, workingIndicator: { active: true, exitImmediately: false } });
  });
  test("another active turn survives the local turn's completion", () => {
    expect(canonicalWorkingState({
      ...base, records: [prompt, phase("started"), phase("completed")],
      live: { ...base.live, turnId: "turn-2" },
    })).toMatchObject({ sending: true, workingIndicator: { active: true } });
  });
});
