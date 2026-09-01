import { describe, expect, it, vi } from "vitest";
import {
  createDictationTranscriptPreview,
  tokenizeDictationTranscript,
} from "@/features/dictation/dictation-transcript-preview";

describe("dictation transcript preview", () => {
  it("keeps the common prefix stable as words arrive", () => {
    const preview = createDictationTranscriptPreview();
    const listener = vi.fn();
    preview.subscribe(listener);

    preview.setText("A new dictation");
    preview.setText("A new dictation experience");

    expect(preview.getSnapshot()).toMatchObject({
      text: "A new dictation experience",
      revision: 2,
      stableWordCount: 3,
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("reanimates the corrected tail without disturbing earlier words", () => {
    const preview = createDictationTranscriptPreview();
    preview.setText("available today in iOS");
    preview.setText("available today on iOS");

    expect(preview.getSnapshot().stableWordCount).toBe(2);
  });

  it("normalizes whitespace and ignores duplicate frames", () => {
    const preview = createDictationTranscriptPreview();
    const listener = vi.fn();
    preview.subscribe(listener);
    preview.setText("  Try it out.  ");
    preview.setText("Try it out.");

    expect(tokenizeDictationTranscript(preview.getSnapshot().text)).toEqual([
      "Try",
      "it",
      "out.",
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
