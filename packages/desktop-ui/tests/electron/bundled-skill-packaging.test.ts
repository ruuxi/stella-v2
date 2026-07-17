import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  stageHomeSeed,
  verifyPackagedHomeSeed,
} from "../../../desktop/scripts/stage-home-seed.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const roots = new Set<string>();

const EXPECTED_BY_PLATFORM = {
  darwin: [
    "apple-notes",
    "apple-reminders",
    "humanizer",
    "pdf",
    "skill-creator",
    "stella-browser",
    "stella-computer-macos",
    "stella-connect-mcp",
    "stella-design",
    "stella-media",
    "stella-office",
    "x-api",
    "youtube-content",
  ],
  linux: [
    "humanizer",
    "pdf",
    "skill-creator",
    "stella-browser",
    "stella-connect-mcp",
    "stella-design",
    "stella-media",
    "stella-office",
    "x-api",
    "youtube-content",
  ],
  win32: [
    "humanizer",
    "pdf",
    "skill-creator",
    "stella-browser",
    "stella-computer-windows",
    "stella-connect-mcp",
    "stella-design",
    "stella-media",
    "stella-office",
    "x-api",
    "youtube-content",
  ],
} as const;

const tempDir = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-skill-package-"));
  roots.add(root);
  return root;
};

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe("bundled skill packaging boundary", () => {
  it.each(Object.entries(EXPECTED_BY_PLATFORM))(
    "stages and verifies the exact %s payload",
    async (platform, expectedIds) => {
      const resourcesRoot = await tempDir();
      const targetRoot = path.join(resourcesRoot, "home-seed");

      const staged = await stageHomeSeed({ platform, targetRoot });
      const verified = await verifyPackagedHomeSeed({
        platform,
        resourcesRoot,
      });

      expect(staged.packagedIds).toEqual(expectedIds);
      expect(verified.actualIds).toEqual(expectedIds);
      expect(staged.fileCount).toBe(verified.fileCount);
      expect(staged.payloadHash).toBe(verified.payloadHash);
      expect(verified.fileCount).toBeGreaterThan(expectedIds.length);
      expect(verified.payloadHash).toMatch(/^[0-9a-f]{64}$/u);
    },
  );

  it("rejects retired additions and retained-skill omissions in emitted resources", async () => {
    const resourcesRoot = await tempDir();
    const targetRoot = path.join(resourcesRoot, "home-seed");
    await stageHomeSeed({ platform: "darwin", targetRoot });

    await mkdir(path.join(targetRoot, "skills", "stella-desktop"));
    await expect(
      verifyPackagedHomeSeed({ platform: "darwin", resourcesRoot }),
    ).rejects.toThrow("Packaged darwin skill payload mismatch");

    await rm(path.join(targetRoot, "skills", "stella-desktop"), {
      recursive: true,
      force: true,
    });
    await rm(path.join(targetRoot, "skills", "pdf"), {
      recursive: true,
      force: true,
    });
    await expect(
      verifyPackagedHomeSeed({ platform: "darwin", resourcesRoot }),
    ).rejects.toThrow("Packaged darwin skill payload mismatch");
  });

  it("rejects a missing nested retained-skill file", async () => {
    const resourcesRoot = await tempDir();
    const targetRoot = path.join(resourcesRoot, "home-seed");
    await stageHomeSeed({ platform: "darwin", targetRoot });

    await rm(
      path.join(
        targetRoot,
        "skills",
        "skill-creator",
        "scripts",
        "quick_validate.py",
      ),
    );

    await expect(
      verifyPackagedHomeSeed({ platform: "darwin", resourcesRoot }),
    ).rejects.toThrow("Packaged darwin file list mismatch");
  });

  it("rejects altered nested retained-skill bytes", async () => {
    const resourcesRoot = await tempDir();
    const targetRoot = path.join(resourcesRoot, "home-seed");
    await stageHomeSeed({ platform: "darwin", targetRoot });
    const nestedFile = path.join(
      targetRoot,
      "skills",
      "skill-creator",
      "scripts",
      "quick_validate.py",
    );

    await writeFile(nestedFile, "tampered packaged bytes\n", "utf-8");

    await expect(
      verifyPackagedHomeSeed({ platform: "darwin", resourcesRoot }),
    ).rejects.toThrow(
      "Packaged darwin file hash mismatch at skills/skill-creator/scripts/quick_validate.py",
    );
  });

  it("pins Electron Builder to the validated staging boundary", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(REPO_ROOT, "package.json"), "utf-8"),
    ) as {
      build: {
        afterPack: string;
        beforePack: string;
        extraResources: Array<{ from: string; to: string }>;
      };
    };

    expect(packageJson.build.beforePack).toBe(
      "packages/desktop/scripts/before-pack.mjs",
    );
    expect(packageJson.build.afterPack).toBe(
      "packages/desktop/scripts/after-pack.mjs",
    );
    expect(
      packageJson.build.extraResources.filter(
        (entry) =>
          entry.to === "home-seed" ||
          entry.to.startsWith("home-seed/") ||
          entry.from.includes("home-seed"),
      ),
    ).toEqual([
      {
        from: "packages/desktop/.packaging/home-seed",
        to: "home-seed",
        filter: ["**/*"],
      },
    ]);
  });
});
