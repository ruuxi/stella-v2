import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots = new Set<string>();

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

describe("memory deep consolidation report", () => {
  it("reports rotation/merge work without mutating memory files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-deep-report-"));
    roots.add(root);
    const memories = path.join(root, "memories");
    await mkdir(memories, { recursive: true });
    const memoryPath = path.join(memories, "MEMORY.md");
    const memory = `# MEMORY
<!-- DREAM:ACTIVE_BLOCKS_START -->
## 2026-06-02 — Stella parity
Outcome: second pass

## 2026-06-01 — Stella parity
Outcome: first pass
<!-- DREAM:ACTIVE_BLOCKS_END -->
## Archive
<!-- DREAM:ARCHIVE_START -->
<!-- DREAM:ARCHIVE_END -->
`;
    await writeFile(memoryPath, memory, "utf-8");
    await writeFile(
      path.join(memories, "memory_summary.md"),
      "legacy",
      "utf-8",
    );

    const script = path.resolve(
      import.meta.dirname,
      "../../../../runtime/scripts/memory-deep-consolidation-report.mjs",
    );
    const { stdout } = await execFileAsync(process.execPath, [
      script,
      "--memories-dir",
      memories,
    ]);
    expect(stdout).toContain("# MEMORY.md deep-consolidation report");
    expect(stdout).toContain('"stella parity" x 2');
    expect(stdout).toContain("archive/MEMORY-superseded.md");
    expect(stdout).toContain("memory_summary.md: present");
    expect(stdout).toContain("memory_index.md: absent");
    expect(await readFile(memoryPath, "utf-8")).toBe(memory);
  });
});
