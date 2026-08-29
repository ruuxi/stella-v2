import { describe, expect, it } from "vitest";
import {
  AGENT_RECORDER_SEQ_CEILING,
  isAgentRecorderSeq,
  nextAgentRecorderSeqCursor,
} from "@stella/contracts/agent-runtime";
import {
  stampAgentEventMainSeq,
  workerResumeLastSeq,
} from "@stella/desktop/electron/ipc/agent-event-seq.js";

describe("agent event seq spaces", () => {
  it("treats recorder counts as the worker resume cursor", () => {
    expect(isAgentRecorderSeq(12)).toBe(true);
    expect(isAgentRecorderSeq(Date.now())).toBe(false);
    expect(isAgentRecorderSeq(Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(isAgentRecorderSeq(AGENT_RECORDER_SEQ_CEILING)).toBe(false);
  });

  it("stamps a main-process seq without losing the worker value", () => {
    expect(
      stampAgentEventMainSeq({ type: "stream", seq: 12 }, 1_800_000_000_001),
    ).toEqual({
      type: "stream",
      seq: 1_800_000_000_001,
      sourceSeq: 12,
    });
  });

  it("keeps an existing sourceSeq when restamping", () => {
    expect(
      stampAgentEventMainSeq(
        { seq: 1_800_000_000_001, sourceSeq: 12 },
        1_800_000_000_002,
      ),
    ).toEqual({
      seq: 1_800_000_000_002,
      sourceSeq: 12,
    });
  });

  it("does not query the worker log with a Date.now wire cursor", () => {
    expect(
      workerResumeLastSeq({ lastSeq: 1_800_000_000_001, lastSourceSeq: 7 }),
    ).toBe(7);
    expect(workerResumeLastSeq({ lastSeq: 1_800_000_000_001 })).toBe(0);
    expect(workerResumeLastSeq({ lastSeq: 4 })).toBe(4);
    expect(workerResumeLastSeq({ lastSeq: Number.MAX_SAFE_INTEGER })).toBe(0);
  });

  it("advances the recorder cursor from sourceSeq, ignoring synthetics", () => {
    expect(
      nextAgentRecorderSeqCursor(3, { seq: 1_800_000_000_001, sourceSeq: 9 }),
    ).toBe(9);
    expect(
      nextAgentRecorderSeqCursor(9, { seq: 1_800_000_000_002, sourceSeq: 4 }),
    ).toBe(9);
    expect(nextAgentRecorderSeqCursor(0, { seq: Number.MAX_SAFE_INTEGER })).toBe(
      0,
    );
  });
});
