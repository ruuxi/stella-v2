import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { preserveModelVisibleToolText } from "@stella/runtime/kernel/agent-runtime/tool-adapters";
import {
  cleanupToolOutputSpills,
  DEFAULT_TOOL_OUTPUT_SPILL_MAX_AGE_MS,
  DEFAULT_TOOL_OUTPUT_SPILL_QUOTA_BYTES,
  spillSanitizedToolOutput,
} from "@stella/runtime/kernel/agent-runtime/tool-output-spill";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("durable oversized tool output", () => {
  it("uses the bounded 48-hour and 32 MiB retention policy", () => {
    expect(DEFAULT_TOOL_OUTPUT_SPILL_MAX_AGE_MS).toBe(48 * 60 * 60 * 1_000);
    expect(DEFAULT_TOOL_OUTPUT_SPILL_QUOTA_BYTES).toBe(32 * 1024 * 1024);
  });

  it("atomically preserves complete post-sanitization output with read metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-spill-"));
    roots.push(root);
    const stellaDataDir = path.join(root, ".stella");
    const text = Array.from(
      { length: 2_000 },
      (_, index) => `line-${index}`,
    ).join("\n");
    const result = await preserveModelVisibleToolText(
      text,
      { stellaDataDir, runId: "run/a", toolCallId: "call:a" },
      1_000,
    );

    expect(result.text.length).toBeLessThanOrEqual(1_000);
    expect(result.text).toContain("TOOL_OUTPUT_TRUNCATED");
    expect(result.text).toContain("bytes=");
    expect(await readFile(result.artifact.path, "utf8")).toBe(text);
    expect(result.artifact.sha256).toBe(
      createHash("sha256").update(text).digest("hex"),
    );
    expect(result.artifact.read).toMatchObject({
      tool: "Read",
      offsetUnit: "line",
      arguments: { file_path: result.artifact.path, offset: 1, limit: 200 },
    });
    expect((await stat(result.artifact.path)).mode & 0o777).toBe(0o600);
  });

  it("deletes expired artifacts and evicts oldest output above quota", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-spill-"));
    roots.push(root);
    const stellaDataDir = path.join(root, ".stella");
    const old = await spillSanitizedToolOutput({
      text: "old".repeat(100),
      stellaDataDir,
      runId: "run",
      toolCallId: "old",
    });
    const fresh = await spillSanitizedToolOutput({
      text: "fresh".repeat(100),
      stellaDataDir,
      runId: "run",
      toolCallId: "fresh",
    });
    await utimes(old.path, new Date(0), new Date(0));

    await cleanupToolOutputSpills({
      stellaDataDir,
      now: Date.now(),
      maxAgeMs: 1_000,
      quotaBytes: 10_000,
    });
    await expect(stat(old.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fresh.path)).resolves.toBeDefined();

    await cleanupToolOutputSpills({
      stellaDataDir,
      maxAgeMs: Number.MAX_SAFE_INTEGER,
      quotaBytes: 1,
    });
    await expect(stat(fresh.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deduplicates concurrent identical spills without a partial file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-spill-"));
    roots.push(root);
    const args = {
      text: "complete sanitized output\n".repeat(1_000),
      stellaDataDir: path.join(root, ".stella"),
      runId: "same-run",
      toolCallId: "same-call",
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, () => spillSanitizedToolOutput(args)),
    );

    expect(new Set(results.map((result) => result.path)).size).toBe(1);
    expect(await readFile(results[0]!.path, "utf8")).toBe(args.text);
  });
});
