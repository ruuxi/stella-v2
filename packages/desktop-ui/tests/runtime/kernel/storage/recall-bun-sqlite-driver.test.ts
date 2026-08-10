import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Recall bun:sqlite production driver", () => {
  it("executes MATCH preflight, batched neighbors, and explicit degradation", () => {
    const isolatedDataDir = mkdtempSync(
      path.join(os.tmpdir(), "stella-v2-bun-recall-"),
    );
    const fixturePath = path.resolve(
      import.meta.dirname,
      "../../../fixtures/bun-sqlite-recall-driver.ts",
    );
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("STELLA_")) delete env[key];
    }
    env.STELLA_V2_DEV_DATA_DIR = isolatedDataDir;

    try {
      const result = spawnSync("bun", [fixturePath, isolatedDataDir], {
        cwd: path.resolve(import.meta.dirname, "../../../../../.."),
        env,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        health: {
          healthy: true,
          transcriptReady: true,
          threadsReady: true,
        },
        neighbors: [["before zanzibar", "after zanzibar"]],
        missingIndexTypedError: true,
        brokenMatchHealth: {
          healthy: false,
          transcriptReady: false,
          threadsReady: true,
          reason: expect.stringContaining("transcript FTS MATCH probe failed"),
        },
        brokenMatchTypedError: true,
        likeHits: [
          "after zanzibar",
          "the secret is zanzibar",
          "before zanzibar",
        ],
      });
      expect(result.stderr).toContain("[stella:recall:fts-degraded]");
      expect(result.stderr).toContain('"reason":"index table is missing"');
      expect(result.stderr).toContain('"reason":"MATCH query failed"');
      expect(result.stderr).toContain('"reason":"explicit LIKE mode"');
    } finally {
      rmSync(isolatedDataDir, { recursive: true, force: true });
    }
  });
});
