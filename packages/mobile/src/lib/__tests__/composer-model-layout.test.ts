import { describe, expect, test } from "bun:test";
import { resolveComposerExpanded } from "../composer-model-layout";

describe("resolveComposerExpanded", () => {
  test("a pinned picker keeps an empty composer expanded", () => {
    expect(
      resolveComposerExpanded({
        expanded: false,
        dictationBelow: false,
        dictationInline: false,
        modelPickerPinned: true,
      }),
    ).toBe(true);
  });

  test("inline dictation expands an empty composer", () => {
    expect(
      resolveComposerExpanded({
        expanded: false,
        dictationBelow: false,
        dictationInline: true,
        modelPickerPinned: false,
      }),
    ).toBe(true);
  });

  test("normal text and below-text dictation still expand independently", () => {
    expect(
      resolveComposerExpanded({
        expanded: true,
        dictationBelow: false,
        dictationInline: false,
        modelPickerPinned: false,
      }),
    ).toBe(true);
    expect(
      resolveComposerExpanded({
        expanded: false,
        dictationBelow: true,
        dictationInline: false,
        modelPickerPinned: false,
      }),
    ).toBe(true);
  });
});

describe("resolveComposerExpanded with attachments", () => {
  test("pending attachments expand an otherwise empty composer", () => {
    expect(
      resolveComposerExpanded({
        expanded: false,
        dictationBelow: false,
        dictationInline: false,
        modelPickerPinned: false,
        hasAttachments: true,
      }),
    ).toBe(true);
  });

  test("no attachments leaves the pill shape alone", () => {
    expect(
      resolveComposerExpanded({
        expanded: false,
        dictationBelow: false,
        dictationInline: false,
        modelPickerPinned: false,
        hasAttachments: false,
      }),
    ).toBe(false);
  });
});
