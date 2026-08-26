import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resetStellaCustomizations } from "@stella/runtime/kernel/home/reset-customizations";

const roots = new Set<string>();

const tempDir = async (prefix: string) => {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.add(root);
  return root;
};

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe("resetStellaCustomizations", () => {
  it("moves overlays, replacements, prompt overrides, personality, and skill forks to .trash", async () => {
    const home = await tempDir("reset-customizations-");
    await mkdir(path.join(home, "agents"), { recursive: true });
    await writeFile(path.join(home, "agents", "general.md"), "overlay");
    await writeFile(
      path.join(home, "agents", "orchestrator.replace.md"),
      "replacement",
    );
    await mkdir(path.join(home, "prompts"), { recursive: true });
    await writeFile(
      path.join(home, "prompts", "memory-review.md"),
      "override",
    );
    await writeFile(path.join(home, "PERSONALITY.md"), "custom personality");
    await mkdir(path.join(home, "skills", "pdf"), { recursive: true });
    await writeFile(path.join(home, "skills", "pdf", "SKILL.md"), "fork");
    await mkdir(path.join(home, "skills", "my-skill"), { recursive: true });
    await writeFile(path.join(home, "skills", "my-skill", "SKILL.md"), "mine");
    await mkdir(path.join(home, "cache"), { recursive: true });
    await writeFile(
      path.join(home, "cache", "bundled-skills.json"),
      JSON.stringify({
        version: 1,
        seedKey: "test-seed",
        skills: { pdf: { lastSyncedHash: null } },
      }),
    );

    const result = await resetStellaCustomizations(home);

    expect(result.movedEntries.sort()).toEqual(
      [
        "PERSONALITY.md",
        path.join("agents", "general.md"),
        path.join("agents", "orchestrator.replace.md"),
        path.join("prompts", "memory-review.md"),
        path.join("skills", "pdf"),
      ].sort(),
    );
    expect(result.trashDir).toBeTruthy();

    // Cleared from the live locations…
    await expect(
      readFile(path.join(home, "agents", "general.md"), "utf-8"),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(home, "skills", "pdf", "SKILL.md"), "utf-8"),
    ).rejects.toThrow();
    // …but preserved in the trash for undo.
    await expect(
      readFile(path.join(result.trashDir!, "agents", "general.md"), "utf-8"),
    ).resolves.toBe("overlay");
    await expect(
      readFile(
        path.join(result.trashDir!, "skills", "pdf", "SKILL.md"),
        "utf-8",
      ),
    ).resolves.toBe("fork");

    // Purely user-created skills are not customizations of shipped content.
    await expect(
      readFile(path.join(home, "skills", "my-skill", "SKILL.md"), "utf-8"),
    ).resolves.toBe("mine");
  });

  it("reports an empty reset without creating a trash dir", async () => {
    const home = await tempDir("reset-customizations-");
    const result = await resetStellaCustomizations(home);
    expect(result).toEqual({ movedEntries: [], trashDir: null });
    await expect(readdir(path.join(home, ".trash"))).rejects.toThrow();
  });
});
