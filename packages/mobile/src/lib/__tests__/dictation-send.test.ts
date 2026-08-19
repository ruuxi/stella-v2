import { describe, expect, test } from "bun:test";
import { canSubmitFinalizedDictation } from "../dictation-send";

const base = {
  armed: true,
  resultReady: true,
  status: "idle" as const,
  draft: "I would do like continue with the rest",
  target: "I would do like continue with the rest",
  attachmentCount: 0,
};

describe("dictation send finalization", () => {
  test("waits for transcription completion and composer synchronization", () => {
    expect(
      canSubmitFinalizedDictation({ ...base, status: "transcribing" }),
    ).toBe(false);
    expect(
      canSubmitFinalizedDictation({ ...base, resultReady: false }),
    ).toBe(false);
    expect(
      canSubmitFinalizedDictation({ ...base, draft: "I would do like" }),
    ).toBe(false);
    expect(canSubmitFinalizedDictation(base)).toBe(true);
  });

  test("never sends the stale draft when transcription has no result", () => {
    expect(
      canSubmitFinalizedDictation({
        ...base,
        draft: "I would do like",
        target: null,
      }),
    ).toBe(false);
  });
});
