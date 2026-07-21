import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureDreamMemoryLayout,
  MEMORY_MAP_MAX_CHARS,
  memoryIndexPath,
  memoryMapPath,
  memorySummaryPath,
  readMemoryMap,
  stripInjectedHtmlComments,
} from "@stella/runtime/kernel/memory/dream-storage";

const roots = new Set<string>();

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "stella-dream-storage-"));
  roots.add(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.clear();
});

describe("Dream memory_map layout and migration", () => {
  it("seeds MEMORY.md and memory_map.md without creating retired files", async () => {
    const root = await createRoot();

    await ensureDreamMemoryLayout(root);

    const map = await readMemoryMap(root);
    expect(map).toContain("# Memory map");
    expect(map).toContain("DREAM:MAP_START");
    expect(map).toContain("## Derived constraints");
    await expect(access(memorySummaryPath(root))).rejects.toThrow();
    await expect(access(memoryIndexPath(root))).rejects.toThrow();
    await expect(
      readFile(path.join(root, "memories", "MEMORY.md"), "utf-8"),
    ).resolves.toContain("# MEMORY");
    await expect(
      access(path.join(root, "memories", "profile.md")),
    ).rejects.toThrow();
  });

  it("derives one bounded map from both legacy files without changing either", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "memories"), { recursive: true });
    const summary =
      "# Memory summary\n\n<!-- DREAM:SUMMARY_START -->\n- Shipping the certified redesign.\n<!-- DREAM:SUMMARY_END -->\n<!-- DREAM:RETIRED_SUMMARY\n- old archived bullet\n-->\n";
    const index =
      "# Memory routing index\n\n<!-- DREAM:INDEX_START -->\n- benchmark -> MEMORY.md 2026-07-18 | aliases: self-mod\n<!-- DREAM:INDEX_END -->\n";
    await writeFile(memorySummaryPath(root), summary, "utf-8");
    await writeFile(memoryIndexPath(root), index, "utf-8");

    await ensureDreamMemoryLayout(root);

    const map = await readFile(memoryMapPath(root), "utf-8");
    expect(map).toContain("benchmark -> MEMORY.md");
    expect(map).toContain("Migrated focus notes");
    expect(map).toContain("Shipping the certified redesign");
    expect(map).not.toContain("old archived bullet");
    expect(stripInjectedHtmlComments(map).length).toBeLessThanOrEqual(
      MEMORY_MAP_MAX_CHARS,
    );
    await expect(readFile(memorySummaryPath(root), "utf-8")).resolves.toBe(
      summary,
    );
    await expect(readFile(memoryIndexPath(root), "utf-8")).resolves.toBe(index);
  });

  it.each([
    {
      name: "summary only",
      fileName: "memory_summary.md",
      content: "# Memory summary\n\n- partial summary signal\n",
      expected: "partial summary signal",
    },
    {
      name: "index only",
      fileName: "memory_index.md",
      content: "# Memory index\n\n- partial index signal\n",
      expected: "partial index signal",
    },
  ])("recovers a partial migration with $name", async (fixture) => {
    const root = await createRoot();
    await mkdir(path.join(root, "memories"), { recursive: true });
    const legacyPath = path.join(root, "memories", fixture.fileName);
    await writeFile(legacyPath, fixture.content, "utf-8");

    // A non-file at the destination is fail-closed. No legacy bytes change,
    // and removing the conflicting artifact lets the next startup retry.
    await mkdir(memoryMapPath(root));
    await expect(ensureDreamMemoryLayout(root)).rejects.toThrow(
      /expected a regular/,
    );
    await expect(readFile(legacyPath, "utf-8")).resolves.toBe(fixture.content);

    await rm(memoryMapPath(root), { recursive: true, force: true });
    await ensureDreamMemoryLayout(root);
    await expect(readFile(memoryMapPath(root), "utf-8")).resolves.toContain(
      fixture.expected,
    );
    await expect(readFile(legacyPath, "utf-8")).resolves.toBe(fixture.content);
  });

  it("treats an existing map as authoritative and never merges legacy conflict bytes", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "memories"), { recursive: true });
    const existingMap =
      "<!-- DREAM:MAP_START -->\n# User-curated map\n<!-- DREAM:MAP_END -->\n";
    const legacy = "# Memory summary\n\n- must not overwrite map\n";
    await writeFile(memoryMapPath(root), existingMap, "utf-8");
    await writeFile(memorySummaryPath(root), legacy, "utf-8");

    await ensureDreamMemoryLayout(root);
    await ensureDreamMemoryLayout(root);

    await expect(readFile(memoryMapPath(root), "utf-8")).resolves.toBe(
      existingMap,
    );
    await expect(readFile(memorySummaryPath(root), "utf-8")).resolves.toBe(
      legacy,
    );
  });

  it("refuses a symlinked memory root without writing through the jail", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    await symlink(outside, path.join(root, "memories"), "dir");

    await expect(ensureDreamMemoryLayout(root)).rejects.toThrow(
      /expected a real directory owned by Stella/,
    );
    await expect(access(path.join(outside, "MEMORY.md"))).rejects.toThrow();
    await expect(access(path.join(outside, "memory_map.md"))).rejects.toThrow();
  });

  it("bounds oversized legacy folds and points to unchanged source files", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "memories"), { recursive: true });
    const summary = Array.from(
      { length: 500 },
      (_, index) => `- focus bullet ${index} with detailed routing context`,
    ).join("\n");
    const index = Array.from(
      { length: 500 },
      (_, index) => `- route ${index} -> MEMORY.md block ${index}`,
    ).join("\n");
    await writeFile(memorySummaryPath(root), summary, "utf-8");
    await writeFile(memoryIndexPath(root), index, "utf-8");

    await ensureDreamMemoryLayout(root);

    const map = await readFile(memoryMapPath(root), "utf-8");
    expect(stripInjectedHtmlComments(map).length).toBeLessThanOrEqual(
      MEMORY_MAP_MAX_CHARS,
    );
    expect(map).toContain("migration cut");
    await expect(readFile(memorySummaryPath(root), "utf-8")).resolves.toBe(
      summary,
    );
    await expect(readFile(memoryIndexPath(root), "utf-8")).resolves.toBe(index);
  });
});
