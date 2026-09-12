import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MODEL_VISIBLE_TOOL_RESULT_MAX_BYTES,
  MODEL_VISIBLE_TOOL_RESULT_MAX_LINES,
  preserveModelVisibleToolText,
  truncateModelVisibleToolText,
} from "@stella/runtime/kernel/agent-runtime/tool-adapters";
import { truncate } from "@stella/runtime/kernel/tools/utils";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  truncateTail,
  utf8ByteLength,
} from "@stella/runtime/kernel/tools/truncate";

const encoder = new TextEncoder();

function byteLength(content: string): number {
  return encoder.encode(content).length;
}

function bufferTail(content: string, maxBytes: number): string {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length <= maxBytes) return content;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

describe("Pi-harness truncation utilities", () => {
  it("counts UTF-8 bytes without treating characters as bytes", () => {
    const content = "aé🙂\nb";
    const result = truncateHead(content, { maxBytes: 100, maxLines: 10 });

    expect(result.truncated).toBe(false);
    expect(result.totalBytes).toBe(byteLength(content));
    expect(result.outputBytes).toBe(byteLength(content));
    expect(result.totalBytes).toBe(9);
  });

  it("does not count a trailing newline as an extra line", () => {
    const content = `${Array.from({ length: 3 }, () => "line").join("\n")}\n`;
    const head = truncateHead(content, { maxBytes: 100, maxLines: 3 });
    const tail = truncateTail(content, { maxBytes: 100, maxLines: 3 });

    expect(head).toMatchObject({ truncated: false, totalLines: 3, outputLines: 3 });
    expect(tail).toMatchObject({ truncated: false, totalLines: 3, outputLines: 3 });
  });

  it("truncates head on UTF-8 byte limits without partial lines", () => {
    const content = "éé\nabc";
    const result = truncateHead(content, { maxBytes: 4, maxLines: 10 });

    expect(result.content).toBe("éé");
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("bytes");
    expect(result.outputBytes).toBe(4);
    expect(result.firstLineExceedsLimit).toBe(false);
  });

  it("reports head truncation when the first line exceeds the byte limit", () => {
    const result = truncateHead("éé\nabc", { maxBytes: 3, maxLines: 10 });

    expect(result.content).toBe("");
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("bytes");
    expect(result.firstLineExceedsLimit).toBe(true);
  });

  it("truncates tail on UTF-8 boundaries when only a partial last line fits", () => {
    const result = truncateTail("aé🙂b", { maxBytes: 5, maxLines: 10 });

    expect(result.content).toBe("🙂b");
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("bytes");
    expect(result.lastLinePartial).toBe(true);
    expect(result.outputBytes).toBe(5);
  });

  it("matches Buffer tail truncation semantics for surrogate edge cases", () => {
    for (const input of ["a\ud83d", "\ude42b", "👩‍💻"]) {
      const totalBytes = Buffer.byteLength(input, "utf8");
      for (const maxBytes of [0, 1, 2, 3, 4, totalBytes, totalBytes + 1]) {
        const result = truncateTail(input, { maxBytes, maxLines: 10 });
        expect(result.content).toBe(bufferTail(input, maxBytes));
        expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(maxBytes);
      }
    }
  });

  it("uses 2000 lines or 50KB, whichever is hit first", () => {
    expect(DEFAULT_MAX_LINES).toBe(2000);
    expect(DEFAULT_MAX_BYTES).toBe(50 * 1024);
    expect(MODEL_VISIBLE_TOOL_RESULT_MAX_LINES).toBe(2000);
    expect(MODEL_VISIBLE_TOOL_RESULT_MAX_BYTES).toBe(50 * 1024);

    const underBytes = "a".repeat(DEFAULT_MAX_BYTES);
    expect(truncateHead(underBytes).truncated).toBe(false);

    const overBytes = Array.from(
      { length: 2_000 },
      () => "a".repeat(40),
    ).join("\n");
    const byteHit = truncateHead(overBytes);
    expect(byteHit.truncated).toBe(true);
    expect(byteHit.truncatedBy).toBe("bytes");
    expect(byteHit.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(byteHit.outputBytes).toBeGreaterThan(DEFAULT_MAX_BYTES - 50);

    const overLines = Array.from({ length: DEFAULT_MAX_LINES + 1 }, (_, i) => `l${i}`).join("\n");
    const lineHit = truncateHead(overLines);
    expect(lineHit.truncated).toBe(true);
    expect(lineHit.truncatedBy).toBe("lines");
    expect(lineHit.outputLines).toBe(DEFAULT_MAX_LINES);
  });
});

describe("truncateModelVisibleToolText harness policy", () => {
  it("leaves output at the 50KB ASCII boundary unchanged", () => {
    const text = "a".repeat(DEFAULT_MAX_BYTES);
    const result = truncateModelVisibleToolText(text);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(text);
  });

  it("truncates one byte past 50KB and keeps a head/tail preview plus marker", () => {
    const text = `HEAD-${"a".repeat(DEFAULT_MAX_BYTES)}-TAIL`;
    const result = truncateModelVisibleToolText(text);

    expect(result.truncated).toBe(true);
    expect(result.originalBytes).toBe(utf8ByteLength(text));
    expect(utf8ByteLength(result.text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(result.text).toContain("Tool output truncated");
    expect(result.text).toContain("bytes omitted");
    expect(result.text.startsWith("HEAD-")).toBe(true);
    expect(result.text.endsWith("-TAIL")).toBe(true);
  });

  it("truncates on the 2000-line limit even when well under 50KB", () => {
    const text = Array.from({ length: 2001 }, (_, i) => `line-${i}`).join("\n");
    const result = truncateModelVisibleToolText(text);

    expect(utf8ByteLength(text)).toBeLessThan(DEFAULT_MAX_BYTES);
    expect(result.truncated).toBe(true);
    expect(result.originalLines).toBe(2001);
    expect(result.text).toContain("Total output lines: 2001");
    expect(result.text.startsWith("line-0")).toBe(true);
    expect(result.text).toContain("line-2000");
  });

  it("counts UTF-8 bytes, not JS string length", () => {
    const text = "é".repeat(DEFAULT_MAX_BYTES / 2 + 1);
    expect(text.length).toBeLessThan(DEFAULT_MAX_BYTES);
    expect(utf8ByteLength(text)).toBeGreaterThan(DEFAULT_MAX_BYTES);

    const result = truncateModelVisibleToolText(text);
    expect(result.truncated).toBe(true);
    expect(result.originalBytes).toBe(utf8ByteLength(text));
    expect(utf8ByteLength(result.text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
  });
});

describe("preserveModelVisibleToolText artifact access", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
  });

  it("spills the complete output and points Read at the artifact", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-trunc-"));
    roots.push(root);
    const text = `HEAD-${"x".repeat(DEFAULT_MAX_BYTES)}-TAIL`;
    const result = await preserveModelVisibleToolText(text, {
      stellaDataDir: path.join(root, ".stella"),
      runId: "run",
      toolCallId: "call",
    });

    expect(result.truncated).toBe(true);
    expect(result.text).toContain("TOOL_OUTPUT_TRUNCATED complete post-sanitization output preserved");
    expect(result.text).toContain("Read({ file_path:");
    expect(result.text.startsWith("HEAD-")).toBe(true);
    expect(result.text).toContain("-TAIL");
    expect(await readFile(result.artifact!.path, "utf8")).toBe(text);
    expect(utf8ByteLength(result.text)).toBeLessThanOrEqual(
      DEFAULT_MAX_BYTES + utf8ByteLength(result.text.slice(result.text.indexOf("\n\n[TOOL_OUTPUT_TRUNCATED"))),
    );
  });
});

describe("legacy tool truncate helper", () => {
  it("applies the same 50KB/2000-line head policy", () => {
    const overBytes = Array.from(
      { length: 2_000 },
      () => "a".repeat(40),
    ).join("\n");
    const truncated = truncate(overBytes);
    expect(truncated).toContain("bytes truncated");
    expect(truncated.startsWith("a")).toBe(true);
    expect(truncated).not.toBe(overBytes);
  });

  it("keeps a UTF-8 prefix when a single line exceeds the byte budget", () => {
    const truncated = truncate("é".repeat(3_000), 4_000);
    expect(truncated.startsWith("é")).toBe(true);
    expect(truncated).toContain("bytes truncated");
    expect(Buffer.byteLength(truncated.split("\n\n...")[0]!, "utf8")).toBeLessThanOrEqual(4_000);
  });
});
