import { describe, expect, test } from "bun:test";
import { resolveComposerExpanded } from "../composer-model-layout";

const resting = {
  expanded: false,
  dictationBelow: false,
  dictationInline: false,
  modelPickerPinned: false,
};

describe("resolveComposerExpanded", () => {
  test("an empty composer stays a pill", () => {
    expect(resolveComposerExpanded(resting)).toBe(false);
  });

  test("a pending reply quote expands the composer so the toolbar keeps the mic", () => {
    expect(resolveComposerExpanded({ ...resting, hasQuotes: true })).toBe(true);
  });

  test("pending attachments expand the composer", () => {
    expect(resolveComposerExpanded({ ...resting, hasAttachments: true })).toBe(true);
  });
});
