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
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildBundledSkillsSnapshot,
  readBundledSkillsState,
  syncBundledSkills,
} from "@stella/runtime/kernel/home/bundled-skills";

const roots = new Set<string>();
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../..",
);

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
  const seedSkillsDir = await tempDir("bundled-skills-seed-");
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

describe("buildBundledSkillsSnapshot", () => {
  it("includes seed skills gated by platform and excludes user-profile", async () => {
    const seedSkillsDir = await createSeed();
    const darwin = await buildBundledSkillsSnapshot({
      seedSkillsDir,
      platform: "darwin",
    });
    expect([...darwin.skills.keys()]).toEqual(["pdf"]);
    const win = await buildBundledSkillsSnapshot({
      seedSkillsDir,
      platform: "win32",
    });
    expect([...win.skills.keys()]).toEqual(["pdf", "stella-computer-windows"]);
    expect(darwin.key).not.toBe(win.key);
  });

  it("excludes removed defaults from the product seed", async () => {
    const snapshot = await buildBundledSkillsSnapshot({
      seedSkillsDir: path.join(REPO_ROOT, "packages", "home-seed", "skills"),
      platform: "darwin",
    });

    expect(snapshot.skills.has("crates-io-client")).toBe(false);
    expect(snapshot.skills.has("hackernews-client")).toBe(false);
  });
});

describe("syncBundledSkills", () => {
  it("materializes into the one skills root, no-ops, and updates an unmodified shipped skill", async () => {
    const seedSkillsDir = await createSeed();
    const home = await tempDir("bundled-skills-home-");

    const first = await buildBundledSkillsSnapshot({
      seedSkillsDir,
      platform: "darwin",
    });
    await expect(syncBundledSkills(home, first)).resolves.toEqual({
      applied: true,
    });
    await expect(
      readFile(path.join(home, "skills", "pdf", "SKILL.md"), "utf-8"),
    ).resolves.toBe("pdf skill");
    await expect(readdir(path.join(home, "system"))).rejects.toThrow();

    await expect(syncBundledSkills(home, first)).resolves.toEqual({
      applied: false,
    });

    await writeFile(
      path.join(seedSkillsDir, "pdf", "SKILL.md"),
      "pdf skill v2!",
    );
    const second = await buildBundledSkillsSnapshot({
      seedSkillsDir,
      platform: "darwin",
    });
    expect(second.key).not.toBe(first.key);
    await expect(syncBundledSkills(home, second)).resolves.toEqual({
      applied: true,
    });
    await expect(
      readFile(path.join(home, "skills", "pdf", "SKILL.md"), "utf-8"),
    ).resolves.toBe("pdf skill v2!");
    expect(await readBundledSkillsState(home)).toMatchObject({
      version: 1,
      seedKey: second.key,
      skills: { pdf: { lastSyncedHash: second.skills.get("pdf")?.hash } },
    });
  });

  it("preserves a same-id user skill and never adopts it on later updates", async () => {
    const seedSkillsDir = await createSeed();
    const home = await tempDir("bundled-skills-collision-");
    await mkdir(path.join(home, "skills", "pdf"), { recursive: true });
    await writeFile(
      path.join(home, "skills", "pdf", "SKILL.md"),
      "my custom pdf skill",
    );
    const first = await buildBundledSkillsSnapshot({
      seedSkillsDir,
      platform: "darwin",
    });
    await syncBundledSkills(home, first);
    await writeFile(path.join(seedSkillsDir, "pdf", "SKILL.md"), "pdf v2");
    const second = await buildBundledSkillsSnapshot({
      seedSkillsDir,
      platform: "darwin",
    });
    await syncBundledSkills(home, second);

    await expect(
      readFile(path.join(home, "skills", "pdf", "SKILL.md"), "utf-8"),
    ).resolves.toBe("my custom pdf skill");
    expect((await readBundledSkillsState(home))?.skills.pdf).toEqual({
      lastSyncedHash: null,
    });
  });

  it("preserves edits to a previously managed skill when a new seed arrives", async () => {
    const seedSkillsDir = await createSeed();
    const home = await tempDir("bundled-skills-edited-");
    const first = await buildBundledSkillsSnapshot({
      seedSkillsDir,
      platform: "darwin",
    });
    await syncBundledSkills(home, first);
    await writeFile(path.join(home, "skills", "pdf", "SKILL.md"), "my edits");
    await writeFile(path.join(seedSkillsDir, "pdf", "SKILL.md"), "pdf v2");
    const second = await buildBundledSkillsSnapshot({
      seedSkillsDir,
      platform: "darwin",
    });
    await syncBundledSkills(home, second);

    await expect(
      readFile(path.join(home, "skills", "pdf", "SKILL.md"), "utf-8"),
    ).resolves.toBe("my edits");
    expect((await readBundledSkillsState(home))?.skills.pdf).toEqual({
      lastSyncedHash: null,
    });
  });

  it("retires removed defaults while preserving a user-modified copy", async () => {
    const seedSkillsDir = await createSeed();
    const home = await tempDir("bundled-skills-retired-");
    for (const id of ["crates-io-client", "hackernews-client"]) {
      await mkdir(path.join(seedSkillsDir, id), { recursive: true });
      await writeFile(
        path.join(seedSkillsDir, id, "SKILL.md"),
        `${id} shipped`,
      );
    }
    const first = await buildBundledSkillsSnapshot({
      seedSkillsDir,
      platform: "darwin",
    });
    await syncBundledSkills(home, first);
    await writeFile(
      path.join(home, "skills", "hackernews-client", "SKILL.md"),
      "user-modified Hacker News skill",
    );
    await rm(path.join(seedSkillsDir, "crates-io-client"), { recursive: true });
    await rm(path.join(seedSkillsDir, "hackernews-client"), {
      recursive: true,
    });
    const second = await buildBundledSkillsSnapshot({
      seedSkillsDir,
      platform: "darwin",
    });

    await expect(syncBundledSkills(home, second)).resolves.toEqual({
      applied: true,
    });
    await expect(
      readdir(path.join(home, "skills", "crates-io-client")),
    ).rejects.toThrow();
    await expect(
      readFile(
        path.join(home, "skills", "hackernews-client", "SKILL.md"),
        "utf-8",
      ),
    ).resolves.toBe("user-modified Hacker News skill");
    const state = await readBundledSkillsState(home);
    expect(state?.skills).not.toHaveProperty("crates-io-client");
    expect(state?.skills).not.toHaveProperty("hackernews-client");
    expect(state?.skills).toHaveProperty("pdf");
    expect(await readdir(path.join(home, ".trash"))).toHaveLength(1);
  });

  it("migrates the legacy system skills tree once and archives it", async () => {
    const seedSkillsDir = await createSeed();
    const home = await tempDir("bundled-skills-legacy-");
    await mkdir(path.join(home, "system", "skills", "pdf"), {
      recursive: true,
    });
    await writeFile(
      path.join(home, "system", "skills", "pdf", "SKILL.md"),
      "old shipped pdf",
    );
    await mkdir(path.join(home, "system", "skills", "legacy-extra"), {
      recursive: true,
    });
    await writeFile(
      path.join(home, "system", "skills", "legacy-extra", "SKILL.md"),
      "preserve me",
    );
    const snapshot = await buildBundledSkillsSnapshot({
      seedSkillsDir,
      platform: "darwin",
    });

    await expect(syncBundledSkills(home, snapshot)).resolves.toEqual({
      applied: true,
    });
    await expect(
      readFile(path.join(home, "skills", "pdf", "SKILL.md"), "utf-8"),
    ).resolves.toBe("pdf skill");
    await expect(
      readFile(path.join(home, "skills", "legacy-extra", "SKILL.md"), "utf-8"),
    ).resolves.toBe("preserve me");
    await expect(readdir(path.join(home, "system"))).rejects.toThrow();
    const firstTrash = await readdir(path.join(home, ".trash"));
    expect(firstTrash).toHaveLength(1);

    await expect(syncBundledSkills(home, snapshot)).resolves.toEqual({
      applied: false,
    });
    expect(await readdir(path.join(home, ".trash"))).toEqual(firstTrash);
  });
});
