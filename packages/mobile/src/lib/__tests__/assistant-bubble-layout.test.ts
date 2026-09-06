import { describe, expect, test } from "bun:test";
import { assistantBubbleNeedsBoundedWidth } from "../assistant-bubble-layout";

describe("assistant bubble layout", () => {
  test("gives long native lists a definite width", () => {
    const longList = Array.from({ length: 150 }, (_, i) => `${i + 1}. A readable list entry`).join("\n");
    expect(assistantBubbleNeedsBoundedWidth(longList)).toBe(true);
    expect(assistantBubbleNeedsBoundedWidth("Introduction\n\n- First entry\n  - Nested entry")).toBe(true);
  });

  test("bounds tables, fenced and indented code, quotes, and headings", () => {
    for (const text of [
      "Name | Value\n--- | ---\nA | B",
      "| Name | Value |\n| :--- | ---: |\n| A | B |",
      "```ts\nconst a = 1;\n```",
      "~~~\ncode\n~~~",
      "    indented code",
      "> A quote",
      "## Heading",
    ]) expect(assistantBubbleNeedsBoundedWidth(text)).toBe(true);
  });

  test("keeps short prose and inline formatting intrinsically sized", () => {
    for (const text of ["Hello!", "**Done.**", "Use `code` here.", "See [the link](https://example.com).", "One line.\nAnother line.", "3.14 is pi."])
      expect(assistantBubbleNeedsBoundedWidth(text)).toBe(false);
  });
});
