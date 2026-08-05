import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  it("seeds only bundled defaults into Stella home", async () => {
    const stellaAppDir = await createTempDir("stella-seed-root-");
    const stellaDataDir = await createTempDir("stella-home-");
    const seedRoot = path.join(stellaAppDir, "packages", "home-seed");

    await mkdir(path.join(seedRoot, "skills", "stella-desktop"), {
      recursive: true,
    });
    await mkdir(path.join(seedRoot, "outputs"), { recursive: true });
    await mkdir(path.join(seedRoot, "memories"), { recursive: true });
    await mkdir(
      path.join(
        stellaAppDir,
        "packages/runtime/extensions/stella-runtime/agent-metadata",
      ),
      { recursive: true },
    );
    await writeFile(path.join(seedRoot, "DREAM.md"), "seed dream");
    await writeFile(
      path.join(seedRoot, "skills", "stella-desktop", "SKILL.md"),
      "desktop skill",
    );
    await writeFile(path.join(seedRoot, "outputs", "README.md"), "outputs");
    await writeFile(path.join(seedRoot, "preferences.json"), "{}");
    await writeFile(path.join(seedRoot, "memories", "MEMORY.md"), "old memory");
    await writeFile(
      path.join(
        stellaAppDir,
        "packages/runtime/extensions/stella-runtime/agent-metadata/manager.md",
      ),
      "---\nname: Manager\ndescription: manager\ntools: spawn_agent, send_input, pause_agent\nmaxAgentDepth: 2\n---\n\nbundled manager\n",
    );

    const result = await ensureStellaDataDirSeeded(stellaAppDir, stellaDataDir);

    expect(result.promptResolution).toBe("unavailable");
    await expect(
      readFile(path.join(stellaDataDir, "agents", "manager.md"), "utf-8"),
    ).resolves.toContain("bundled manager");

    await expect(
      readFile(path.join(stellaDataDir, "registry.md"), "utf-8"),
    ).rejects.toThrow();
    await expect(
      readFile(
        path.join(stellaDataDir, "skills", "stella-desktop", "SKILL.md"),
        "utf-8",
      ),
    ).resolves.toBe("desktop skill");
    await expect(
      readFile(path.join(stellaDataDir, "preferences.json"), "utf-8"),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(stellaDataDir, "memories", "MEMORY.md"), "utf-8"),
    ).rejects.toThrow();
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
