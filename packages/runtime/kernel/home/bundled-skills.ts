/**
 * Materializes Stella-shipped skills into the canonical `~/.stella/skills/`
 * directory without overwriting user-owned content.
 *
 * Ownership is tracked outside the skill library in
 * `cache/bundled-skills.json`. An installed skill is updated only when its
 * current contents still match the last version Stella wrote. A pre-existing
 * directory with the same id, or a shipped skill edited by the user, becomes
 * user-owned and is preserved on subsequent updates.
 */

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { ensurePrivateDir } from "../shared/private-fs.js";

const BUNDLED_SKILLS_STATE_FILENAME = "bundled-skills.json";
const SKILLS_DIR_NAME = "skills";
const USER_PROFILE_SKILL_ID = "user-profile";
const PLATFORM_SKILL_IDS: Partial<Record<NodeJS.Platform, readonly string[]>> =
  {
    darwin: ["stella-computer-macos", "apple-reminders", "apple-notes"],
    win32: ["stella-computer-windows"],
  };
const PLATFORM_EXCLUSIVE_SKILL_IDS = new Set(
  Object.values(PLATFORM_SKILL_IDS).flat(),
);

type BundledSkillStateEntry = {
  /** Null means a same-id user skill won the collision and must be preserved. */
  lastSyncedHash: string | null;
};

export type BundledSkillsState = {
  version: 1;
  seedKey: string;
  skills: Record<string, BundledSkillStateEntry>;
};

export type BundledSkillSource = {
  sourceDir: string;
  hash: string;
};

export type BundledSkillsSnapshot = {
  key: string;
  skills: Map<string, BundledSkillSource>;
};

const skillsDirPath = (stellaDataDir: string): string =>
  path.join(stellaDataDir, SKILLS_DIR_NAME);

const stateFilePath = (stellaDataDir: string): string =>
  path.join(stellaDataDir, "cache", BUNDLED_SKILLS_STATE_FILENAME);

const pathExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

/** Stable whole-directory hash: sorted relative file paths plus contents. */
export const hashSkillDirectory = async (
  dir: string,
): Promise<string | null> => {
  const files: string[] = [];
  const walk = async (current: string, rel: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), childRel);
      } else if (entry.isFile()) {
        files.push(childRel);
      }
    }
  };
  try {
    await walk(dir, "");
  } catch {
    return null;
  }
  files.sort();
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(await fs.readFile(path.join(dir, ...rel.split("/"))));
    hash.update("\0");
  }
  return hash.digest("hex");
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

export const buildBundledSkillsSnapshot = async (args: {
  seedSkillsDir: string;
  platform?: NodeJS.Platform;
}): Promise<BundledSkillsSnapshot> => {
  const skillIds = await includedSeedSkillIds(
    args.seedSkillsDir,
    args.platform ?? process.platform,
  );
  const skills = new Map<string, BundledSkillSource>();
  for (const id of skillIds) {
    const sourceDir = path.join(args.seedSkillsDir, id);
    const hash = await hashSkillDirectory(sourceDir);
    if (hash !== null) skills.set(id, { sourceDir, hash });
  }
  const keyHash = createHash("sha256");
  for (const [id, skill] of skills) {
    keyHash.update(`${id}:${skill.hash}\n`);
  }
  return { key: `v1:${keyHash.digest("hex")}`, skills };
};

export const readBundledSkillsState = async (
  stellaDataDir: string,
): Promise<BundledSkillsState | null> => {
  try {
    const parsed = JSON.parse(
      await fs.readFile(stateFilePath(stellaDataDir), "utf-8"),
    ) as Partial<BundledSkillsState>;
    if (
      parsed.version !== 1 ||
      typeof parsed.seedKey !== "string" ||
      !parsed.skills ||
      typeof parsed.skills !== "object"
    ) {
      return null;
    }
    const skills: Record<string, BundledSkillStateEntry> = {};
    for (const [id, value] of Object.entries(parsed.skills)) {
      if (
        value &&
        typeof value === "object" &&
        (typeof (value as BundledSkillStateEntry).lastSyncedHash === "string" ||
          (value as BundledSkillStateEntry).lastSyncedHash === null)
      ) {
        skills[id] = {
          lastSyncedHash: (value as BundledSkillStateEntry).lastSyncedHash,
        };
      }
    }
    return {
      version: 1,
      seedKey: parsed.seedKey,
      skills,
    };
  } catch {
    return null;
  }
};

export const listBundledSkillIds = async (
  stellaDataDir: string,
): Promise<string[]> =>
  Object.keys((await readBundledSkillsState(stellaDataDir))?.skills ?? {});

const writeBundledSkillsState = async (
  stellaDataDir: string,
  state: BundledSkillsState,
): Promise<void> => {
  const target = stateFilePath(stellaDataDir);
  await ensurePrivateDir(path.dirname(target));
  const next = `${target}.next-${process.pid}-${randomUUID()}`;
  await fs.writeFile(next, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  const old = `${target}.old-${process.pid}-${randomUUID()}`;
  let movedOld = false;
  try {
    try {
      await fs.rename(target, old);
      movedOld = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.rename(next, target);
    if (movedOld) await fs.rm(old, { force: true });
  } catch (error) {
    await fs.rm(next, { force: true }).catch(() => {});
    if (movedOld) await fs.rename(old, target).catch(() => {});
    throw error;
  }
};

const cleanupBundledSkillsStateFiles = async (
  stellaDataDir: string,
): Promise<void> => {
  const target = stateFilePath(stellaDataDir);
  const stateDir = path.dirname(target);
  const base = path.basename(target);
  const entries = await fs.readdir(stateDir).catch(() => []);
  const oldFiles = entries.filter((name) => name.startsWith(`${base}.old-`));
  if (!(await pathExists(target)) && oldFiles[0]) {
    await fs.rename(path.join(stateDir, oldFiles[0]), target);
  }
  for (const name of entries) {
    if (name.startsWith(`${base}.next-`) || name.startsWith(`${base}.old-`)) {
      await fs.rm(path.join(stateDir, name), { force: true });
    }
  }
};

const replaceSkillDirectory = async (
  skillsRoot: string,
  id: string,
  sourceDir: string,
): Promise<void> => {
  const suffix = `${process.pid}-${randomUUID()}`;
  const target = path.join(skillsRoot, id);
  const next = path.join(skillsRoot, `.stella-bundled-next-${suffix}`);
  const old = path.join(skillsRoot, `.stella-bundled-old-${suffix}`);
  await fs.cp(sourceDir, next, { recursive: true });
  let movedOld = false;
  try {
    try {
      await fs.rename(target, old);
      movedOld = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.rename(next, target);
    if (movedOld) await fs.rm(old, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(next, { recursive: true, force: true }).catch(() => {});
    if (movedOld) await fs.rename(old, target).catch(() => {});
    throw error;
  }
};

const listDirectories = async (dir: string): Promise<string[]> => {
  try {
    return (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
};

const cleanupBundledSkillStaging = async (
  skillsRoot: string,
): Promise<void> => {
  const entries = await fs
    .readdir(skillsRoot, { withFileTypes: true })
    .catch(() => []);
  for (const entry of entries) {
    if (
      entry.name.startsWith(".stella-bundled-next-") ||
      entry.name.startsWith(".stella-bundled-old-")
    ) {
      await fs.rm(path.join(skillsRoot, entry.name), {
        recursive: true,
        force: true,
      });
    }
  }
};

/**
 * Compatibility bridge for the former installed `system/skills` mirror.
 * Unknown legacy entries are copied into the canonical root, then the entire
 * legacy tree is moved to trash so no second installed skills namespace
 * remains. Shipped ids are installed from the current app seed below.
 */
const migrateLegacySystemSkills = async (
  stellaDataDir: string,
  bundledIds: ReadonlySet<string>,
): Promise<string | null> => {
  // These names are intentionally migration-only. Normal discovery and sync
  // never read the legacy root.
  const legacySystemDir = path.join(stellaDataDir, "system");
  const entries = await fs
    .readdir(stellaDataDir, { withFileTypes: true })
    .catch(() => []);
  if (!(await pathExists(legacySystemDir))) {
    const backup = entries.find(
      (entry) => entry.isDirectory() && entry.name.startsWith(".system.old-"),
    );
    if (backup) {
      await fs.rename(path.join(stellaDataDir, backup.name), legacySystemDir);
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(".system.next-")) {
      await fs.rm(path.join(stellaDataDir, entry.name), {
        recursive: true,
        force: true,
      });
    }
  }
  if (!(await pathExists(legacySystemDir))) return null;

  const abandonedBackupsDir = path.join(
    legacySystemDir,
    ".abandoned-mirror-backups",
  );
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(".system.old-")) {
      continue;
    }
    const oldPath = path.join(stellaDataDir, entry.name);
    if (!(await pathExists(oldPath))) continue;
    await ensurePrivateDir(abandonedBackupsDir);
    await fs.rename(oldPath, path.join(abandonedBackupsDir, entry.name));
  }

  const legacySkillsDir = path.join(legacySystemDir, "skills");
  const skillsRoot = skillsDirPath(stellaDataDir);
  await ensurePrivateDir(skillsRoot);
  for (const id of await listDirectories(legacySkillsDir)) {
    if (bundledIds.has(id)) continue;
    const target = path.join(skillsRoot, id);
    if (!(await pathExists(target))) {
      await fs.cp(path.join(legacySkillsDir, id), target, { recursive: true });
    }
  }
  return legacySystemDir;
};

const archiveLegacySystemDir = async (
  stellaDataDir: string,
  legacySystemDir: string | null,
): Promise<void> => {
  if (!legacySystemDir || !(await pathExists(legacySystemDir))) return;
  const archiveRoot = path.join(
    stellaDataDir,
    ".trash",
    `legacy-system-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`,
  );
  await ensurePrivateDir(archiveRoot);
  const target = path.join(archiveRoot, "system");
  try {
    await fs.rename(legacySystemDir, target);
  } catch {
    await fs.cp(legacySystemDir, target, { recursive: true });
    await fs.rm(legacySystemDir, { recursive: true, force: true });
  }
};

let syncQueueTail: Promise<unknown> = Promise.resolve();

const syncBundledSkillsLocked = async (
  stellaDataDir: string,
  snapshot: BundledSkillsSnapshot,
): Promise<{ applied: boolean }> => {
  await ensurePrivateDir(stellaDataDir);
  const skillsRoot = skillsDirPath(stellaDataDir);
  await ensurePrivateDir(skillsRoot);
  await cleanupBundledSkillStaging(skillsRoot);
  const legacySystemDir = await migrateLegacySystemSkills(
    stellaDataDir,
    new Set(snapshot.skills.keys()),
  );
  await cleanupBundledSkillsStateFiles(stellaDataDir);
  const previous = await readBundledSkillsState(stellaDataDir);
  const nextSkills: Record<string, BundledSkillStateEntry> = {};
  let applied = false;
  let retiredSkillsTrashDir: string | null = null;

  for (const [id, source] of snapshot.skills) {
    const target = path.join(skillsRoot, id);
    const prior = previous?.skills[id];
    if (!(await pathExists(target))) {
      await replaceSkillDirectory(skillsRoot, id, source.sourceDir);
      nextSkills[id] = { lastSyncedHash: source.hash };
      applied = true;
      continue;
    }
    if (!prior || prior.lastSyncedHash === null) {
      nextSkills[id] = { lastSyncedHash: null };
      continue;
    }
    if (prior.lastSyncedHash === source.hash) {
      nextSkills[id] = prior;
      continue;
    }
    const installedHash = await hashSkillDirectory(target);
    if (installedHash === prior.lastSyncedHash) {
      await replaceSkillDirectory(skillsRoot, id, source.sourceDir);
      nextSkills[id] = { lastSyncedHash: source.hash };
      applied = true;
    } else {
      nextSkills[id] = { lastSyncedHash: null };
    }
  }

  for (const [id, prior] of Object.entries(previous?.skills ?? {})) {
    if (snapshot.skills.has(id) || prior.lastSyncedHash === null) continue;
    const target = path.join(skillsRoot, id);
    if ((await hashSkillDirectory(target)) !== prior.lastSyncedHash) continue;
    retiredSkillsTrashDir ??= path.join(
      stellaDataDir,
      ".trash",
      `retired-bundled-skills-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`,
      SKILLS_DIR_NAME,
    );
    await ensurePrivateDir(retiredSkillsTrashDir);
    await fs.rename(target, path.join(retiredSkillsTrashDir, id));
    applied = true;
  }

  const nextState: BundledSkillsState = {
    version: 1,
    seedKey: snapshot.key,
    skills: nextSkills,
  };
  if (JSON.stringify(previous) !== JSON.stringify(nextState)) {
    await writeBundledSkillsState(stellaDataDir, nextState);
  }
  await archiveLegacySystemDir(stellaDataDir, legacySystemDir);
  return { applied };
};

/** Serialized in-process; individual skill replacements are atomic. */
export const syncBundledSkills = (
  stellaDataDir: string,
  snapshot: BundledSkillsSnapshot,
): Promise<{ applied: boolean }> => {
  const run = syncQueueTail.then(
    () => syncBundledSkillsLocked(stellaDataDir, snapshot),
    () => syncBundledSkillsLocked(stellaDataDir, snapshot),
  );
  syncQueueTail = run.catch(() => {});
  return run;
};
