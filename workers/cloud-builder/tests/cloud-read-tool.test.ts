import { describe, expect, test } from "bun:test";
import { createCloudReadTool } from "../src/cloud-read-tool.js";
import { buildCloudSkillsBlock, resolveCloudSkillPath } from "../src/cloud-skills.js";
import type {
  CloudHomeStore,
  CloudSkillCatalogSnapshot,
} from "../src/cloud-home-store.js";

const snapshot: CloudSkillCatalogSnapshot = {
  ownerGeneration: "generation-1",
  agentType: "orchestrator",
  loadedAt: 1,
  entries: [
    {
      skillId: "skill-pdf",
      slug: "pdf",
      name: "PDF",
      description: "Read and fill PDFs",
      source: "bundled",
      availability: "both",
      revision: 1,
      versionId: "version-7",
      manifestSha256: "1".repeat(64),
      treeSha256: "2".repeat(64),
      fileCount: 2,
      totalSizeBytes: 20,
      files: [
        { path: "SKILL.md", r2Key: "k1", sha256: "3".repeat(64), sizeBytes: 10, contentType: "text/markdown" },
        { path: "scripts/program.ts", r2Key: "k2", sha256: "4".repeat(64), sizeBytes: 10, contentType: "text/plain" },
      ],
      updatedAt: 1,
    },
  ],
};

const home = {
  readSkillText: async (_snapshot: unknown, skillId: string, path: string) => {
    if (skillId !== "skill-pdf") throw new Error("unknown skill");
    if (path === "SKILL.md") return "# PDF\nline two\nline three";
    if (path === "scripts/program.ts") return "export const run = () => 1;";
    throw new Error("That file is not in the pinned mirrored skill version.");
  },
} as unknown as CloudHomeStore;

describe("cloud skills block and Read", () => {
  test("renders the device <skills> block with ~/.stella/skills paths", () => {
    const block = buildCloudSkillsBlock(snapshot);
    expect(block).toContain("<skills>");
    expect(block).toContain(
      "- `pdf` — Read and fill PDFs (path: ~/.stella/skills/pdf/SKILL.md) Includes optional `scripts/program.ts`.",
    );
    expect(block).toContain("open its `SKILL.md` first with `Read`");
    expect(buildCloudSkillsBlock({ ...snapshot, entries: [] })).toBe("");
  });

  test("resolves display and absolute skill paths, rejects traversal", () => {
    expect(resolveCloudSkillPath(snapshot, "~/.stella/skills/pdf/SKILL.md").ref).toMatchObject({ path: "SKILL.md" });
    expect(resolveCloudSkillPath(snapshot, "/Users/me/.stella/skills/pdf/scripts/program.ts").ref).toMatchObject({ path: "scripts/program.ts" });
    expect(resolveCloudSkillPath(snapshot, "~/.stella/skills/pdf").ref).toMatchObject({ path: "SKILL.md" });
    expect(resolveCloudSkillPath(snapshot, "~/.stella/skills/pdf/../other/SKILL.md")).toEqual({ ref: null, skillsPath: true });
    expect(resolveCloudSkillPath(snapshot, "/workspace/world/drive/a.txt")).toEqual({ ref: null, skillsPath: false });
  });

  test("Read serves skill files with the device line window and world files through the world store", async () => {
    const worldCalls: unknown[] = [];
    const read = createCloudReadTool({
      skills: { home, snapshot },
      world: {
        tool: async (call) => {
          worldCalls.push(call);
          return { ok: true, output: "File: /workspace/world/drive/a.txt\n     1#hello" };
        },
      },
    });
    const skill = await read.execute("c1", { file_path: "~/.stella/skills/pdf/SKILL.md", offset: 2, limit: 1 });
    expect(skill.isError).not.toBe(true);
    const skillText = skill.content[0]!.type === "text" ? skill.content[0].text : "";
    expect(skillText).toContain("     2#line two");
    expect(skillText).toContain("continue with offset=3");
    expect(skillText).not.toContain("line three");
    expect(skill.details).toMatchObject({ skillId: "skill-pdf", versionId: "version-7" });

    const missing = await read.execute("c2", { file_path: "~/.stella/skills/nope/SKILL.md" });
    expect(missing.isError).toBe(true);
    expect(worldCalls).toHaveLength(0);

    const world = await read.execute("c3", { file_path: "/workspace/world/drive/a.txt", limit: 5 });
    expect(world.isError).not.toBe(true);
    expect(worldCalls[0]).toEqual({
      name: "Read",
      arguments: { file_path: "/workspace/world/drive/a.txt", limit: 5 },
    });

    const relative = await read.execute("c4", { file_path: "drive/a.txt" });
    expect(relative.isError).toBe(true);
    expect(relative.content[0]).toMatchObject({ text: expect.stringContaining("/workspace/world/") });
  });
});
