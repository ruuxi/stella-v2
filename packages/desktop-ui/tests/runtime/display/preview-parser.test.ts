import { describe, expect, it } from "vitest";
import {
  parsePreview,
  DIFF_PREVIEW_MAX_LINES,
  PREVIEW_MAX_LINE_CHARS,
} from "../../../src/shell/display/preview-parser";
const bytes = (text: string) => new TextEncoder().encode(text);

describe("bounded preview parsing", () => {
  it("contains a wide ragged table while preserving subsequent quoted rows", () => {
    const input =
      "x,".repeat(9_999) + "x\n" + '"hello\nworld",value\n' + "x\n".repeat(998);
    const result = parsePreview({
      kind: "table",
      bytes: bytes(input),
      delimiter: ",",
      truncated: false,
    });
    expect(result.rows).toHaveLength(1_000);
    expect(result.rows[0]).toHaveLength(100);
    expect(result.rows[1]).toEqual(["hello\nworld", "value"]);
    expect(result.limited).toBe(true);
  });
  it("preserves quotes and row boundaries after skipped columns", () => {
    const result = parsePreview({
      kind: "table",
      bytes: bytes("x,".repeat(100) + '"skip\nthis"\nnext,row'),
      delimiter: ",",
      truncated: false,
    });
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1]).toEqual(["next", "row"]);
  });
  it("bounds long cells and generated files without losing diff kinds", () => {
    const result = parsePreview({
      kind: "diff",
      filePath: "large.ts",
      truncated: false,
      bytes: bytes("x".repeat(50_000) + "\n" + "line\n".repeat(100_000)),
    });
    expect(result.lines).toHaveLength(DIFF_PREVIEW_MAX_LINES + 1);
    expect(result.lines[0]).toEqual({ kind: "header", text: "large.ts" });
    expect(result.lines[1].text).toHaveLength(PREVIEW_MAX_LINE_CHARS + 1);
    expect(result.limited).toBe(true);
  });
  it("preserves multi-file patch headers and line semantics", () => {
    const result = parsePreview({
      kind: "diff",
      filePath: "",
      truncated: false,
      patch:
        "*** Update File: a.ts\r\n@@\r\n-old\r\n+new\r\n same\r\n*** Add File: b.ts\r\n+second\r\n*** End Patch",
    });
    expect(result.lines).toEqual([
      { kind: "header", text: "a.ts" },
      { kind: "meta", text: "@@" },
      { kind: "delete", text: "old" },
      { kind: "add", text: "new" },
      { kind: "context", text: "same" },
      { kind: "header", text: "b.ts" },
      { kind: "add", text: "second" },
    ]);
    expect(result.limited).toBe(false);
  });
  it("drops a byte-truncated final line", () => {
    const result = parsePreview({
      kind: "diff",
      filePath: "partial.ts",
      truncated: true,
      bytes: bytes("first\npartial"),
    });
    expect(result.lines.map((line) => line.text)).toEqual([
      "partial.ts",
      "first",
    ]);
    expect(result.limited).toBe(true);
  });
});
