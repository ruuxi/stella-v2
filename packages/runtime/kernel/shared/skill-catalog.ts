import { promises as fs } from "node:fs";
import path from "node:path";

import { extractFrontmatter } from "../frontmatter.js";
import { statSignature } from "./fs-signature.js";
import { renderInlineSkillCatalogBlock } from "./skill-catalog-render.js";

export type SkillCatalogEntry = {
  id: string;
  name: string;
  description: string;
  path: string;
  hasProgram: boolean;
};

export type SkillCatalogRenderOptions = {
  omitSkillIds?: readonly string[];
};

const SKILLS_DIR_NAME = "skills";
const SKILL_FILENAME = "SKILL.md";
const PROGRAM_FILENAME = path.join("scripts", "program.ts");

/**
 * Every installed skill, shipped or user-created, resolves from the single
 * `~/.stella/skills/` root. Shipped skills are reconciled into it by content
 * hash (see `home/skills-sync.ts`); a collision or a local edit makes that
 * skill user-owned, so there is no second root to shadow.
 */
type SkillLocation = { id: string; dir: string; displayPath: string };

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /[\p{L}\p{N}]/u.test(trimmed) ? trimmed : null;
};

const parseLooseHeader = (
  content: string,
): {
  name?: string;
  description?: string;
} => {
  const out: { name?: string; description?: string } = {};
  const lines = content.split(/\r?\n/u).slice(0, 16);
  for (const line of lines) {
    const match = line.match(
      /^\s*(?:#+\s*)?(name|description)\s*:\s*(.+?)\s*$/iu,
    );
    if (!match) continue;
    const key = match[1]?.toLowerCase();
    const value = match[2]?.trim();
    if (!key || !value) continue;
    if (key === "name") out.name = value;
    if (key === "description") out.description = value;
  }
  return out;
};

const listDirectoryNames = async (root: string): Promise<string[]> => {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
};

const listSkillLocations = async (
  stellaAppDir: string,
): Promise<SkillLocation[]> => {
  const skillsRoot = path.join(stellaAppDir, SKILLS_DIR_NAME);
  // Dot-prefixed entries are reconciliation staging/backup dirs, never skills.
  return (await listDirectoryNames(skillsRoot))
    .filter((id) => !id.startsWith("."))
    .map((id) => ({
      id,
      dir: path.join(skillsRoot, id),
      displayPath: path.posix.join(
        "~/.stella",
        SKILLS_DIR_NAME,
        id,
        SKILL_FILENAME,
      ),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
};

const filterSkillLocations = (
  locations: readonly SkillLocation[],
  options: SkillCatalogRenderOptions = {},
): SkillLocation[] => {
  const omitted = new Set(options.omitSkillIds ?? []);
  if (omitted.size === 0) return [...locations];
  return locations.filter((location) => !omitted.has(location.id));
};

// Per-SKILL.md cache so an unchanged skill is never re-read or re-parsed on a
// later turn. The directory listing still runs each turn (cheap, and needed to
// detect added/removed skills); only the file read + frontmatter parse is gated
// behind an mtime+size signature that also folds in `scripts/program.ts`
// presence (a program add/remove changes the rendered entry).
const skillEntryCache = new Map<
  string,
  { sig: string; entry: SkillCatalogEntry }
>();

const readSkillCatalogEntry = async (
  location: SkillLocation,
): Promise<SkillCatalogEntry> => {
  const skillId = location.id;
  const skillPath = path.join(location.dir, SKILL_FILENAME);
  const programPath = path.join(location.dir, PROGRAM_FILENAME);

  const [skillSig, hasProgram] = await Promise.all([
    statSignature(skillPath),
    fs
      .stat(programPath)
      .then(() => true)
      .catch(() => false),
  ]);

  const sig = `${skillSig ?? "missing"}:${hasProgram}`;
  const cached = skillEntryCache.get(skillPath);
  if (cached && cached.sig === sig) {
    return cached.entry;
  }

  const docs =
    skillSig === null
      ? ""
      : await fs.readFile(skillPath, "utf-8").catch(() => "");

  const parsed = docs ? extractFrontmatter(docs) : { metadata: {}, body: "" };
  const looseHeader = docs ? parseLooseHeader(docs) : {};
  const name =
    asNonEmptyString(parsed.metadata.name) ??
    asNonEmptyString(looseHeader.name) ??
    skillId;
  const description =
    asNonEmptyString(parsed.metadata.description) ??
    asNonEmptyString(looseHeader.description) ??
    skillId;

  const entry: SkillCatalogEntry = {
    id: skillId,
    name,
    description,
    path: location.displayPath,
    hasProgram,
  };
  skillEntryCache.set(skillPath, { sig, entry });
  return entry;
};

export const listSkillCatalogEntries = async (
  stellaAppDir: string,
  options: SkillCatalogRenderOptions = {},
): Promise<SkillCatalogEntry[]> => {
  const locations = filterSkillLocations(
    await listSkillLocations(stellaAppDir),
    options,
  );
  return await Promise.all(locations.map(readSkillCatalogEntry));
};

export const renderSkillCatalogBlock = async (
  stellaAppDir: string,
  options: SkillCatalogRenderOptions = {},
): Promise<string> =>
  renderInlineSkillCatalogBlock(
    await listSkillCatalogEntries(stellaAppDir, options),
  );
