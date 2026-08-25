/**
 * One-time migration from the hash-manifest home layout to the system-mirror
 * layout.
 *
 * The old layout materialized shipped content directly into the user-facing
 * directories (`agents/`, `prompts/`, `skills/`, `PERSONALITY.md`) and used
 * `.bundled-manifest.json` files recording the hash of the last synced copy to
 * decide whether the user had modified each entry. The new layout keeps
 * shipped content in `system/` (see `system-mirror.ts`) and reserves the
 * user-facing directories for customizations only.
 *
 * This is the only place the old hashes are ever consulted again:
 * - unmodified entries (hash matches the manifest) are deleted — the mirror
 *   now provides them;
 * - modified agent prompts become `<id>.replace.md` (full replacement,
 *   opts out of updates);
 * - modified prompts / skills / PERSONALITY.md stay where they are — in the
 *   new layout their presence already means "user replacement / fork";
 * - the manifests and the old applied-state machinery are removed.
 *
 * Entries with no manifest record were always user-owned and are untouched.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const BUNDLED_MANIFEST_FILENAME = ".bundled-manifest.json";
const PERSONALITY_MANIFEST_FILENAME = ".personality-manifest.json";

type LegacyManifestEntries = Record<string, { lastSyncedHash: string }>;

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
  const rawEntries =
    record.entries ?? (legacyEntriesKey ? record[legacyEntriesKey] : undefined);
  if (!rawEntries || typeof rawEntries !== "object") return null;
  const entries: LegacyManifestEntries = {};
  for (const [id, value] of Object.entries(
    rawEntries as Record<string, unknown>,
  )) {
    if (typeof value === "string") {
      entries[id] = { lastSyncedHash: value };
    } else if (
      value &&
      typeof value === "object" &&
      typeof (value as { lastSyncedHash?: unknown }).lastSyncedHash === "string"
    ) {
      entries[id] = {
        lastSyncedHash: (value as { lastSyncedHash: string }).lastSyncedHash,
      };
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
    // Modified skills stay in place: in the new layout a user skill dir
    // shadows the mirrored one with the same id.
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
      entries?: Record<string, { lastSyncedHash?: string }>;
    };
    recorded = parsed.entries?.PERSONALITY?.lastSyncedHash;
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

/** Remove files owned by the retired automatic memory-consolidation pipeline. */
export const retireAutomaticMemoryArtifacts = async (
  stellaDataDir: string,
): Promise<void> => {
  await Promise.all(
    [
      path.join(stellaDataDir, "DREAM.md"),
      path.join(stellaDataDir, "memories", "MEMORY.md"),
      path.join(stellaDataDir, "memories", "memory_map.md"),
      path.join(stellaDataDir, "memories", "memory_summary.md"),
    ].map((filePath) => fs.rm(filePath, { force: true })),
  );
};

/**
 * Always retire known automatic-memory artifacts, then migrate legacy
 * manifest-owned content. Homes without legacy manifests remain a fast no-op
 * after the idempotent cleanup.
 */
export const migrateLegacyHomeLayout = async (
  stellaDataDir: string,
): Promise<void> => {
  await retireAutomaticMemoryArtifacts(stellaDataDir);
  await migrateFileArea(path.join(stellaDataDir, "agents"), {
    replaceSuffixForModified: true,
  });
  await migrateFileArea(path.join(stellaDataDir, "prompts"), {
    replaceSuffixForModified: false,
  });
  await migrateSkills(path.join(stellaDataDir, "skills"));
  await migratePersonality(stellaDataDir);
  // Old applied-state machinery: superseded by system/revision.json.
  await fs.rm(path.join(stellaDataDir, "cache", "prompt-applied-state"), {
    recursive: true,
    force: true,
  });
  await fs.rm(path.join(stellaDataDir, "cache", "prompt-applied-state.json"), {
    force: true,
  });
  await fs.rm(path.join(stellaDataDir, "cache", "prompt-apply-lock.sqlite"), {
    force: true,
  });
};
