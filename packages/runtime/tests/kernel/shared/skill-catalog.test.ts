import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  listSkillCatalogEntries,
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
    await writeSkill(
      stellaAppDir,
      "create-stella-cloud-app",
      "Create cloud apps.",
    );
    await writeSkill(stellaAppDir, "stella-browser", "Control browser tabs.");
    await writeSkill(stellaAppDir, "pdf", "Work with PDFs.");

    const entries = await listSkillCatalogEntries(stellaAppDir, {
      omitSkillIds: ["stella-browser", "pdf"],
    });
    const block = await renderSkillCatalogBlock(stellaAppDir, {
      omitSkillIds: ["stella-browser", "pdf"],
    });

    expect(entries.map((entry) => entry.id)).toEqual([
      "create-stella-cloud-app",
    ]);
    expect(block).toContain("`create-stella-cloud-app`");
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
    // Reconciliation staging dirs share the root and are never skills.
    await mkdir(path.join(stellaAppDir, "skills", ".pdf.staging-1"), {
      recursive: true,
    });

    const entries = await listSkillCatalogEntries(stellaAppDir);
    expect(entries.map((entry) => entry.id)).toEqual(["stella-media"]);
    expect(entries[0]?.path).toBe(
      "~/.stella/skills/stella-media/SKILL.md",
    );
  });
});
