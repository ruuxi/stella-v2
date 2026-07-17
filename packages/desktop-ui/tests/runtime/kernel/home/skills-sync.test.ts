import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createDirectoryEntryAdapter,
  reconcileBundledEntries,
  type BundledManifestPersistence,
} from "@stella/runtime/kernel/home/bundled-sync";
import { reconcileBundledSkills } from "@stella/runtime/kernel/home/skills-sync";
import {
  isRetiredBundledSkillId,
  RETIRED_BUNDLED_SKILL_IDS,
} from "@stella/runtime/kernel/shared/skill-policy";

const roots = new Set<string>();

const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.add(dir);
  return dir;
};

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

const writeSkillFile = async (
  root: string,
  id: string,
  rel: string,
  content: string,
) => {
  const full = path.join(root, id, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf-8");
};

const readManifest = async (homeSkillsDir: string) => {
  const raw = await readFile(
    path.join(homeSkillsDir, ".bundled-manifest.json"),
    "utf-8",
  );
  return JSON.parse(raw) as {
    version: number;
    entries: Record<
      string,
      { lastSyncedHash: string; sourceRevision: string; customized: boolean }
    >;
  };
};

const seedFormerBundledSkill = async (
  bundled: string,
  home: string,
  id: string,
  content: string,
  additionalFiles: Record<string, string> = {},
) => {
  await writeSkillFile(bundled, id, "SKILL.md", content);
  for (const [relativePath, fileContent] of Object.entries(additionalFiles)) {
    await writeSkillFile(bundled, id, relativePath, fileContent);
  }
  await reconcileBundledEntries(bundled, home, createDirectoryEntryAdapter(), {
    legacyEntriesKey: "skills",
  });
  await rm(path.join(bundled, id), { recursive: true, force: true });
};

const manifestFaults: Array<{
  label: string;
  error: string;
  persistence: Partial<BundledManifestPersistence>;
  commitFails: boolean;
}> = [
  {
    label: "manifest read",
    error: "manifest read denied",
    persistence: {
      readFile: async () => {
        throw new Error("manifest read denied");
      },
    },
    commitFails: false,
  },
  {
    label: "temporary manifest write",
    error: "manifest temp write denied",
    persistence: {
      writeFile: async (filePath) => {
        await writeFile(filePath, "partial manifest bytes", "utf-8");
        throw new Error("manifest temp write denied");
      },
    },
    commitFails: true,
  },
  {
    label: "manifest rename",
    error: "manifest rename denied",
    persistence: {
      rename: async () => {
        throw new Error("manifest rename denied");
      },
    },
    commitFails: true,
  },
];

type FilesystemSnapshot = Array<{
  path: string;
  type: "directory" | "file" | "symlink" | "other";
  inode: number;
  mode: number;
  size: number;
  mtimeMs: number;
  linkTarget?: string;
  bytes?: string;
}>;

const snapshotFilesystemTree = async (
  root: string,
): Promise<FilesystemSnapshot> => {
  const snapshot: FilesystemSnapshot = [];
  const walk = async (current: string, relativePath: string): Promise<void> => {
    const entry = await lstat(current);
    const common = {
      path: relativePath || ".",
      inode: entry.ino,
      mode: entry.mode & 0o7777,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
    };
    if (entry.isSymbolicLink()) {
      snapshot.push({
        ...common,
        type: "symlink",
        linkTarget: await readlink(current),
      });
      return;
    }
    if (entry.isDirectory()) {
      snapshot.push({ ...common, type: "directory" });
      const children = (await readdir(current)).sort((a, b) =>
        a.localeCompare(b),
      );
      for (const child of children) {
        await walk(
          path.join(current, child),
          relativePath ? `${relativePath}/${child}` : child,
        );
      }
      return;
    }
    if (entry.isFile()) {
      snapshot.push({
        ...common,
        type: "file",
        bytes: (await readFile(current)).toString("base64"),
      });
      return;
    }
    snapshot.push({ ...common, type: "other" });
  };
  await walk(root, "");
  return snapshot;
};

const skillFiles = async (
  homeSkillsDir: string,
  id: string,
): Promise<string[]> => {
  const walk = async (dir: string, prefix: string): Promise<string[]> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await walk(full, rel)));
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
    return out.sort((a, b) => a.localeCompare(b));
  };
  return walk(path.join(homeSkillsDir, id), "");
};

describe("reconcileBundledSkills", () => {
  it("seeds every bundled skill into an empty home", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v1");
    await writeSkillFile(bundled, "beta", "SKILL.md", "beta v1");

    const report = await reconcileBundledSkills(bundled, home);

    expect(report.actions.filter((a) => a.type === "seed")).toHaveLength(2);
    await expect(
      readFile(path.join(home, "alpha", "SKILL.md"), "utf-8"),
    ).resolves.toBe("alpha v1");
    const manifest = await readManifest(home);
    expect(Object.keys(manifest.entries).sort()).toEqual(["alpha", "beta"]);
  });

  it("seeds only the current platform computer skill", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v1");
    await writeSkillFile(
      bundled,
      "stella-computer-macos",
      "SKILL.md",
      "mac skill",
    );
    await writeSkillFile(
      bundled,
      "stella-computer-windows",
      "SKILL.md",
      "windows skill",
    );

    const report = await reconcileBundledSkills(bundled, home, {
      platform: "win32",
    });

    expect(report.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "seed", id: "alpha" }),
        expect.objectContaining({
          type: "seed",
          id: "stella-computer-windows",
        }),
      ]),
    );
    await expect(
      readFile(path.join(home, "stella-computer-windows", "SKILL.md"), "utf-8"),
    ).resolves.toBe("windows skill");
    await expect(
      readFile(path.join(home, "stella-computer-macos", "SKILL.md"), "utf-8"),
    ).rejects.toThrow();
    const manifest = await readManifest(home);
    expect(Object.keys(manifest.entries).sort()).toEqual([
      "alpha",
      "stella-computer-windows",
    ]);
  });

  it("removes a previously tracked platform computer skill when the platform changes", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    await writeSkillFile(
      bundled,
      "stella-computer-macos",
      "SKILL.md",
      "mac skill",
    );
    await writeSkillFile(
      bundled,
      "stella-computer-windows",
      "SKILL.md",
      "windows skill",
    );

    await reconcileBundledSkills(bundled, home, { platform: "darwin" });
    const report = await reconcileBundledSkills(bundled, home, {
      platform: "win32",
    });

    expect(report.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "seed",
          id: "stella-computer-windows",
        }),
        expect.objectContaining({
          type: "remove-obsolete",
          id: "stella-computer-macos",
        }),
      ]),
    );
    await expect(
      readFile(path.join(home, "stella-computer-macos", "SKILL.md"), "utf-8"),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(home, "stella-computer-windows", "SKILL.md"), "utf-8"),
    ).resolves.toBe("windows skill");
  });

  it("overwrites a home skill when its hash still matches the manifest", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    // First boot: seed v1.
    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v1");
    await reconcileBundledSkills(bundled, home);

    // Second boot: bundle bumped to v2, user has not touched local copy.
    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v2");
    const report = await reconcileBundledSkills(bundled, home);

    expect(report.actions).toEqual([
      expect.objectContaining({ type: "update", id: "alpha" }),
    ]);
    await expect(
      readFile(path.join(home, "alpha", "SKILL.md"), "utf-8"),
    ).resolves.toBe("alpha v2");
  });

  it("preserves a skill the user has modified", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v1");
    await reconcileBundledSkills(bundled, home);

    // User edits their copy.
    await writeFile(
      path.join(home, "alpha", "SKILL.md"),
      "user edits",
      "utf-8",
    );

    // New bundled version arrives.
    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v2");
    const report = await reconcileBundledSkills(bundled, home);

    expect(report.actions).toEqual([
      expect.objectContaining({
        type: "skip-user-modified",
        id: "alpha",
        reason: "diverged",
      }),
    ]);
    await expect(
      readFile(path.join(home, "alpha", "SKILL.md"), "utf-8"),
    ).resolves.toBe("user edits");

    // Preserve the last synced hash while marking the local copy customized.
    const manifest = await readManifest(home);
    expect(manifest.entries.alpha).toEqual(
      expect.objectContaining({ customized: true }),
    );
  });

  it("deletes obsolete files inside an unmodified skill when the bundle removes them", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v1");
    await writeSkillFile(
      bundled,
      "alpha",
      "templates/old.tmpl",
      "old template",
    );
    await reconcileBundledSkills(bundled, home);

    // Bundle drops the old template.
    await rm(path.join(bundled, "alpha", "templates"), {
      recursive: true,
      force: true,
    });
    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v2");

    const report = await reconcileBundledSkills(bundled, home);

    expect(report.actions).toEqual([
      expect.objectContaining({ type: "update", id: "alpha" }),
    ]);
    expect(await skillFiles(home, "alpha")).toEqual(["SKILL.md"]);
  });

  it("removes a skill that the bundle dropped entirely when the user hasn't modified it", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v1");
    await writeSkillFile(bundled, "obsolete", "SKILL.md", "obsolete v1");
    await reconcileBundledSkills(bundled, home);

    await rm(path.join(bundled, "obsolete"), { recursive: true, force: true });

    const report = await reconcileBundledSkills(bundled, home);

    expect(report.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "remove-obsolete",
          id: "obsolete",
        }),
      ]),
    );
    await expect(readdir(path.join(home, "obsolete"))).rejects.toThrow();
    const manifest = await readManifest(home);
    expect(manifest.entries.obsolete).toBeUndefined();
  });

  it("keeps a user-modified obsolete skill and retains its sync history", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    await writeSkillFile(bundled, "obsolete", "SKILL.md", "v1");
    await reconcileBundledSkills(bundled, home);

    await writeFile(
      path.join(home, "obsolete", "SKILL.md"),
      "user edits",
      "utf-8",
    );
    await rm(path.join(bundled, "obsolete"), { recursive: true, force: true });

    const report = await reconcileBundledSkills(bundled, home);

    expect(report.actions).toEqual([
      expect.objectContaining({
        type: "skip-obsolete-user-modified",
        id: "obsolete",
      }),
    ]);
    await expect(
      readFile(path.join(home, "obsolete", "SKILL.md"), "utf-8"),
    ).resolves.toBe("user edits");
    const manifest = await readManifest(home);
    expect(manifest.entries.obsolete).toEqual(
      expect.objectContaining({ customized: true }),
    );
  });

  it("preserves unmanifested custom content under a retired id", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");
    await writeSkillFile(bundled, "stella-desktop", "SKILL.md", "stale seed");
    await writeSkillFile(home, "stella-desktop", "SKILL.md", "custom bytes");
    const before = await snapshotFilesystemTree(
      path.join(home, "stella-desktop"),
    );

    const report = await reconcileBundledSkills(bundled, home);

    expect(report.actions).toContainEqual({
      type: "preserve-retired-entry",
      id: "stella-desktop",
    });
    expect(
      await snapshotFilesystemTree(path.join(home, "stella-desktop")),
    ).toEqual(before);
    expect(
      (await readManifest(home)).entries["stella-desktop"],
    ).toBeUndefined();
  });

  it("preserves divergent and pristine manifest-owned retired copies", async () => {
    for (const divergent of [false, true]) {
      const bundled = await tempDir("stella-bundled-");
      const home = await tempDir("stella-home-skills-");
      await seedFormerBundledSkill(
        bundled,
        home,
        "stella-desktop",
        "bundled v1",
      );
      if (divergent) {
        await writeFile(
          path.join(home, "stella-desktop", "SKILL.md"),
          "user customization",
          "utf-8",
        );
      }
      const before = await snapshotFilesystemTree(
        path.join(home, "stella-desktop"),
      );

      await reconcileBundledSkills(bundled, home);

      expect(
        await snapshotFilesystemTree(path.join(home, "stella-desktop")),
      ).toEqual(before);
      expect(
        (await readManifest(home)).entries["stella-desktop"],
      ).toBeUndefined();
    }
  });

  it("preserves mode-only changes, empty directories, and nested binary bytes", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");
    await writeSkillFile(
      bundled,
      "stella-desktop",
      "SKILL.md",
      "former bundle",
    );
    await writeSkillFile(
      bundled,
      "stella-desktop",
      "scripts/run.sh",
      "#!/bin/sh\necho retained\n",
    );
    await mkdir(path.join(bundled, "stella-desktop", "empty-dir"));
    await writeFile(
      path.join(bundled, "stella-desktop", "assets.bin"),
      Uint8Array.from([0, 255, 13, 10, 128, 1]),
    );
    await reconcileBundledEntries(
      bundled,
      home,
      createDirectoryEntryAdapter(),
      { legacyEntriesKey: "skills" },
    );
    await rm(path.join(bundled, "stella-desktop"), {
      recursive: true,
      force: true,
    });
    await chmod(path.join(home, "stella-desktop"), 0o751);
    await chmod(path.join(home, "stella-desktop", "SKILL.md"), 0o640);
    await chmod(path.join(home, "stella-desktop", "scripts", "run.sh"), 0o750);
    const before = await snapshotFilesystemTree(
      path.join(home, "stella-desktop"),
    );

    await reconcileBundledSkills(bundled, home);

    expect(
      await snapshotFilesystemTree(path.join(home, "stella-desktop")),
    ).toEqual(before);
    expect(before).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "empty-dir", type: "directory" }),
        expect.objectContaining({ path: "assets.bin", bytes: "AP8NCoAB" }),
      ]),
    );
  });

  it("preserves a retired symlink without following or replacing it", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");
    const external = await tempDir("stella-external-skill-");
    await seedFormerBundledSkill(bundled, home, "stella-desktop", "bundled v1");
    await rm(path.join(home, "stella-desktop"), {
      recursive: true,
      force: true,
    });
    await writeFile(path.join(external, "SKILL.md"), "external bytes", "utf-8");
    await symlink(external, path.join(home, "stella-desktop"));
    const before = await snapshotFilesystemTree(
      path.join(home, "stella-desktop"),
    );

    await reconcileBundledSkills(bundled, home);

    expect(
      await snapshotFilesystemTree(path.join(home, "stella-desktop")),
    ).toEqual(before);
    expect(
      (await readManifest(home)).entries["stella-desktop"],
    ).toBeUndefined();
  });

  it("never calls hash, copy, or remove for a retired home directory", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");
    await seedFormerBundledSkill(bundled, home, "stella-desktop", "bundled v1");
    const adapter = createDirectoryEntryAdapter();
    const forbidden = async () => {
      throw new Error("retired directory operation was called");
    };

    await expect(
      reconcileBundledEntries(
        bundled,
        home,
        { ...adapter, hash: forbidden, copy: forbidden, remove: forbidden },
        {
          isRetiredBundledId: isRetiredBundledSkillId,
          retiredBundledIds: RETIRED_BUNDLED_SKILL_IDS,
          legacyEntriesKey: "skills",
        },
      ),
    ).resolves.toEqual({
      actions: [{ type: "preserve-retired-entry", id: "stella-desktop" }],
    });
  });

  it.each(manifestFaults)(
    "keeps retired directories unchanged through $label failure and retries metadata",
    async ({ error, persistence, commitFails }) => {
      const bundled = await tempDir("stella-bundled-");
      const home = await tempDir("stella-home-skills-");
      await seedFormerBundledSkill(
        bundled,
        home,
        "stella-desktop",
        "bundled v1",
        { "nested/data.txt": "retained nested bytes" },
      );
      const before = await snapshotFilesystemTree(
        path.join(home, "stella-desktop"),
      );

      const report = await reconcileBundledEntries(
        bundled,
        home,
        createDirectoryEntryAdapter(),
        {
          isRetiredBundledId: isRetiredBundledSkillId,
          retiredBundledIds: RETIRED_BUNDLED_SKILL_IDS,
          legacyEntriesKey: "skills",
          manifestPersistence: persistence,
        },
      );

      expect(
        await snapshotFilesystemTree(path.join(home, "stella-desktop")),
      ).toEqual(before);
      if (commitFails) {
        expect(report.actions).toContainEqual({
          type: "skip-retired-manifest-cleanup-failed",
          error,
        });
        expect(
          (await readManifest(home)).entries["stella-desktop"],
        ).toBeDefined();
      }
      expect(
        (await readdir(home)).filter((name) =>
          name.startsWith(".bundled-manifest.json.tmp-"),
        ),
      ).toEqual([]);

      await reconcileBundledSkills(bundled, home);
      expect(
        await snapshotFilesystemTree(path.join(home, "stella-desktop")),
      ).toEqual(before);
      expect(
        (await readManifest(home)).entries["stella-desktop"],
      ).toBeUndefined();
    },
  );

  it("concurrent retired reconciliation is non-destructive and converges metadata", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");
    await seedFormerBundledSkill(
      bundled,
      home,
      "stella-desktop",
      "bundled v1",
      { "nested/data.txt": "retained" },
    );
    const before = await snapshotFilesystemTree(
      path.join(home, "stella-desktop"),
    );

    await expect(
      Promise.all(
        Array.from({ length: 8 }, () => reconcileBundledSkills(bundled, home)),
      ),
    ).resolves.toHaveLength(8);

    expect(
      await snapshotFilesystemTree(path.join(home, "stella-desktop")),
    ).toEqual(before);
    expect(
      (await readManifest(home)).entries["stella-desktop"],
    ).toBeUndefined();
    expect(
      (await readdir(home)).filter((name) =>
        name.startsWith(".bundled-manifest.json.tmp-"),
      ),
    ).toEqual([]);
  });

  it("does not seed retired skill ids still present in a stale package", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    await writeSkillFile(bundled, "humanizer", "SKILL.md", "supported");
    await writeSkillFile(
      bundled,
      "stella-runtime-extension",
      "SKILL.md",
      "stale package payload",
    );

    const report = await reconcileBundledSkills(bundled, home);

    expect(report.actions).toEqual([
      expect.objectContaining({ type: "seed", id: "humanizer" }),
    ]);
    await expect(
      readdir(path.join(home, "stella-runtime-extension")),
    ).rejects.toThrow();
  });

  it("prunes retired ids left behind in a generated manifest", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    await writeSkillFile(bundled, "humanizer", "SKILL.md", "supported");
    await reconcileBundledSkills(bundled, home);

    const manifest = await readManifest(home);
    manifest.entries["stella-llm"] = manifest.entries.humanizer!;
    await writeFile(
      path.join(home, ".bundled-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf-8",
    );

    await reconcileBundledSkills(bundled, home);

    const reconciled = await readManifest(home);
    expect(reconciled.entries["stella-llm"]).toBeUndefined();
    expect(reconciled.entries.humanizer).toBeDefined();
  });

  it("ignores user-authored skills with no bundled counterpart and no manifest entry", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v1");
    // User-authored skill that never came from the bundle.
    await writeSkillFile(home, "gmail", "SKILL.md", "user skill");

    const report = await reconcileBundledSkills(bundled, home);

    expect(report.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "seed", id: "alpha" }),
        expect.objectContaining({
          type: "ignore-user-entry",
          id: "gmail",
        }),
      ]),
    );
    await expect(
      readFile(path.join(home, "gmail", "SKILL.md"), "utf-8"),
    ).resolves.toBe("user skill");
    const manifest = await readManifest(home);
    expect(manifest.entries.gmail).toBeUndefined();
  });

  it("never touches user-profile, even if it sits in the bundle", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    await writeSkillFile(bundled, "user-profile", "SKILL.md", "bundled");
    await writeSkillFile(home, "user-profile", "SKILL.md", "user-owned");

    const report = await reconcileBundledSkills(bundled, home);

    expect(
      report.actions.find((a) => ("id" in a ? a.id === "user-profile" : false)),
    ).toBeUndefined();
    await expect(
      readFile(path.join(home, "user-profile", "SKILL.md"), "utf-8"),
    ).resolves.toBe("user-owned");
  });

  it("treats a first-run identical home skill as adopted (next bundle bump syncs)", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    // Simulate the legacy bootstrap: user already has alpha v1 locally and
    // the bundle still ships alpha v1 — but no manifest exists yet.
    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v1");
    await writeSkillFile(home, "alpha", "SKILL.md", "alpha v1");

    let report = await reconcileBundledSkills(bundled, home);
    expect(report.actions).toEqual([
      expect.objectContaining({ type: "adopt-identical", id: "alpha" }),
    ]);

    // Next boot: bundle bumps to v2. Because we adopted the hash, the user
    // is now considered "unmodified" and the update can proceed.
    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v2");
    report = await reconcileBundledSkills(bundled, home);
    expect(report.actions).toEqual([
      expect.objectContaining({ type: "update", id: "alpha" }),
    ]);
    await expect(
      readFile(path.join(home, "alpha", "SKILL.md"), "utf-8"),
    ).resolves.toBe("alpha v2");
  });

  it("on first run with no manifest, preserves and tracks a diverged local copy", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    // Legacy state: user has long-edited alpha to something other than the
    // current bundle. No manifest.
    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v1");
    await writeSkillFile(home, "alpha", "SKILL.md", "user-edited");

    const report = await reconcileBundledSkills(bundled, home);
    expect(report.actions).toEqual([
      expect.objectContaining({
        type: "skip-user-modified",
        id: "alpha",
        reason: "no-manifest",
      }),
    ]);
    await expect(
      readFile(path.join(home, "alpha", "SKILL.md"), "utf-8"),
    ).resolves.toBe("user-edited");
    const manifest = await readManifest(home);
    expect(manifest.entries.alpha).toEqual(
      expect.objectContaining({ customized: true }),
    );
  });

  it("reads a legacy `skills` manifest so already-installed users still get updates", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    // Seed alpha v1, then rewrite the manifest into the pre-rename shape
    // (`{ version, skills }`) to simulate an install created before the
    // generic `entries` key existed.
    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v1");
    await reconcileBundledSkills(bundled, home);
    const seeded = await readManifest(home);
    await writeFile(
      path.join(home, ".bundled-manifest.json"),
      `${JSON.stringify({ version: seeded.version, skills: seeded.entries }, null, 2)}\n`,
      "utf-8",
    );

    // Bundle bumps to v2; the user never touched their local copy. The legacy
    // hashes must be honored so this lands as an update, not a no-manifest skip.
    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v2");
    const report = await reconcileBundledSkills(bundled, home);

    expect(report.actions).toEqual([
      expect.objectContaining({ type: "update", id: "alpha" }),
    ]);
    await expect(
      readFile(path.join(home, "alpha", "SKILL.md"), "utf-8"),
    ).resolves.toBe("alpha v2");

    // And the manifest self-heals onto the canonical `entries` shape.
    const migrated = await readManifest(home);
    expect(migrated.entries.alpha).toBeDefined();
  });

  it("is a no-op when bundle and home already agree under a current manifest", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v1");
    await reconcileBundledSkills(bundled, home);

    const second = await reconcileBundledSkills(bundled, home);
    expect(second.actions).toEqual([]);
  });
});
