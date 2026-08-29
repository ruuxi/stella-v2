/**
 * One-time migrations out of the two retired home layouts.
 *
 * The original layout materialized shipped content directly into the
 * user-facing directories (`agents/`, `prompts/`, `skills/`,
 * `PERSONALITY.md`) and used `.bundled-manifest.json` files recording the hash
 * of the last synced copy to decide whether the user had modified each entry.
 * A later layout moved shipped skills into a `system/` mirror and reserved the
 * user-facing directories for customizations. Both are gone: shipped skills
 * now share the canonical `skills/` root with user-created skills and are
 * reconciled there by content hash (`skills-sync.ts`).
 *
 * `migrateLegacyHomeLayout` is the only place the original hashes are ever
 * consulted again:
 * - unmodified entries (hash matches the manifest) are deleted so the current
 *   reconciler installs the latest shipped copy;
 * - modified agent prompts become `<id>.replace.md` (full replacement,
 *   opts out of updates);
 * - modified prompts / skills / PERSONALITY.md stay where they are and win
 *   the shared-root collision policy;
 * - manifests are removed only when their entry shape proves they belong to
 *   the retired layout. Current v2 prompt/personality manifests use the same
 *   filenames and must survive every seed.
 *
 * Entries with no manifest record were always user-owned and are untouched.
 *
 * `migrateLegacySystemSkillRoot` retires the `system/` mirror: mirrored skills
 * the bundle no longer ships are carried into the canonical root without
 * replacing collisions, then the whole mirror is moved to `.trash/`.
 */

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { ensurePrivateDir } from "../shared/private-fs.js";

const BUNDLED_MANIFEST_FILENAME = ".bundled-manifest.json";
const PERSONALITY_MANIFEST_FILENAME = ".personality-manifest.json";

type LegacyManifestEntries = Record<string, { lastSyncedHash: string }>;

const isSha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

const sha256 = (value: Buffer | string): string =>
  createHash("sha256").update(value).digest("hex");

const readLegacyManifest = async (
  dir: string,
  legacyEntriesKey?: string,
): Promise<LegacyManifestEntries | null> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await fs.readFile(path.join(dir, BUNDLED_MANIFEST_FILENAME), "utf-8"),
    );
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 && record.version !== 2) return null;
  const rawEntries =
    record.entries ?? (legacyEntriesKey ? record[legacyEntriesKey] : undefined);
  if (
    !rawEntries ||
    typeof rawEntries !== "object" ||
    Array.isArray(rawEntries)
  ) {
    return null;
  }
  const rawEntryPairs = Object.entries(rawEntries as Record<string, unknown>);
  // An empty v2 manifest is ambiguous. Preserve it rather than deleting live
  // reconciliation state under a legacy filename.
  if (rawEntryPairs.length === 0) return null;
  const entries: LegacyManifestEntries = {};
  for (const [id, value] of rawEntryPairs) {
    if (isSha256(value)) {
      entries[id] = { lastSyncedHash: value };
    } else if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      isSha256((value as { lastSyncedHash?: unknown }).lastSyncedHash)
    ) {
      entries[id] = {
        lastSyncedHash: (value as { lastSyncedHash: string }).lastSyncedHash,
      };
    } else {
      // Current v2 entries include sourceRevision and customized. Unknown or
      // mixed schemas fail closed so a seed can never consume live state.
      return null;
    }
  }
  return entries;
};

const fileHash = async (filePath: string): Promise<string | null> => {
  try {
    return sha256(await fs.readFile(filePath));
  } catch {
    return null;
  }
};

/** The old whole-directory hash unit: sorted rel paths + contents, NUL-joined. */
const directoryHash = async (dir: string): Promise<string | null> => {
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

const migrateFileArea = async (
  dir: string,
  options: { replaceSuffixForModified: boolean },
): Promise<void> => {
  const entries = await readLegacyManifest(dir);
  if (!entries) return;
  for (const [id, entry] of Object.entries(entries)) {
    const filePath = path.join(dir, `${id}.md`);
    const hash = await fileHash(filePath);
    if (hash === null) continue;
    if (hash === entry.lastSyncedHash) {
      await fs.rm(filePath, { force: true });
    } else if (options.replaceSuffixForModified) {
      const replacePath = path.join(dir, `${id}.replace.md`);
      try {
        await fs.access(replacePath);
      } catch {
        await fs.rename(filePath, replacePath).catch(() => {});
      }
    }
  }
  await fs.rm(path.join(dir, BUNDLED_MANIFEST_FILENAME), { force: true });
};

const migrateSkills = async (skillsDir: string): Promise<void> => {
  const entries = await readLegacyManifest(skillsDir, "skills");
  if (!entries) return;
  for (const [id, entry] of Object.entries(entries)) {
    const skillDir = path.join(skillsDir, id);
    const hash = await directoryHash(skillDir);
    if (hash === null) continue;
    if (hash === entry.lastSyncedHash) {
      await fs.rm(skillDir, { recursive: true, force: true });
    }
    // Modified skills stay in place and win the shared-root collision policy.
  }
  await fs.rm(path.join(skillsDir, BUNDLED_MANIFEST_FILENAME), {
    force: true,
  });
};

const migratePersonality = async (stellaDataDir: string): Promise<void> => {
  const manifestPath = path.join(stellaDataDir, PERSONALITY_MANIFEST_FILENAME);
  let recorded: string | undefined;
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as {
      version?: unknown;
      entries?: Record<string, unknown>;
    };
    if (parsed.version !== 1 && parsed.version !== 2) return;
    const entry = parsed.entries?.PERSONALITY;
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).length !== 1 ||
      !isSha256((entry as { lastSyncedHash?: unknown }).lastSyncedHash)
    ) {
      // Current v2 metadata adds sourceRevision + customized. Preserve it and
      // PERSONALITY.md; this function is only for the one-field legacy shape.
      return;
    }
    recorded = (entry as { lastSyncedHash: string }).lastSyncedHash;
  } catch {
    return;
  }
  if (recorded) {
    const filePath = path.join(stellaDataDir, "PERSONALITY.md");
    const hash = await fileHash(filePath);
    if (hash !== null && hash === recorded) {
      // Unmodified: live composition from the selected preset takes over.
      await fs.rm(filePath, { force: true });
    }
  }
  await fs.rm(manifestPath, { force: true });
};

/**
 * Migrate legacy manifest-owned content without touching user memory.
 *
 * Historical local runtimes wrote MEMORY.md, memory_map.md, profile.md, and
 * other user Markdown before Cloud Home existed. The connected-account import
 * bridge claims and scans that corpus later in startup, after Electron has
 * seeded the runtime home. Deleting any of those files here would race that
 * ownership check and irreversibly erase the only copy before Cloud Home can
 * capture it. Leave all memory artifacts in place: Cloud Home is additive,
 * owner-fenced, and retains the local source after either success or failure.
 */
export const migrateLegacyHomeLayout = async (
  stellaDataDir: string,
): Promise<void> => {
  await migrateFileArea(path.join(stellaDataDir, "agents"), {
    replaceSuffixForModified: true,
  });
  await migrateFileArea(path.join(stellaDataDir, "prompts"), {
    replaceSuffixForModified: false,
  });
  await migrateSkills(path.join(stellaDataDir, "skills"));
  await migratePersonality(stellaDataDir);
};

const LEGACY_SYSTEM_DIR_NAME = "system";
const LEGACY_MIRROR_STAGING_PREFIX = ".system.next-";
const LEGACY_MIRROR_BACKUP_PREFIX = ".system.old-";

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
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

const trashPath = (stellaDataDir: string, label: string): string =>
  path.join(
    stellaDataDir,
    ".trash",
    `${label}-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`,
  );

/**
 * Retire `~/.stella/system/`, the mirror root that once held shipped skills.
 *
 * The mirror was swapped by rename, so a crash could leave the tree as staging
 * (`.system.next-*`) or as a backup with no `system/` (`.system.old-*`). Both
 * are resolved first so the migration sees the same shape as an uninterrupted
 * install. Mirrored skills the bundle still ships are skipped: the reconciler
 * installs the current copy and records it as Stella-owned, whereas copying
 * the stale mirror in would pin it as a user fork forever.
 *
 * @param bundledSkillIds ids the current bundle ships, from `skills-sync.ts`.
 * @returns the ids carried into the canonical root.
 */
export const migrateLegacySystemSkillRoot = async (
  stellaDataDir: string,
  bundledSkillIds: ReadonlySet<string>,
): Promise<{ adoptedSkillIds: string[]; archived: boolean }> => {
  const legacySystemDir = path.join(stellaDataDir, LEGACY_SYSTEM_DIR_NAME);
  const rootEntries = await fs
    .readdir(stellaDataDir, { withFileTypes: true })
    .catch(() => []);
  const backups = rootEntries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith(LEGACY_MIRROR_BACKUP_PREFIX),
    )
    .map((entry) => entry.name)
    .sort();

  if (!(await pathExists(legacySystemDir)) && backups[0]) {
    await fs
      .rename(path.join(stellaDataDir, backups[0]), legacySystemDir)
      .catch(() => {});
  }
  for (const entry of rootEntries) {
    if (
      entry.isDirectory() &&
      entry.name.startsWith(LEGACY_MIRROR_STAGING_PREFIX)
    ) {
      await fs
        .rm(path.join(stellaDataDir, entry.name), {
          recursive: true,
          force: true,
        })
        .catch(() => {});
    }
  }
  for (const name of backups) {
    await fs
      .rm(path.join(stellaDataDir, name), { recursive: true, force: true })
      .catch(() => {});
  }
  if (!(await pathExists(legacySystemDir))) {
    return { adoptedSkillIds: [], archived: false };
  }

  const legacySkillsDir = path.join(legacySystemDir, "skills");
  const skillsRoot = path.join(stellaDataDir, "skills");
  const adoptedSkillIds: string[] = [];
  for (const id of await listDirectories(legacySkillsDir)) {
    if (bundledSkillIds.has(id)) continue;
    const target = path.join(skillsRoot, id);
    if (await pathExists(target)) continue;
    await ensurePrivateDir(skillsRoot);
    await fs.cp(path.join(legacySkillsDir, id), target, { recursive: true });
    adoptedSkillIds.push(id);
  }

  const archiveRoot = trashPath(stellaDataDir, "legacy-system");
  await ensurePrivateDir(archiveRoot);
  const target = path.join(archiveRoot, LEGACY_SYSTEM_DIR_NAME);
  try {
    await fs.rename(legacySystemDir, target);
  } catch {
    await fs.cp(legacySystemDir, target, { recursive: true });
    await fs.rm(legacySystemDir, { recursive: true, force: true });
  }
  return { adoptedSkillIds, archived: true };
};
