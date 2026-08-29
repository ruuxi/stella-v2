import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { App } from "electron";
import { afterEach, describe, expect, it } from "vitest";

import {
  ensureStellaDataDirSeeded,
  resolveStellaDataDir,
} from "@stella/runtime/kernel/home/stella-home";

const roots = new Set<string>();

const createTempDir = async (prefix: string) => {
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

describe("ensureStellaDataDirSeeded", () => {
  it("seeds one-shot entries and installs bundled skills into the canonical root", async () => {
    const stellaAppDir = await createTempDir("stella-seed-root-");
    const stellaDataDir = await createTempDir("stella-home-");
    const seedRoot = path.join(stellaAppDir, "packages", "home-seed");

    await mkdir(path.join(seedRoot, "skills", "stella-desktop"), {
      recursive: true,
    });
    await mkdir(path.join(seedRoot, "outputs"), { recursive: true });
    await mkdir(path.join(seedRoot, "memories"), { recursive: true });
    await writeFile(path.join(seedRoot, "DREAM.md"), "seed dream");
    await writeFile(
      path.join(seedRoot, "skills", "stella-desktop", "SKILL.md"),
      "desktop skill",
    );
    await writeFile(path.join(seedRoot, "outputs", "README.md"), "outputs");
    await writeFile(path.join(seedRoot, "preferences.json"), "{}");
    await writeFile(path.join(seedRoot, "memories", "MEMORY.md"), "old memory");

    const result = await ensureStellaDataDirSeeded(stellaAppDir, stellaDataDir);
    expect(result.synced).toBe(true);

    // Retained one-shot seeds land in user space.
    await expect(
      readFile(path.join(stellaDataDir, "outputs", "README.md"), "utf-8"),
    ).resolves.toBe("outputs");
    // Retired and non-seed entries do not.
    await expect(
      readFile(path.join(stellaDataDir, "DREAM.md"), "utf-8"),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(stellaDataDir, "preferences.json"), "utf-8"),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(stellaDataDir, "memories", "MEMORY.md"), "utf-8"),
    ).rejects.toThrow();

    // Bundled and user-created skills share the one canonical root.
    await expect(
      readFile(
        path.join(stellaDataDir, "skills", "stella-desktop", "SKILL.md"),
        "utf-8",
      ),
    ).resolves.toBe("desktop skill");
    await expect(
      readFile(path.join(stellaDataDir, "system", "skills"), "utf-8"),
    ).rejects.toThrow();
    // System prompts live in the app bundle; nothing materializes here.
    await expect(
      readFile(path.join(stellaDataDir, "agents"), "utf-8"),
    ).rejects.toThrow();

    // A second run with unchanged sources is an idempotent no-op.
    const again = await ensureStellaDataDirSeeded(stellaAppDir, stellaDataDir);
    expect(again.synced).toBe(false);
  });

  it("retires a legacy system mirror into the canonical root and the trash", async () => {
    const stellaAppDir = await createTempDir("stella-seed-root-");
    const stellaDataDir = await createTempDir("stella-home-");
    const seedRoot = path.join(stellaAppDir, "packages", "home-seed");

    await mkdir(path.join(seedRoot, "skills", "stella-desktop"), {
      recursive: true,
    });
    await writeFile(
      path.join(seedRoot, "skills", "stella-desktop", "SKILL.md"),
      "shipped desktop skill",
    );

    // The mirror held both a still-shipped skill and one the bundle retired.
    const legacySkills = path.join(stellaDataDir, "system", "skills");
    await mkdir(path.join(legacySkills, "stella-desktop"), { recursive: true });
    await writeFile(
      path.join(legacySkills, "stella-desktop", "SKILL.md"),
      "stale mirrored desktop skill",
    );
    await mkdir(path.join(legacySkills, "retired-skill"), { recursive: true });
    await writeFile(
      path.join(legacySkills, "retired-skill", "SKILL.md"),
      "retired skill",
    );

    await ensureStellaDataDirSeeded(stellaAppDir, stellaDataDir);

    await expect(
      readFile(
        path.join(stellaDataDir, "skills", "stella-desktop", "SKILL.md"),
        "utf-8",
      ),
    ).resolves.toBe("shipped desktop skill");
    await expect(
      readFile(
        path.join(stellaDataDir, "skills", "retired-skill", "SKILL.md"),
        "utf-8",
      ),
    ).resolves.toBe("retired skill");
    await expect(
      readdir(path.join(stellaDataDir, "system")),
    ).rejects.toThrow();
    const trashed = await readdir(path.join(stellaDataDir, ".trash"));
    expect(
      trashed.some((entry) => entry.startsWith("legacy-system-")),
    ).toBe(true);
  });
});

describe("resolveStellaDataDir", () => {
  it("keeps user projects in the writable data root during development", async () => {
    const stellaAppDir = await createTempDir("stella-app-root-");
    const statePath = await createTempDir("stella-state-root-");
    const app = { isPackaged: false } as unknown as App;

    const result = await resolveStellaDataDir(app, stellaAppDir, statePath);

    expect(result.workspacePath).toBe(path.join(statePath, "workspace"));
    expect(result.workspaceAppsPath).toBe(
      path.join(statePath, "workspace", "apps"),
    );
    expect(result.extensionsPath).toBe(
      path.join(stellaAppDir, "runtime", "extensions"),
    );
  });
});
