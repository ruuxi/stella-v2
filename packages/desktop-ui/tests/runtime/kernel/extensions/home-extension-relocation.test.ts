import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createExtensionRuntimeApi } from "@stella/runtime/kernel/extensions/runtime-api";
import { loadExtensions } from "@stella/runtime/kernel/extensions/loader";
import { ensureStellaDataDirSeeded } from "@stella/runtime/kernel/home/stella-home";
import { buildSkillCatalogPromptState } from "@stella/runtime/kernel/shared/skill-catalog";

const roots = new Set<string>();
const removedSkillIds = [
  "create-stella-app",
  "editorial-interface-redesign",
  "stella-design",
  "stella-desktop",
  "stella-dev-harness",
  "stella-ff",
  "stella-runtime-extension",
] as const;

const repoRoot = path.resolve(process.cwd(), "..", "..");

afterEach(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.clear();
});

describe("home extension relocation", () => {
  it("seeds and loads the Stella extension from a clean home", async () => {
    const home = await mkdtemp(
      path.join(os.tmpdir(), "stella-home-extension-"),
    );
    roots.add(home);

    const seeded = await ensureStellaDataDirSeeded(repoRoot, home);
    expect(seeded.extensionsSync.actions).toContainEqual(
      expect.objectContaining({ type: "seed", id: "stella-runtime" }),
    );

    const homeExtensionDir = path.join(home, "extensions", "stella-runtime");
    await expect(access(path.join(homeExtensionDir, "index.ts"))).resolves.toBe(
      undefined,
    );
    const store = {} as never;
    const loaded = await loadExtensions(path.join(home, "extensions"), {
      stellaDataDir: home,
      stellaAppDir: repoRoot,
      store,
      runtime: createExtensionRuntimeApi({
        stellaDataDir: home,
        stellaAppDir: repoRoot,
        store,
      }),
    });

    expect(loaded.agents.map((agent) => agent.id)).toContain("manager");
    expect(loaded.hooks.map((hook) => hook.event)).toEqual(
      expect.arrayContaining(["before_user_message", "agent_end"]),
    );
    expect(loaded.hooks).toHaveLength(9);
  });

  it("ships a pruned cold-start skill catalog without self-mod payload", async () => {
    const shippedSkillsDir = path.join(
      repoRoot,
      "packages",
      "home-seed",
      "skills",
    );
    const shippedSkillIds = await readdir(shippedSkillsDir);
    for (const removedId of removedSkillIds) {
      expect(shippedSkillIds).not.toContain(removedId);
    }
    expect(shippedSkillIds).toEqual(
      expect.arrayContaining([
        "apple-notes",
        "apple-reminders",
        "skill-creator",
        "stella-browser",
        "stella-connect-mcp",
        "stella-llm",
        "stella-media",
        "stella-office",
        "x-api",
        "youtube-content",
      ]),
    );

    const home = await mkdtemp(path.join(os.tmpdir(), "stella-pruned-seed-"));
    roots.add(home);
    await ensureStellaDataDirSeeded(repoRoot, home);
    const catalog = await buildSkillCatalogPromptState(home);
    const catalogIds = catalog.entries.map((entry) => entry.id);
    for (const removedId of removedSkillIds) {
      expect(catalogIds).not.toContain(removedId);
    }
    expect(catalogIds).toEqual(
      expect.arrayContaining(["skill-creator", "stella-llm", "stella-media"]),
    );

    const shippedSeedDir = path.join(repoRoot, "packages", "home-seed");
    const shippedTextPaths = (
      await readdir(shippedSeedDir, { recursive: true })
    ).filter((entry) => /\.(?:md|ts|json)$/i.test(entry));
    const shippedText = (
      await Promise.all(
        shippedTextPaths.map((entry) =>
          readFile(path.join(shippedSeedDir, entry), "utf-8"),
        ),
      )
    ).join("\n");
    expect(shippedText).not.toMatch(
      /Apply Stella update|self-improvement|stella-ff|stella-desktop|stella-dev-harness|stella-runtime-extension|create-stella-app|editorial-interface-redesign/i,
    );
    await expect(
      access(path.join(home, "agents", "install_update.md")),
    ).rejects.toThrow();
  });

  it("preserves an untracked pre-existing home extension", async () => {
    const home = await mkdtemp(
      path.join(os.tmpdir(), "stella-custom-extension-"),
    );
    roots.add(home);
    const extensionDir = path.join(home, "extensions", "stella-runtime");
    await mkdir(extensionDir, { recursive: true });
    const customSource = "export default () => 'custom home extension';\n";
    await writeFile(path.join(extensionDir, "index.ts"), customSource);

    const seeded = await ensureStellaDataDirSeeded(repoRoot, home);

    expect(seeded.extensionsSync.actions).toContainEqual({
      type: "skip-user-modified",
      id: "stella-runtime",
      reason: "no-manifest",
    });
    await expect(
      readFile(path.join(extensionDir, "index.ts"), "utf-8"),
    ).resolves.toBe(customSource);
  });
});
