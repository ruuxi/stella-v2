import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyAnchoredEdit,
  formatWithHashLines,
  hashLineTag,
  parseAnchor,
  resolveAnchor,
  stripHashLinePrefixes,
} from "@stella/runtime/kernel/tools/hashline";
import { handleEdit, handleRead } from "@stella/runtime/kernel/tools/file";
import { createAsyncTempDirTracker } from "../../../helpers/temp.js";

const tempDirs = createAsyncTempDirTracker();

afterEach(() => tempDirs.cleanup());

const anchorFor = (lines: string[], lineNumber: number) => ({
  line: lineNumber,
  hash: hashLineTag(lines[lineNumber - 1] ?? ""),
});

describe("hashLineTag", () => {
  it("is stable and content-sensitive", () => {
    expect(hashLineTag("const a = 1;")).toBe(hashLineTag("const a = 1;"));
    expect(hashLineTag("const a = 1;")).not.toBe(hashLineTag("const a = 2;"));
    expect(hashLineTag("  indented")).not.toBe(hashLineTag("indented"));
  });

  it("produces fixed-width base36 tags", () => {
    for (const line of ["", "x", "a longer line with symbols !@#"]) {
      expect(hashLineTag(line)).toMatch(/^[0-9a-z]{3}$/);
    }
  });
});

describe("parseAnchor", () => {
  it("parses LINE#HASH tags with surrounding whitespace", () => {
    expect(parseAnchor(" 42#a4f ")).toEqual({ line: 42, hash: "a4f" });
  });

  it("rejects malformed anchors with a usage hint", () => {
    expect(() => parseAnchor("const a = 1;")).toThrow(/LINE#HASH/);
    expect(() => parseAnchor("")).toThrow(/LINE#HASH/);
  });
});

describe("resolveAnchor", () => {
  const lines = ["alpha", "beta", "gamma", "delta"];

  it("resolves an exact line+hash match", () => {
    expect(resolveAnchor(lines, anchorFor(lines, 3))).toBe(2);
  });

  it("relocates by hash when lines shifted", () => {
    const shifted = ["inserted", ...lines];
    // Anchor was taken when "gamma" sat on line 3; it now sits on line 4.
    expect(resolveAnchor(shifted, anchorFor(lines, 3))).toBe(3);
  });

  it("prefers the occurrence closest to the hinted line for duplicates", () => {
    const dupes = ["x", "same", "y", "z", "same", "w"];
    expect(resolveAnchor(dupes, { line: 6, hash: hashLineTag("same") })).toBe(4);
  });

  it("fails with fresh context when the content is gone", () => {
    expect(() =>
      resolveAnchor(lines, { line: 2, hash: hashLineTag("vanished") }),
    ).toThrow(/Re-read the file/);
  });
});

describe("stripHashLinePrefixes", () => {
  it("strips pasted Read prefixes when every line has one", () => {
    expect(stripHashLinePrefixes("    12#a4f\tconst a = 1;\n    13#b2c\tconst b = 2;")).toBe(
      "const a = 1;\nconst b = 2;",
    );
  });

  it("leaves mixed or plain content untouched", () => {
    const plain = "const a = 1;\nconst b = 2;";
    expect(stripHashLinePrefixes(plain)).toBe(plain);
    const mixed = "12#a4f\tconst a = 1;\nno prefix here";
    expect(stripHashLinePrefixes(mixed)).toBe(mixed);
  });
});

describe("applyAnchoredEdit", () => {
  const content = ["one", "two", "three", "four"].join("\n");
  const lines = content.split("\n");

  it("replaces a single anchored line", () => {
    const result = applyAnchoredEdit(content, {
      anchor: anchorFor(lines, 2),
      newText: "TWO",
    });
    expect(result.content).toBe("one\nTWO\nthree\nfour");
    expect(result).toMatchObject({ startLine: 2, endLine: 2, linesRemoved: 1, linesAdded: 1 });
  });

  it("replaces an inclusive range", () => {
    const result = applyAnchoredEdit(content, {
      anchor: anchorFor(lines, 2),
      endAnchor: anchorFor(lines, 3),
      newText: "middle",
    });
    expect(result.content).toBe("one\nmiddle\nfour");
  });

  it("deletes the range when newText is empty", () => {
    const result = applyAnchoredEdit(content, {
      anchor: anchorFor(lines, 2),
      endAnchor: anchorFor(lines, 3),
      newText: "",
    });
    expect(result.content).toBe("one\nfour");
    expect(result.linesAdded).toBe(0);
  });

  it("inserts after the anchor line", () => {
    const result = applyAnchoredEdit(content, {
      anchor: anchorFor(lines, 1),
      newText: "one.five",
      insertAfter: true,
    });
    expect(result.content).toBe("one\none.five\ntwo\nthree\nfour");
    expect(result.linesRemoved).toBe(0);
  });

  it("rejects an inverted range", () => {
    expect(() =>
      applyAnchoredEdit(content, {
        anchor: anchorFor(lines, 3),
        endAnchor: anchorFor(lines, 2),
        newText: "nope",
      }),
    ).toThrow(/top to bottom/);
  });
});

describe("Read/Edit anchor round trip", () => {
  it("Read emits anchors that Edit applies verbatim", async () => {
    const root = await tempDirs.create("stella-hashline-");
    const filePath = path.join(root, "sample.ts");
    await writeFile(filePath, "const a = 1;\nconst b = 2;\nconst c = 3;\n", "utf-8");

    const read = await handleRead({ file_path: filePath });
    expect(read.error).toBeUndefined();
    const anchorLine = String(read.result)
      .split("\n")
      .find((line) => line.includes("const b = 2;"));
    expect(anchorLine).toBeDefined();
    const anchor = anchorLine!.split("\t")[0]!.trim();
    expect(anchor).toMatch(/^\d+#[0-9a-z]{3}$/);

    const edit = await handleEdit({
      file_path: filePath,
      anchor,
      new_string: "const b = 20;",
    });
    expect(edit.error).toBeUndefined();
    expect(edit.result).toContain("Replaced line 2");
    expect(await readFile(filePath, "utf-8")).toBe(
      "const a = 1;\nconst b = 20;\nconst c = 3;\n",
    );
  });

  it("anchors survive line drift from an earlier edit", async () => {
    const root = await tempDirs.create("stella-hashline-");
    const filePath = path.join(root, "drift.txt");
    await writeFile(filePath, "header\nalpha\nbeta\ngamma\n", "utf-8");

    const read = await handleRead({ file_path: filePath });
    const anchorOf = (needle: string) =>
      String(read.result)
        .split("\n")
        .find((line) => line.endsWith(`\t${needle}`))!
        .split("\t")[0]!
        .trim();

    // First edit inserts above, shifting every later line down.
    const first = await handleEdit({
      file_path: filePath,
      anchor: anchorOf("header"),
      new_string: "header\nnew line",
    });
    expect(first.error).toBeUndefined();

    // Stale anchor for "gamma" (originally line 4, now line 5) relocates.
    const second = await handleEdit({
      file_path: filePath,
      anchor: anchorOf("gamma"),
      new_string: "GAMMA",
    });
    expect(second.error).toBeUndefined();
    expect(await readFile(filePath, "utf-8")).toBe(
      "header\nnew line\nalpha\nbeta\nGAMMA\n",
    );
  });

  it("reports stale anchors with re-read guidance", async () => {
    const root = await tempDirs.create("stella-hashline-");
    const filePath = path.join(root, "stale.txt");
    await writeFile(filePath, "aaa\nbbb\nccc\n", "utf-8");

    const edit = await handleEdit({
      file_path: filePath,
      anchor: "2#zzz",
      new_string: "replacement",
    });
    expect(edit.error).toMatch(/Re-read the file/);
  });

  it("preserves CRLF line endings through anchored edits", async () => {
    const root = await tempDirs.create("stella-hashline-");
    const filePath = path.join(root, "crlf.txt");
    await writeFile(filePath, "one\r\ntwo\r\nthree\r\n", "utf-8");

    const read = await handleRead({ file_path: filePath });
    const anchor = String(read.result)
      .split("\n")
      .find((line) => line.endsWith("\ttwo"))!
      .split("\t")[0]!
      .trim();

    const edit = await handleEdit({
      file_path: filePath,
      anchor,
      new_string: "TWO",
    });
    expect(edit.error).toBeUndefined();
    expect(await readFile(filePath, "utf-8")).toBe("one\r\nTWO\r\nthree\r\n");
  });

  it("classic old_string mode still works without anchors", async () => {
    const root = await tempDirs.create("stella-hashline-");
    const filePath = path.join(root, "classic.txt");
    await writeFile(filePath, "keep\nreplace me\nkeep\n", "utf-8");

    const edit = await handleEdit({
      file_path: filePath,
      old_string: "replace me",
      new_string: "replaced",
    });
    expect(edit.error).toBeUndefined();
    expect(await readFile(filePath, "utf-8")).toBe("keep\nreplaced\nkeep\n");
  });
});
