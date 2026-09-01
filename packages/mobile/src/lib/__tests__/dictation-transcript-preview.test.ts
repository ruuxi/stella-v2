import { describe, expect, test } from "bun:test";
import {
  getDictationTranscriptPreviewSnapshot,
  resetDictationTranscriptPreview,
  tokenizeDictationTranscript,
  updateDictationTranscriptPreview,
} from "../dictation-transcript-preview";

describe("mobile dictation transcript preview", () => {
  test("accepts cumulative additions and corrections", () => {
    resetDictationTranscriptPreview();
    updateDictationTranscriptPreview("A new dictation");
    updateDictationTranscriptPreview("A new dictation experience");
    updateDictationTranscriptPreview("A new correction experience");

    expect(getDictationTranscriptPreviewSnapshot()).toMatchObject({
      text: "A new correction experience",
      stableWordCount: 2,
    });
    expect(
      tokenizeDictationTranscript(getDictationTranscriptPreviewSnapshot().text),
    ).toEqual(["A", "new", "correction", "experience"]);
  });
});
