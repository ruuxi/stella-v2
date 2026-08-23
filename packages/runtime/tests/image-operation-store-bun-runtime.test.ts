import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  claimImageOperationSubmission,
  reserveDurableImageOperation,
  settleImageOperation,
} from "../kernel/tools/image-operation-store.js";

/**
 * Runtime-contract regression for the node:sqlite worker launch blocker:
 * the image operation store must initialize and round-trip under BOTH
 * runtimes the runtime executes on — Node (this test process) and Bun
 * (the detached worker's launcher runtime, exercised by spawning the real
 * bun binary against the real source module).
 */

const resolveBunBinary = (): string | null => {
  const candidates = [
    process.env.STELLA_BUN_PATH?.trim(),
    process.env.BUN_PATH?.trim(),
  ];
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (homeDir) {
    candidates.push(
      path.join(
        homeDir,
        ".bun",
        "bin",
        process.platform === "win32" ? "bun.exe" : "bun",
      ),
    );
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
};

describe("image operation store runtime portability", () => {
  it("initializes and round-trips under Node via the portable seam", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "stella-imgop-node-"));
    try {
      const reserved = reserveDurableImageOperation({
        stellaDataDir: dataDir,
        conversationId: "conv-1",
        toolCallId: "call-1",
        requestBody: { prompt: "a cat" },
      });
      expect(reserved.reattached).toBe(false);
      expect(
        claimImageOperationSubmission({
          stellaDataDir: dataDir,
          operationId: reserved.operationId,
        }),
      ).toBe(true);
      settleImageOperation({
        stellaDataDir: dataDir,
        operationId: reserved.operationId,
        result: {
          ok: false,
          status: "failed",
          message: "test settle",
        } as never,
      });
      const reattached = reserveDurableImageOperation({
        stellaDataDir: dataDir,
        conversationId: "conv-1",
        toolCallId: "call-1",
        requestBody: { prompt: "a cat" },
      });
      expect(reattached.reattached).toBe(true);
      expect(reattached.terminalResult).toBeDefined();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("initializes and round-trips under Bun (the detached worker's runtime)", () => {
    const bun = resolveBunBinary();
    if (!bun) {
      // Environment without Bun: the build-time chunk smoke still guards
      // packaged builds; nothing to execute here.
      console.warn("bun binary not found; skipping Bun runtime round-trip");
      return;
    }
    const storePath = fileURLToPath(
      new URL("../kernel/tools/image-operation-store.ts", import.meta.url),
    );
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "stella-imgop-bun-"));
    try {
      const script = [
        `const { reserveDurableImageOperation, claimImageOperationSubmission, settleImageOperation } = await import(${JSON.stringify(storePath)});`,
        `const dataDir = ${JSON.stringify(dataDir)};`,
        'const reserved = reserveDurableImageOperation({ stellaDataDir: dataDir, conversationId: "conv-bun", toolCallId: "call-bun", requestBody: { prompt: "a dog" } });',
        'if (reserved.reattached) throw new Error("fresh reserve reported reattached");',
        "if (!claimImageOperationSubmission({ stellaDataDir: dataDir, operationId: reserved.operationId })) throw new Error('claim failed');",
        'settleImageOperation({ stellaDataDir: dataDir, operationId: reserved.operationId, result: { ok: false, status: "failed", message: "bun settle" } });',
        'const reattached = reserveDurableImageOperation({ stellaDataDir: dataDir, conversationId: "conv-bun", toolCallId: "call-bun", requestBody: { prompt: "a dog" } });',
        'if (!reattached.reattached || !reattached.terminalResult) throw new Error("reattach failed");',
        'console.log("BUN_ROUNDTRIP_OK");',
      ].join("\n");
      const result = spawnSync(bun, ["--eval", script], {
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(
        result.stdout,
        result.stderr || result.stdout,
      ).toContain("BUN_ROUNDTRIP_OK");
      expect(result.status).toBe(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
