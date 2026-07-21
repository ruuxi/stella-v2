import {
  access,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  blankInjectedHtmlComments,
  ensureDreamMemoryLayout,
  MEMORY_MAP_MAX_CHARS,
  memoryIndexPath,
  memoryMapPath,
  memorySummaryPath,
  readMemoryMap,
  stripInjectedHtmlComments,
  unicodeCodePointLength,
} from "@stella/runtime/kernel/memory/dream-storage";

const roots = new Set<string>();

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "stella-dream-storage-"));
  roots.add(root);
  return root;
};

const stagingPathForPublishedFile = async (target: string): Promise<string> => {
  const bytes = await readFile(target);
  const digest = createHash("sha256").update(bytes).digest("hex");
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.migration-v2-${digest}-999-00000000-0000-4000-8000-000000000000.tmp`,
  );
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
    expect(
      unicodeCodePointLength(stripInjectedHtmlComments(map)),
    ).toBeLessThanOrEqual(MEMORY_MAP_MAX_CHARS);
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

  it("serializes concurrent publishers and leaves one complete MEMORY/map pair", async () => {
    const root = await createRoot();
    const alias = `${root}-alias`;
    await symlink(root, alias);
    roots.add(alias);
    await mkdir(path.join(root, "memories"), { recursive: true });
    await writeFile(
      memoryIndexPath(root),
      "# Index\n\n- concurrent route -> MEMORY.md\n",
      "utf-8",
    );

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        ensureDreamMemoryLayout(index % 2 === 0 ? root : alias),
      ),
    );
    await ensureDreamMemoryLayout(root);

    await expect(
      readFile(path.join(root, "memories", "MEMORY.md"), "utf-8"),
    ).resolves.toContain("# MEMORY");
    await expect(readFile(memoryMapPath(root), "utf-8")).resolves.toContain(
      "concurrent route",
    );
    expect(
      (await readdir(path.join(root, "memories"))).filter((name) =>
        name.includes(".migration-"),
      ),
    ).toEqual([]);
  });

  it("recovers verified same-inode staging links for MEMORY and map while ignoring later legacy edits", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "memories"), { recursive: true });
    await writeFile(memorySummaryPath(root), "- original legacy focus\n");
    await ensureDreamMemoryLayout(root);
    const memoryPath = path.join(root, "memories", "MEMORY.md");
    const mapPath = memoryMapPath(root);
    const mapBefore = await readFile(mapPath, "utf-8");
    const memoryStage = await stagingPathForPublishedFile(memoryPath);
    const mapStage = await stagingPathForPublishedFile(mapPath);
    await link(memoryPath, memoryStage);
    await link(mapPath, mapStage);
    expect((await stat(memoryPath)).nlink).toBe(2);
    expect((await stat(mapPath)).nlink).toBe(2);
    await writeFile(memorySummaryPath(root), "- later retired-file edit\n");

    await ensureDreamMemoryLayout(root);

    expect((await stat(memoryPath)).nlink).toBe(1);
    expect((await stat(mapPath)).nlink).toBe(1);
    await expect(access(memoryStage)).rejects.toThrow();
    await expect(access(mapStage)).rejects.toThrow();
    await expect(readFile(mapPath, "utf-8")).resolves.toBe(mapBefore);
  });

  it("cleans only a verified unattached stage left by a crash before link", async () => {
    const root = await createRoot();
    const memories = path.join(root, "memories");
    await mkdir(memories, { recursive: true });
    const target = memoryMapPath(root);
    const orphanContents = "complete but never linked\n";
    const digest = createHash("sha256").update(orphanContents).digest("hex");
    const orphan = path.join(
      memories,
      `.memory_map.md.migration-v2-${digest}-999-00000000-0000-4000-8000-000000000000.tmp`,
    );
    const unrelated = path.join(
      memories,
      ".memory_map.md.migration-v2-not-a-certified-stage.tmp",
    );
    const wrongDigest = createHash("sha256")
      .update("different expected contents")
      .digest("hex");
    const tampered = path.join(
      memories,
      `.memory_map.md.migration-v2-${wrongDigest}-999-00000000-0000-4000-8000-000000000000.tmp`,
    );
    await writeFile(orphan, orphanContents, "utf-8");
    await writeFile(unrelated, "operator file", "utf-8");
    await writeFile(tampered, "does not match its name", "utf-8");

    await ensureDreamMemoryLayout(root);

    await expect(access(orphan)).rejects.toThrow();
    await expect(readFile(unrelated, "utf-8")).resolves.toBe("operator file");
    await expect(readFile(tampered, "utf-8")).resolves.toBe(
      "does not match its name",
    );
    await expect(readFile(target, "utf-8")).resolves.toContain("# Memory map");
  });

  it.each(["symlink", "hard link"])(
    "refuses an external legacy %s without publishing a map",
    async (kind) => {
      const root = await createRoot();
      const outside = await createRoot();
      await mkdir(path.join(root, "memories"), { recursive: true });
      const external = path.join(outside, "external-summary.md");
      await writeFile(external, "- external secret route\n", "utf-8");
      if (kind === "symlink") {
        await symlink(external, memorySummaryPath(root));
      } else {
        await link(external, memorySummaryPath(root));
      }

      await expect(ensureDreamMemoryLayout(root)).rejects.toThrow(
        /stable regular unaliased file/,
      );
      await expect(access(memoryMapPath(root))).rejects.toThrow();
      await expect(readFile(external, "utf-8")).resolves.toBe(
        "- external secret route\n",
      );
    },
  );

  it("propagates non-ENOENT legacy read errors and invalid UTF-8 without publishing", async () => {
    const directoryRoot = await createRoot();
    await mkdir(path.join(directoryRoot, "memories"), { recursive: true });
    await mkdir(memoryIndexPath(directoryRoot));
    await expect(ensureDreamMemoryLayout(directoryRoot)).rejects.toThrow(
      /stable regular unaliased file/,
    );
    await expect(access(memoryMapPath(directoryRoot))).rejects.toThrow();

    const invalidRoot = await createRoot();
    await mkdir(path.join(invalidRoot, "memories"), { recursive: true });
    await writeFile(
      memorySummaryPath(invalidRoot),
      new Uint8Array([0xc3, 0x28]),
    );
    await expect(ensureDreamMemoryLayout(invalidRoot)).rejects.toThrow(
      /invalid UTF-8/,
    );
    await expect(access(memoryMapPath(invalidRoot))).rejects.toThrow();
  });

  it("aborts and rolls back map publication when a legacy source changes after snapshot", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "memories"), { recursive: true });
    const legacyPath = memoryIndexPath(root);
    await writeFile(legacyPath, "- first stable route\n", "utf-8");

    await expect(
      ensureDreamMemoryLayout(root, {
        afterLegacySnapshotsRead: async () => {
          await writeFile(legacyPath, "- changed during migration\n", "utf-8");
        },
      }),
    ).rejects.toThrow(/changed during migration/);
    await expect(access(memoryMapPath(root))).rejects.toThrow();
    expect(
      (await readdir(path.join(root, "memories"))).filter((name) =>
        name.startsWith(".memory_map.md.migration-"),
      ),
    ).toEqual([]);
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
    expect(
      unicodeCodePointLength(stripInjectedHtmlComments(map)),
    ).toBeLessThanOrEqual(MEMORY_MAP_MAX_CHARS);
    expect(map).toContain("migration cut");
    await expect(readFile(memorySummaryPath(root), "utf-8")).resolves.toBe(
      summary,
    );
    await expect(readFile(memoryIndexPath(root), "utf-8")).resolves.toBe(index);
  });

  it("folds emoji and combining-mark CRLF input only at complete line boundaries", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "memories"), { recursive: true });
    const line = "- route 😀 cafe\u0301 -> MEMORY.md\r\n";
    const legacy = line.repeat(600);
    await writeFile(memoryIndexPath(root), legacy, "utf-8");

    await ensureDreamMemoryLayout(root);

    const map = await readFile(memoryMapPath(root), "utf-8");
    const injected = stripInjectedHtmlComments(map);
    expect(unicodeCodePointLength(injected)).toBeLessThanOrEqual(
      MEMORY_MAP_MAX_CHARS,
    );
    expect(injected).toContain("😀");
    expect(injected).toContain("cafe\u0301");
    expect(injected).not.toMatch(/\r(?!\n)/u);
    expect(injected).not.toContain("\uFFFD");
    expect(/(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(injected)).toBe(false);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(injected)).toBe(false);
    expect(map).toContain("migration cut");
  });
});

describe("blankInjectedHtmlComments", () => {
  it("blanks closed and unterminated comments without changing line positions", () => {
    const raw = [
      "<!-- DREAM:MAP_CHARTER",
      "guidance the model must not match",
      "-->",
      "# Memory map",
      "- real entry",
      "<!-- never closed",
      "still hidden",
    ].join("\n");

    const blanked = blankInjectedHtmlComments(raw);

    expect(blanked.split("\n")).toEqual([
      "",
      "",
      "",
      "# Memory map",
      "- real entry",
      "",
      "",
    ]);
    expect(blanked).not.toContain("guidance");
    expect(blanked).not.toContain("still hidden");
  });
});
