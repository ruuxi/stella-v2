/**
 * `~/.stella/system/` — the mirrored copy of Stella's bundled skills.
 *
 *   system/
 *     skills/<id>/      bundled skill directory
 *     revision.json     what is currently mirrored
 *
 * The sync algorithm is a mirror, not a merge: build the whole snapshot in a
 * staging directory, then atomically swap it into place. No per-entry
 * hashing, no "customized" bookkeeping — user skills live in
 * `~/.stella/skills/` and shadow a mirrored skill by id (see
 * `skill-catalog.ts`), so a sync can never touch user files.
 *
 * System prompts are NOT part of this: they live in the app bundle
 * (`stella-runtime/agent-metadata` and `stella-runtime/prompts`) and are read
 * directly from there. A cheap stat-based fingerprint of the skill seed keeps
 * the mirror refreshing after app updates without hashing content every boot.
 */

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { ensurePrivateDir } from "../shared/private-fs.js";

export const SYSTEM_DIR_NAME = "system";
const SYSTEM_REVISION_FILENAME = "revision.json";

const USER_PROFILE_SKILL_ID = "user-profile";
const PLATFORM_SKILL_IDS: Partial<Record<NodeJS.Platform, readonly string[]>> =
  {
    darwin: ["stella-computer-macos", "apple-reminders", "apple-notes"],
    win32: ["stella-computer-windows"],
  };
const PLATFORM_EXCLUSIVE_SKILL_IDS = new Set(
  Object.values(PLATFORM_SKILL_IDS).flat(),
);

export type SystemRevision = {
  version: 1;
  key: string;
  mirroredAt: number;
};

export type SystemSnapshot = {
  key: string;
  /** Skill id → absolute source directory to copy recursively. */
  skillDirs: Map<string, string>;
};

export const systemDirPath = (stellaDataDir: string): string =>
  path.join(stellaDataDir, SYSTEM_DIR_NAME);

const revisionFilePath = (stellaDataDir: string): string =>
  path.join(systemDirPath(stellaDataDir), SYSTEM_REVISION_FILENAME);

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const readSystemRevision = async (
  stellaDataDir: string,
): Promise<SystemRevision | null> => {
  try {
    const parsed = JSON.parse(
      await fs.readFile(revisionFilePath(stellaDataDir), "utf-8"),
    ) as Partial<SystemRevision>;
    if (parsed.version !== 1 || typeof parsed.key !== "string") {
      return null;
    }
    return parsed as SystemRevision;
  } catch {
    return null;
  }
};

const includedSeedSkillIds = async (
  seedSkillsDir: string,
  platform: NodeJS.Platform,
): Promise<string[]> => {
  let entries;
  try {
    entries = await fs.readdir(seedSkillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const platformIds = new Set(PLATFORM_SKILL_IDS[platform] ?? []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(
      (id) =>
        id !== USER_PROFILE_SKILL_ID &&
        (!PLATFORM_EXCLUSIVE_SKILL_IDS.has(id) || platformIds.has(id)),
    )
    .sort();
};

/**
 * Cheap change signal for the packaged skill seed: relative paths plus
 * size+mtime, never content. Packaged installs have stable mtimes, so this
 * stays constant between app updates and changes with them.
 */
const skillSeedFingerprint = async (
  seedSkillsDir: string,
  skillIds: readonly string[],
): Promise<string> => {
  const lines: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, childRel);
      } else if (entry.isFile()) {
        const stat = await fs.stat(abs);
        lines.push(`${childRel}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
      }
    }
  };
  for (const id of skillIds) {
    await walk(path.join(seedSkillsDir, id), id);
  }
  return sha256(lines.join("\n"));
};

export const buildSystemSnapshot = async (args: {
  seedSkillsDir: string;
  platform?: NodeJS.Platform;
}): Promise<SystemSnapshot> => {
  const platform = args.platform ?? process.platform;
  const skillIds = await includedSeedSkillIds(args.seedSkillsDir, platform);
  const skillDirs = new Map(
    skillIds.map((id) => [id, path.join(args.seedSkillsDir, id)]),
  );
  const skillsKey = await skillSeedFingerprint(args.seedSkillsDir, skillIds);
  return {
    key: `v2|skills:${skillsKey}`,
    skillDirs,
  };
};

let mirrorQueueTail: Promise<unknown> = Promise.resolve();

const mirrorSystemDirLocked = async (
  stellaDataDir: string,
  snapshot: SystemSnapshot,
): Promise<{ applied: boolean }> => {
  const systemDir = systemDirPath(stellaDataDir);
  const current = await readSystemRevision(stellaDataDir);
  if (current?.key === snapshot.key) {
    return { applied: false };
  }

  const suffix = `${process.pid}-${randomUUID()}`;
  const nextDir = path.join(stellaDataDir, `.system.next-${suffix}`);
  const oldDir = path.join(stellaDataDir, `.system.old-${suffix}`);
  try {
    await ensurePrivateDir(nextDir);
    if (snapshot.skillDirs.size > 0) {
      await ensurePrivateDir(path.join(nextDir, "skills"));
      for (const [id, sourceDir] of snapshot.skillDirs) {
        await fs.cp(sourceDir, path.join(nextDir, "skills", id), {
          recursive: true,
        });
      }
    }
    const revision: SystemRevision = {
      version: 1,
      key: snapshot.key,
      mirroredAt: Date.now(),
    };
    await fs.writeFile(
      path.join(nextDir, SYSTEM_REVISION_FILENAME),
      `${JSON.stringify(revision, null, 2)}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );

    try {
      await fs.rename(systemDir, oldDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.rename(nextDir, systemDir);
    await fs.rm(oldDir, { recursive: true, force: true });
    return { applied: true };
  } catch (error) {
    await fs.rm(nextDir, { recursive: true, force: true }).catch(() => {});
    // If the swap was interrupted after `system` moved aside, restore it so
    // the runtime never observes a missing system directory.
    try {
      await fs.rename(oldDir, systemDir);
    } catch {}
    throw error;
  }
};

/** Serialized in-process; the swap itself is atomic against other processes. */
export const mirrorSystemDir = (
  stellaDataDir: string,
  snapshot: SystemSnapshot,
): Promise<{ applied: boolean }> => {
  const run = mirrorQueueTail.then(
    () => mirrorSystemDirLocked(stellaDataDir, snapshot),
    () => mirrorSystemDirLocked(stellaDataDir, snapshot),
  );
  mirrorQueueTail = run.catch(() => {});
  return run;
};

/** Stale staging/backup dirs from an interrupted swap (crash mid-mirror). */
export const cleanupAbandonedSystemDirs = async (
  stellaDataDir: string,
): Promise<void> => {
  let entries;
  try {
    entries = await fs.readdir(stellaDataDir, { withFileTypes: true });
  } catch {
    return;
  }
  const systemExists = entries.some(
    (entry) => entry.isDirectory() && entry.name === SYSTEM_DIR_NAME,
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".system.next-")) {
      await fs
        .rm(path.join(stellaDataDir, entry.name), {
          recursive: true,
          force: true,
        })
        .catch(() => {});
    } else if (entry.name.startsWith(".system.old-")) {
      const oldPath = path.join(stellaDataDir, entry.name);
      if (!systemExists) {
        // A crash between the two renames left only the backup; restore it.
        await fs.rename(oldPath, systemDirPath(stellaDataDir)).catch(() => {});
      } else {
        await fs.rm(oldPath, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
};
