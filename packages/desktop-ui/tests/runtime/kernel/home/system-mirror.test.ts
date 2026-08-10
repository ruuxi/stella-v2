import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RemotePromptManifest } from "@stella/runtime/kernel/home/prompt-manifest-sync";
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

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const manifestFor = (
  entries: Record<string, string>,
  publishedAt = 1,
): RemotePromptManifest => {
  const prompts = Object.entries(entries).map(([id, content]) => ({
    id,
    content,
    sha256: hash(content),
  }));
  const revision = hash(
    [...prompts]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((prompt) => `${prompt.id}:${prompt.sha256}`)
      .join("\n"),
  );
  return { schemaVersion: 2, revision, publishedAt, prompts };
};

const frontmatter = (name: string) =>
  `---\nname: ${name}\ndescription: ${name} agent\ntools: Read\nmaxAgentDepth: 1\n---\n`;

const createFixtures = async () => {
  const metadataDir = await tempDir("system-mirror-metadata-");
  await writeFile(
    path.join(metadataDir, "general.md"),
    `${frontmatter("General")}\n<!--\nCapability metadata only.\n-->\n`,
  );
  await writeFile(
    path.join(metadataDir, "orchestrator.md"),
    `${frontmatter("Orchestrator")}\nBundled orchestrator body.\n`,
  );
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
  return { metadataDir, seedSkillsDir };
};

describe("buildSystemSnapshot", () => {
  it("joins bundled frontmatter with published agent bodies and skips unknown ids", async () => {
    const { metadataDir, seedSkillsDir } = await createFixtures();
    const manifest = manifestFor({
      "agents/general.md": "published general body\n",
      "prompts/dream-scheduled.md": "published dream prompt\n",
      "agents/unknown_future_agent.md": "from a newer backend\n",
    });
    const snapshot = await buildSystemSnapshot({
      manifest,
      agentMetadataDir: metadataDir,
      seedSkillsDir,
      platform: "darwin",
    });

    expect(snapshot.files.get("agents/general.md")).toBe(
      `${frontmatter("General")}published general body\n`,
    );
    expect(snapshot.files.get("prompts/dream-scheduled.md")).toBe(
      "published dream prompt\n",
    );
    expect(snapshot.files.has("agents/unknown_future_agent.md")).toBe(false);
    expect(snapshot.revision).toBe(manifest.revision);
  });

  it("falls back to full bundled agent definitions offline and gates skills by platform", async () => {
    const { metadataDir, seedSkillsDir } = await createFixtures();
    const snapshot = await buildSystemSnapshot({
      manifest: null,
      agentMetadataDir: metadataDir,
      seedSkillsDir,
      platform: "darwin",
    });

    // Capability-only metadata (general) is skipped; real bodies mirror.
    expect(snapshot.files.has("agents/general.md")).toBe(false);
    expect(snapshot.files.get("agents/orchestrator.md")).toContain(
      "Bundled orchestrator body.",
    );
    expect(snapshot.revision).toBe("offline");
    expect([...snapshot.skillDirs.keys()]).toEqual(["pdf"]);
  });
});

describe("mirrorSystemDir", () => {
  it("mirrors, no-ops on the same key, and replaces obsolete content on a new key", async () => {
    const { metadataDir, seedSkillsDir } = await createFixtures();
    const home = await tempDir("system-mirror-home-");

    const first = await buildSystemSnapshot({
      manifest: manifestFor(
        {
          "agents/general.md": "body one\n",
          "prompts/memory-review.md": "review one\n",
        },
        1,
      ),
      agentMetadataDir: metadataDir,
      seedSkillsDir,
      platform: "darwin",
    });
    await expect(mirrorSystemDir(home, first)).resolves.toEqual({
      applied: true,
    });
    await expect(
      readFile(path.join(home, "system", "agents", "general.md"), "utf-8"),
    ).resolves.toContain("body one");
    await expect(
      readFile(path.join(home, "system", "skills", "pdf", "SKILL.md"), "utf-8"),
    ).resolves.toBe("pdf skill");

    await expect(mirrorSystemDir(home, first)).resolves.toEqual({
      applied: false,
    });

    const second = await buildSystemSnapshot({
      manifest: manifestFor({ "agents/general.md": "body two\n" }, 2),
      agentMetadataDir: metadataDir,
      seedSkillsDir,
      platform: "darwin",
    });
    await expect(mirrorSystemDir(home, second)).resolves.toEqual({
      applied: true,
    });
    await expect(
      readFile(path.join(home, "system", "agents", "general.md"), "utf-8"),
    ).resolves.toContain("body two");
    // memory-review.md was dropped from the snapshot: a mirror removes it.
    await expect(
      readFile(
        path.join(home, "system", "prompts", "memory-review.md"),
        "utf-8",
      ),
    ).rejects.toThrow();

    const revision = await readSystemRevision(home);
    expect(revision?.publishedAt).toBe(2);
  });

  it("restores an interrupted swap from the moved-aside backup", async () => {
    const { metadataDir, seedSkillsDir } = await createFixtures();
    const home = await tempDir("system-mirror-home-");
    const snapshot = await buildSystemSnapshot({
      manifest: manifestFor({ "agents/general.md": "body\n" }),
      agentMetadataDir: metadataDir,
      seedSkillsDir,
      platform: "darwin",
    });
    await mirrorSystemDir(home, snapshot);

    // Simulate a crash between the two swap renames.
    await rename(
      systemDirPath(home),
      path.join(home, ".system.old-crashed"),
    );
    await mkdir(path.join(home, ".system.next-crashed"), { recursive: true });

    await cleanupAbandonedSystemDirs(home);
    await expect(
      readFile(path.join(home, "system", "agents", "general.md"), "utf-8"),
    ).resolves.toContain("body");
    const leftovers = (await readdir(home)).filter((name) =>
      name.startsWith(".system."),
    );
    expect(leftovers).toEqual([]);
  });
});
