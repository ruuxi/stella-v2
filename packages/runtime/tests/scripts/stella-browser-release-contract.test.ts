import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

describe("Stella Browser release contract", () => {
  it("rejects a pinned manifest whose sourceSha does not match", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "browser-pin-test-"));
    const manifestPath = path.join(tempDir, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ sourceSha: "a".repeat(40), assets: {} }),
    );
    try {
      const result = spawnSync(
        process.execPath,
        [
          path.join(
            repoRoot,
            "packages/desktop/scripts/download-stella-browser.mjs",
          ),
          "--manifest-file",
          manifestPath,
          "--expected-source-sha",
          "b".repeat(40),
          "--platform",
          "darwin-arm64",
        ],
        { encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Stella Browser manifest sourceSha did not match",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
