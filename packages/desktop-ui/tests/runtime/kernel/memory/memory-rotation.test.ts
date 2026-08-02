import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  appendSupersededMemoryText,
  memoryArchiveRoot,
  memorySupersededArchivePath,
  rotateMemoryFileIfNeeded,
} from "@stella/runtime/kernel/memory/memory-rotation";

const roots = new Set<string>();
const createRoot = async (): Promise<string> => {
  const root = path.join(
    os.tmpdir(),
    `stella-memory-rotation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  roots.add(root);
  await mkdir(path.join(root, "memories"), { recursive: true });
  return root;
};

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

const buildLargeMemory = (): { raw: string; titles: string[] } => {
  const blocks: string[] = [];
  const titles: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const day = String(20 - index).padStart(2, "0");
    const title = `workstream-${index}`;
    titles.push(title);
    blocks.push(
      `## 2026-06-${day} 12:00 — ${title}\nThreads: thread-${index}\nOutcome: ${"x".repeat(39_000)}\nRecall hooks: ${title}`,
    );
  }
  return {
    titles,
    raw: `# MEMORY\n\n<!-- DREAM:ACTIVE_BLOCKS_START -->\n${blocks.join("\n\n")}\n<!-- DREAM:ACTIVE_BLOCKS_END -->\n\n## Archive\n\n<!-- DREAM:ARCHIVE_START -->\n<!-- DREAM:ARCHIVE_END -->\n`,
  };
};

describe("MEMORY.md rotation", () => {
  it("copy-first rotates old blocks and is idempotent under concurrent retries", async () => {
    const root = await createRoot();
    const memoryPath = path.join(root, "memories", "MEMORY.md");
    const fixture = buildLargeMemory();
    await writeFile(memoryPath, fixture.raw, "utf-8");

    const outcomes = await Promise.all([
      rotateMemoryFileIfNeeded(root),
      rotateMemoryFileIfNeeded(root),
    ]);
    const completed = outcomes.filter(
      (outcome): outcome is NonNullable<typeof outcome> => outcome !== null,
    );
    expect(completed).toHaveLength(1);
    const rotated = completed[0]!.rotatedBlocks;
    const active = await readFile(memoryPath, "utf-8");
    expect(Buffer.byteLength(active, "utf-8")).toBeLessThanOrEqual(240_000);
    for (const title of fixture.titles.slice(0, 10 - rotated)) {
      expect(active).toContain(title);
    }
    for (const title of fixture.titles.slice(10 - rotated)) {
      expect(active).not.toContain(title);
    }
    const archiveNames = await readdir(memoryArchiveRoot(root));
    expect(archiveNames).toEqual(["MEMORY-2026-Q2.md"]);
    const archive = await readFile(
      path.join(memoryArchiveRoot(root), archiveNames[0]!),
      "utf-8",
    );
    for (const title of fixture.titles.slice(10 - rotated)) {
      expect(
        archive.match(new RegExp(`^## .* — ${title}$`, "gmu")),
      ).toHaveLength(1);
    }
    expect(await rotateMemoryFileIfNeeded(root)).toBeNull();
  });

  it("recovers a crash after verified archive copies but before active rewrite", async () => {
    const root = await createRoot();
    const memoryPath = path.join(root, "memories", "MEMORY.md");
    const fixture = buildLargeMemory();
    await writeFile(memoryPath, fixture.raw, "utf-8");

    await expect(
      rotateMemoryFileIfNeeded(root, {
        beforeActiveRewrite: () => {
          throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow("simulated crash");
    expect(await readFile(memoryPath, "utf-8")).toBe(fixture.raw);

    const recovered = await rotateMemoryFileIfNeeded(root);
    expect(recovered?.rotatedBlocks).toBeGreaterThan(0);
    const archive = await readFile(
      path.join(memoryArchiveRoot(root), "MEMORY-2026-Q2.md"),
      "utf-8",
    );
    for (const title of fixture.titles.slice(
      10 - (recovered?.rotatedBlocks ?? 0),
    )) {
      expect(
        archive.match(new RegExp(`^## .* — ${title}$`, "gmu")),
      ).toHaveLength(1);
    }
  });

  it("journals a superseded span once before destructive edits", async () => {
    const root = await createRoot();
    await Promise.all([
      appendSupersededMemoryText(root, "## old block\nold facts"),
      appendSupersededMemoryText(root, "## old block\nold facts"),
    ]);
    const journal = await readFile(memorySupersededArchivePath(root), "utf-8");
    expect(journal).toContain("## old block\nold facts");
    expect(journal.match(/^## old block$/gmu)).toHaveLength(1);
  });
});
