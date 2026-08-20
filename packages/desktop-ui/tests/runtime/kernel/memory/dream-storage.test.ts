import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ensureDreamMemoryLayout,
  memoryMapPath,
  MEMORY_MAP_MAX_CHARS,
  MEMORY_MAP_MAX_ENTRIES,
  MEMORY_MAP_STALE_DAYS,
  readMemoryMap,
} from "@stella/runtime/kernel/memory/dream-storage";

describe("Dream memory layout", () => {
  it("seeds the bounded memory map without recreating retired memory files or Remember's profile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stella-dream-storage-"));
    try {
      await ensureDreamMemoryLayout(root);

      const memoryMap = await readMemoryMap(root);
      expect(memoryMap).toContain("# Memory map");
      expect(memoryMap).toContain("DREAM:MAP_START");
      expect(memoryMap).toContain(`Maximum ${MEMORY_MAP_MAX_ENTRIES} entries`);
      expect(memoryMap).toContain(`${MEMORY_MAP_MAX_CHARS} characters`);
      expect(memoryMap).toContain(
        `prune entries older than ${MEMORY_MAP_STALE_DAYS} days`,
      );
      expect(memoryMap).toContain("Never store secrets, credentials, tokens");
      await expect(
        access(path.join(root, "memories", "memory_summary.md")),
      ).rejects.toThrow();
      await expect(
        access(path.join(root, "memories", "memory_index.md")),
      ).rejects.toThrow();
      await expect(
        access(path.join(root, "memories", "profile.md")),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an existing memory map when ensuring the layout again", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stella-dream-storage-"));
    try {
      await ensureDreamMemoryLayout(root);
      await writeFile(memoryMapPath(root), "# User-maintained memory map\n");
      await ensureDreamMemoryLayout(root);

      await expect(readFile(memoryMapPath(root), "utf-8")).resolves.toBe(
        "# User-maintained memory map\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
