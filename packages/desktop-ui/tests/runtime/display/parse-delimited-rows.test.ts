import { describe, expect, it } from "vitest";
import {
  DELIMITED_PREVIEW_MAX_ROWS,
  parseDelimitedRows,
  rowsForDelimitedPreview,
} from "../../../src/shell/display/parse-delimited-rows";

describe("parseDelimitedRows", () => {
  it("parses quoted commas and escaped quotes", () => {
    const { rows, hitLimit } = parseDelimitedRows(
      'name,note\n"Ada, Lovelace","said ""hello"""\n',
      ",",
    );
    expect(hitLimit).toBe(false);
    expect(rows).toEqual([
      ["name", "note"],
      ["Ada, Lovelace", 'said "hello"'],
    ]);
  });

  it("stops after maxRows and ignores the rest of the file", () => {
    const body = Array.from(
      { length: 2_500 },
      (_, index) => `r${index},v`,
    ).join("\n");
    const { rows, hitLimit } = parseDelimitedRows(body, ",", 1_000);
    expect(hitLimit).toBe(true);
    expect(rows).toHaveLength(1_000);
    expect(rows[0]).toEqual(["r0", "v"]);
    expect(rows[999]).toEqual(["r999", "v"]);
  });

  it("does not count a quoted newline as a row boundary", () => {
    const { rows, hitLimit } = parseDelimitedRows(
      'a,b\n"line\nstill one",c\nnext,row\n',
      ",",
      2,
    );
    expect(hitLimit).toBe(true);
    expect(rows).toEqual([
      ["a", "b"],
      ["line\nstill one", "c"],
    ]);
  });

  it("uses the preview default of 1000 rows", () => {
    const body = Array.from(
      { length: DELIMITED_PREVIEW_MAX_ROWS + 50 },
      (_, index) => String(index),
    ).join("\n");
    const { rows, hitLimit } = parseDelimitedRows(body, ",");
    expect(hitLimit).toBe(true);
    expect(rows).toHaveLength(DELIMITED_PREVIEW_MAX_ROWS);
  });
});

describe("rowsForDelimitedPreview", () => {
  it("drops the last row when a byte cap may have torn it", () => {
    const parsed = parseDelimitedRows("a,b\nc,d\ne,partial", ",", 1_000);
    expect(parsed.hitLimit).toBe(false);
    expect(rowsForDelimitedPreview(parsed, true)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("keeps every row when the parser already stopped at maxRows", () => {
    const parsed = parseDelimitedRows("a\nb\nc\n", ",", 2);
    expect(parsed.hitLimit).toBe(true);
    expect(rowsForDelimitedPreview(parsed, true)).toEqual([["a"], ["b"]]);
  });
});
