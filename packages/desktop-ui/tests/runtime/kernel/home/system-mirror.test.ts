import { mkdir, mkdtemp, readFile, readdir, rm, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildSystemSnapshot,
  cleanupAbandonedSystemDirs,
  mirrorSystemDir,
  readSystemRevision,
  systemDirPath,
} from "@stella/runtime/kernel/home/system-mirror";

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

const createSeed = async () => {
  const seedSkillsDir = await tempDir("system-mirror-skills-");
  await mkdir(path.join(seedSkillsDir, "pdf"), { recursive: true });
  await writeFile(path.join(seedSkillsDir, "pdf", "SKILL.md"), "pdf skill");
  await mkdir(path.join(seedSkillsDir, "user-profile"), { recursive: true });
  await writeFile(
    path.join(seedSkillsDir, "user-profile", "SKILL.md"),
    "user profile",
  );
  await mkdir(path.join(seedSkillsDir, "stella-computer-windows"), {
    recursive: true,
  });
  await writeFile(
    path.join(seedSkillsDir, "stella-computer-windows", "SKILL.md"),
    "windows only",
  );
  return seedSkillsDir;
};

describe("buildSystemSnapshot", () => {
  it("includes seed skills gated by platform and excludes user-profile", async () => {
    const seedSkillsDir = await createSeed();
    const darwin = await buildSystemSnapshot({
      seedSkillsDir,
      platform: "darwin",
    });
    expect([...darwin.skillDirs.keys()]).toEqual(["pdf"]);
    const win = await buildSystemSnapshot({
      seedSkillsDir,
      platform: "win32",
    });
    expect([...win.skillDirs.keys()]).toEqual([
      "pdf",
      "stella-computer-windows",
    ]);
    expect(darwin.key).not.toBe(win.key);
  });
});

describe("mirrorSystemDir", () => {
  it("mirrors, no-ops on the same key, and refreshes when the seed changes", async () => {
    const seedSkillsDir = await createSeed();
    const home = await tempDir("system-mirror-home-");

    const first = await buildSystemSnapshot({
      seedSkillsDir,
      platform: "darwin",
    });
    await expect(mirrorSystemDir(home, first)).resolves.toEqual({
      applied: true,
    });
    await expect(
      readFile(path.join(home, "system", "skills", "pdf", "SKILL.md"), "utf-8"),
    ).resolves.toBe("pdf skill");

    await expect(mirrorSystemDir(home, first)).resolves.toEqual({
      applied: false,
    });

    // Seed content changes (app update) → new fingerprint → re-mirror.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(
      path.join(seedSkillsDir, "pdf", "SKILL.md"),
      "pdf skill v2!",
    );
    const second = await buildSystemSnapshot({
      seedSkillsDir,
      platform: "darwin",
    });
    expect(second.key).not.toBe(first.key);
    await expect(mirrorSystemDir(home, second)).resolves.toEqual({
      applied: true,
    });
    await expect(
      readFile(path.join(home, "system", "skills", "pdf", "SKILL.md"), "utf-8"),
    ).resolves.toBe("pdf skill v2!");
    expect(await readSystemRevision(home)).toMatchObject({
      version: 1,
      key: second.key,
    });
  });

  it("restores an interrupted swap from the moved-aside backup", async () => {
    const seedSkillsDir = await createSeed();
    const home = await tempDir("system-mirror-home-");
    const snapshot = await buildSystemSnapshot({
      seedSkillsDir,
      platform: "darwin",
    });
    await mirrorSystemDir(home, snapshot);

    // Simulate a crash between the two swap renames.
    await rename(systemDirPath(home), path.join(home, ".system.old-crashed"));
    await mkdir(path.join(home, ".system.next-crashed"), { recursive: true });

    await cleanupAbandonedSystemDirs(home);
    await expect(
      readFile(path.join(home, "system", "skills", "pdf", "SKILL.md"), "utf-8"),
    ).resolves.toBe("pdf skill");
    const leftovers = (await readdir(home)).filter((name) =>
      name.startsWith(".system."),
    );
    expect(leftovers).toEqual([]);
  });
});
