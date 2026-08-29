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

import { runHomeEffect } from "@stella/runtime/kernel/home/effect-run";
import {
  reconcileBundledSkillsEffect,
  type SkillsSyncReport,
} from "@stella/runtime/kernel/home/skills-sync";

const roots = new Set<string>();
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../..",
);
const SEED_SKILLS_DIR = path.join(REPO_ROOT, "packages", "home-seed", "skills");
const MANIFEST_FILE = ".bundled-manifest.json";

type BundledManifest = {
  entries: Record<string, { customized: boolean }>;
};

const tempDir = async (prefix: string) => {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.add(root);
  return root;
};

const reconcile = (
  bundledSkillsDir: string,
  homeSkillsDir: string,
): Promise<SkillsSyncReport> =>
  runHomeEffect(
    reconcileBundledSkillsEffect(bundledSkillsDir, homeSkillsDir, {
      platform: "darwin",
    }),
  );

const readManifest = async (
  homeSkillsDir: string,
): Promise<BundledManifest | null> => {
  try {
    return JSON.parse(
      await readFile(path.join(homeSkillsDir, MANIFEST_FILE), "utf-8"),
    ) as BundledManifest;
  } catch {
    return null;
  }
};

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe("bundled skills seed", () => {
  it("excludes removed defaults from the product seed", async () => {
    const seeded = await readdir(SEED_SKILLS_DIR);

    expect(seeded).not.toContain("crates-io-client");
    expect(seeded).not.toContain("hackernews-client");
  });
});

describe("reconcileBundledSkills", () => {
  it("leaves a pre-existing collision user-owned and never overwrites it", async () => {
    const seedSkillsDir = await tempDir("bundled-skills-seed-");
    const homeSkillsDir = path.join(
      await tempDir("bundled-skills-home-"),
      "skills",
    );
    await mkdir(path.join(seedSkillsDir, "pdf"), { recursive: true });
    await writeFile(path.join(seedSkillsDir, "pdf", "SKILL.md"), "pdf shipped");
    // Shipped and user-created skills share one root, so the user can already
    // own the id the bundle wants to seed.
    await mkdir(path.join(homeSkillsDir, "pdf"), { recursive: true });
    await writeFile(
      path.join(homeSkillsDir, "pdf", "SKILL.md"),
      "my own pdf skill",
    );

    const report = await reconcile(seedSkillsDir, homeSkillsDir);

    expect(report.actions).toContainEqual({
      type: "skip-user-modified",
      id: "pdf",
      reason: "no-manifest",
    });
    await expect(
      readFile(path.join(homeSkillsDir, "pdf", "SKILL.md"), "utf-8"),
    ).resolves.toBe("my own pdf skill");

    const manifest = await readManifest(homeSkillsDir);
    expect(manifest?.entries["pdf"]?.customized).toBe(true);

    // A later shipped change still must not reclaim the id.
    await writeFile(
      path.join(seedSkillsDir, "pdf", "SKILL.md"),
      "pdf shipped v2",
    );
    await reconcile(seedSkillsDir, homeSkillsDir);
    await expect(
      readFile(path.join(homeSkillsDir, "pdf", "SKILL.md"), "utf-8"),
    ).resolves.toBe("my own pdf skill");
  });

  it("retires removed defaults while preserving a user-modified copy", async () => {
    const seedSkillsDir = await tempDir("bundled-skills-seed-");
    const homeSkillsDir = path.join(
      await tempDir("bundled-skills-home-"),
      "skills",
    );
    for (const id of ["pdf", "crates-io-client", "hackernews-client"]) {
      await mkdir(path.join(seedSkillsDir, id), { recursive: true });
      await writeFile(
        path.join(seedSkillsDir, id, "SKILL.md"),
        `${id} shipped`,
      );
    }

    await reconcile(seedSkillsDir, homeSkillsDir);

    // Only the Hacker News copy diverges, so only it is user-owned once the
    // seed stops shipping either skill.
    await writeFile(
      path.join(homeSkillsDir, "hackernews-client", "SKILL.md"),
      "user-modified Hacker News skill",
    );
    await rm(path.join(seedSkillsDir, "crates-io-client"), { recursive: true });
    await rm(path.join(seedSkillsDir, "hackernews-client"), {
      recursive: true,
    });

    const report = await reconcile(seedSkillsDir, homeSkillsDir);

    expect(report.actions).toContainEqual({
      type: "remove-obsolete",
      id: "crates-io-client",
    });
    expect(report.actions).toContainEqual({
      type: "skip-obsolete-user-modified",
      id: "hackernews-client",
    });
    await expect(
      readdir(path.join(homeSkillsDir, "crates-io-client")),
    ).rejects.toThrow();
    await expect(
      readFile(
        path.join(homeSkillsDir, "hackernews-client", "SKILL.md"),
        "utf-8",
      ),
    ).resolves.toBe("user-modified Hacker News skill");

    const manifest = await readManifest(homeSkillsDir);
    expect(manifest?.entries).not.toHaveProperty("crates-io-client");
    expect(manifest?.entries).toHaveProperty("hackernews-client");
    expect(manifest?.entries["hackernews-client"]?.customized).toBe(true);
    expect(manifest?.entries).toHaveProperty("pdf");
  });
});
