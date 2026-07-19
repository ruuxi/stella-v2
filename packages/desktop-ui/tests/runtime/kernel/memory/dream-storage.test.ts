import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ensureDreamMemoryLayout,
  memoryIndexPath,
  MEMORY_INDEX_MAX_CHARS,
  MEMORY_INDEX_MAX_ENTRIES,
  MEMORY_INDEX_STALE_DAYS,
  readMemoryIndex,
} from "@stella/runtime/kernel/memory/dream-storage";

describe("Dream memory layout", () => {
  it("seeds the bounded routing index without creating Remember's profile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stella-dream-storage-"));
    try {
      await ensureDreamMemoryLayout(root);

      const index = await readMemoryIndex(root);
      expect(index).toContain("# Memory routing index");
      expect(index).toContain("DREAM:INDEX_START");
      expect(index).toContain(`Maximum ${MEMORY_INDEX_MAX_ENTRIES} entries`);
      expect(index).toContain(`${MEMORY_INDEX_MAX_CHARS} characters`);
      expect(index).toContain(
        `prune entries older than ${MEMORY_INDEX_STALE_DAYS} days`,
      );
      expect(index).toContain("Never store secrets, credentials, tokens");
      await expect(
        access(path.join(root, "memories", "profile.md")),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an existing routing index when ensuring the layout again", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stella-dream-storage-"));
    try {
      await ensureDreamMemoryLayout(root);
      await writeFile(
        memoryIndexPath(root),
        "# User-maintained routing index\n",
      );
      await ensureDreamMemoryLayout(root);

      await expect(readFile(memoryIndexPath(root), "utf-8")).resolves.toBe(
        "# User-maintained routing index\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
