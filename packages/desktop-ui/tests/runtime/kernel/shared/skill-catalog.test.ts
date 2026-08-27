import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  INLINE_SKILL_CATALOG_THRESHOLD,
  buildSkillCatalogPromptState,
  renderFullSkillCatalogBlock,
  renderSkillCatalogBlock,
} from "@stella/runtime/kernel/shared/skill-catalog";

const roots = new Set<string>();

const createStellaAppDir = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-skill-catalog-"));
  roots.add(root);
  return root;
};

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

const writeSkill = async (
  stellaAppDir: string,
  skillId: string,
  description: string,
) => {
  const skillDir = path.join(stellaAppDir, "skills", skillId);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      `name: ${skillId}`,
      `description: ${description}`,
      "---",
      "",
      `# ${skillId}`,
    ].join("\n"),
    "utf-8",
  );
};

describe("skill catalog", () => {
  it("omits configured skill ids from the prompt block", async () => {
    const stellaAppDir = await createStellaAppDir();
    await writeSkill(stellaAppDir, "create-stella-app", "Create Stella apps.");
    await writeSkill(stellaAppDir, "stella-browser", "Control browser tabs.");
    await writeSkill(stellaAppDir, "pdf", "Work with PDFs.");

    const state = await buildSkillCatalogPromptState(stellaAppDir, {
      omitSkillIds: ["stella-browser", "pdf"],
    });
    const block = await renderSkillCatalogBlock(stellaAppDir, {
      omitSkillIds: ["stella-browser", "pdf"],
    });

    expect(state.totalSkills).toBe(1);
    expect(state.entries.map((entry) => entry.id)).toEqual([
      "create-stella-app",
    ]);
    expect(block).toContain("`create-stella-app`");
    expect(block).not.toContain("stella-browser");
    expect(block).not.toContain("pdf");
  });

  it("discovers only the canonical skills root", async () => {
    const stellaAppDir = await createStellaAppDir();
    await writeSkill(stellaAppDir, "stella-media", "Generate media.");
    const legacyDir = path.join(
      stellaAppDir,
      "system",
      "skills",
      "legacy-only",
    );
    await mkdir(legacyDir, { recursive: true });
    await writeFile(path.join(legacyDir, "SKILL.md"), "legacy");

    const state = await buildSkillCatalogPromptState(stellaAppDir);
    expect(state.entries.map((entry) => entry.id)).toEqual(["stella-media"]);
    expect(state.entries[0]?.path).toBe(
      "~/.stella/skills/stella-media/SKILL.md",
    );
  });

  it("renders every skill inline above the threshold for Explore", async () => {
    const stellaAppDir = await createStellaAppDir();
    const count = INLINE_SKILL_CATALOG_THRESHOLD + 5;
    for (let i = 0; i < count; i += 1) {
      await writeSkill(
        stellaAppDir,
        `skill-${String(i).padStart(3, "0")}`,
        `Does thing ${i}.`,
      );
    }

    const placeholder = await renderSkillCatalogBlock(stellaAppDir);
    expect(placeholder).toContain("over the inline limit");

    const full = await renderFullSkillCatalogBlock(stellaAppDir);
    expect(full).not.toContain("over the inline limit");
    expect(full).toContain("`skill-000`");
    expect(full).toContain(`\`skill-${String(count - 1).padStart(3, "0")}\``);
    const entryLines = full
      .split("\n")
      .filter((line) => line.startsWith("- `skill-"));
    expect(entryLines).toHaveLength(count);
  });
});
