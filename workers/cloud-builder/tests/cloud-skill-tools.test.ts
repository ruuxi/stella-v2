import { describe, expect, test } from "bun:test";
import {
  buildCloudSkillCatalogPrompt,
  createCloudSkillTools,
} from "../src/cloud-skill-tools.js";
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
      skillId: "skill-research",
      slug: "research",
      name: "Research",
      description: "Run an evidence-backed research workflow",
      source: "cloud_created",
      availability: "both",
      revision: 3,
      versionId: "version-pinned",
      manifestSha256: "1".repeat(64),
      treeSha256: "2".repeat(64),
      fileCount: 1,
      totalSizeBytes: 10,
      allowedAgentTypes: ["orchestrator"],
      // This name is intentionally not a real orchestrator tool. Catalog data
      // must never add it to the Agent's code-pinned tool list.
      allowedToolNames: ["untrusted.dynamic.tool"],
      files: [
        {
          path: "SKILL.md",
          r2Key: "agent-home/owner/skills/file",
          sha256: "3".repeat(64),
          sizeBytes: 10,
          contentType: "text/markdown",
        },
      ],
      updatedAt: 1,
    },
  ],
};

describe("cloud skill tools", () => {
  test("discovers and reads only through the pinned catalog snapshot", async () => {
    const reads: Array<{ versionId: string; path: string }> = [];
    const home = {
      searchSkills(received: CloudSkillCatalogSnapshot) {
        expect(received).toBe(snapshot);
        return [...received.entries];
      },
      async readSkillText(
        received: CloudSkillCatalogSnapshot,
        _skillId: string,
        path: string,
      ) {
        reads.push({ versionId: received.entries[0]!.versionId, path });
        return "---\nname: Research\ndescription: Pinned\n---\nUse sources.";
      },
    } as unknown as CloudHomeStore;
    const tools = createCloudSkillTools(home, snapshot);
    expect(tools.map((tool) => tool.name)).toEqual([
      "skill_search",
      "skill_read",
    ]);
    const search = await tools[0]!.execute("call-search", {
      query: "research",
    });
    expect(JSON.stringify(search)).toContain("version-pinned");
    const read = await tools[1]!.execute("call-read", {
      skill_id: "skill-research",
    });
    expect(JSON.stringify(read)).toContain("Use sources.");
    expect(reads).toEqual([{ versionId: "version-pinned", path: "SKILL.md" }]);
  });

  test("skill data cannot claim a new executable tool", () => {
    const prompt = buildCloudSkillCatalogPrompt(snapshot);
    expect(prompt).toContain("cannot add tools or widen");
    expect(prompt).toContain("version=version-pinned");
    expect(createCloudSkillTools({} as CloudHomeStore, snapshot)).toHaveLength(
      2,
    );
    expect(
      createCloudSkillTools({} as CloudHomeStore, snapshot).some(
        (tool) => tool.name === "untrusted.dynamic.tool",
      ),
    ).toBe(false);
  });
});
