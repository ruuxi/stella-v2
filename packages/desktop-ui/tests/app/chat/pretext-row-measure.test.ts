import { describe, expect, it } from "vitest";
import {
  clearMeasurementCache,
  isPlainText,
  measurePlainTextHeight,
  type TranscriptTypography,
} from "@/features/chat/pretext/measure";

const typography: TranscriptTypography = {
  font: "normal 400 15px Inter, sans-serif",
  lineHeightPx: 22.5,
  letterSpacingPx: 0,
  epoch: "test-epoch",
};

const canMeasureText = (() => {
  try {
    const height = measurePlainTextHeight("hello world", typography, 400);
    clearMeasurementCache();
    return typeof height === "number" && height > 0;
  } catch {
    clearMeasurementCache();
    return false;
  }
})();

describe("isPlainText", () => {
  it("accepts prose that renders as a single markdown paragraph", () => {
    expect(isPlainText("Sure, that should work fine.")).toBe(true);
    expect(isPlainText("Two sentences. Both plain!")).toBe(true);
  });

  it("rejects every markdown construct that changes row geometry", () => {
    for (const markdown of [
      "`code`",
      "**bold**",
      "_em_",
      "~~strike~~",
      "# heading",
      "> quote",
      "| a | b |",
      "- bullet",
      "1. numbered",
      "[link](http://x.dev)",
      "![img](http://x.dev/a.png)",
      "<div>raw</div>",
    ]) {
      expect(isPlainText(markdown)).toBe(false);
    }
  });
});

describe("measurePlainTextHeight fallbacks", () => {
  it("returns undefined for markdown", () => {
    expect(
      measurePlainTextHeight("## A heading", typography, 400),
    ).toBeUndefined();
    expect(
      measurePlainTextHeight("Here is `code` inline", typography, 400),
    ).toBeUndefined();
  });

  it("returns undefined for empty or whitespace-only text", () => {
    expect(measurePlainTextHeight("", typography, 400)).toBeUndefined();
    expect(measurePlainTextHeight("   \n\n  ", typography, 400)).toBeUndefined();
  });

  it("returns undefined for a degenerate content width", () => {
    expect(measurePlainTextHeight("hello", typography, 0)).toBeUndefined();
    expect(measurePlainTextHeight("hello", typography, -40)).toBeUndefined();
    expect(measurePlainTextHeight("hello", typography, 8)).toBeUndefined();
  });
});

describe.runIf(canMeasureText)("measurePlainTextHeight arithmetic", () => {
  it("grows by whole lines as the width shrinks", () => {
    const text =
      "This sentence is long enough that it has to wrap more than once " +
      "when the available width gets small.";
    const wide = measurePlainTextHeight(text, typography, 600)!;
    const narrow = measurePlainTextHeight(text, typography, 160)!;
    expect(wide).toBeGreaterThan(0);
    expect(narrow).toBeGreaterThan(wide);
    expect(wide % typography.lineHeightPx).toBeCloseTo(0, 5);
    expect(narrow % typography.lineHeightPx).toBeCloseTo(0, 5);
  });

  it("adds the paragraph gap once per blank-line break", () => {
    const gap = 12;
    const one = measurePlainTextHeight("alpha", typography, 600, gap)!;
    const two = measurePlainTextHeight("alpha\n\nbeta", typography, 600, gap)!;
    expect(two).toBeCloseTo(one * 2 + gap, 5);
  });
});
