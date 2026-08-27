import { promises as fs } from "node:fs";
import path from "node:path";

import { extractFrontmatter } from "../frontmatter.js";
import { statSignature } from "./fs-signature.js";

export const INLINE_SKILL_CATALOG_THRESHOLD = 50;

export type SkillCatalogEntry = {
  id: string;
  name: string;
  description: string;
  path: string;
  hasProgram: boolean;
};

export type SkillCatalogPromptState = {
  mode: "inline" | "placeholder";
  totalSkills: number;
  entries: SkillCatalogEntry[];
  block: string;
};

export type SkillCatalogRenderOptions = {
  omitSkillIds?: readonly string[];
};

const SKILLS_DIR_NAME = "skills";
const SKILL_FILENAME = "SKILL.md";
const PROGRAM_FILENAME = path.join("scripts", "program.ts");

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
  const ids = await listDirectoryNames(skillsRoot);
  return ids
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

export const shouldUseAutomaticSkillExplore = async (
  stellaAppDir: string,
): Promise<boolean> => {
  const locations = await listSkillLocations(stellaAppDir);
  return locations.length > INLINE_SKILL_CATALOG_THRESHOLD;
};

const renderInlineSkillCatalogBlock = (
  entries: readonly SkillCatalogEntry[],
): string => {
  const lines = [
    "<skills>",
    "## Skills",
  ];

  if (entries.length === 0) {
    lines.push("- No saved skills yet.");
  } else {
    for (const entry of entries) {
      const suffix = entry.hasProgram ? " Includes optional `scripts/program.ts`." : "";
      lines.push(
        `- \`${entry.id}\` — ${entry.description} (path: ${entry.path})${suffix}`,
      );
    }
  }

  lines.push("## How to use skills");
  lines.push(
    "- If a task matches a skill description, open its `SKILL.md` first with `Read`.",
  );
  lines.push(
    "- When you finish a non-trivial reusable workflow, consider saving it as a new skill under `~/.stella/skills/`.",
  );
  lines.push("</skills>");

  return lines.join("\n");
};

const renderPlaceholderSkillCatalogBlock = (totalSkills: number): string =>
  [
    "<skills>",
    "## Skills",
    `- ${totalSkills} saved skills are available under \`~/.stella/skills/\`.`,
    `- The full skill catalog is omitted because it is over the inline limit (${INLINE_SKILL_CATALOG_THRESHOLD}).`,
    "- Automatic Explore fallback may surface the relevant skill paths before a General task starts.",
    "## How to use skills",
    "- If automatic findings point to a skill, or you know a likely skill path, open its `SKILL.md` first with `Read`.",
    "</skills>",
  ].join("\n");

export const buildSkillCatalogPromptState = async (
  stellaAppDir: string,
  options: SkillCatalogRenderOptions = {},
): Promise<SkillCatalogPromptState> => {
  const locations = filterSkillLocations(
    await listSkillLocations(stellaAppDir),
    options,
  );
  if (locations.length > INLINE_SKILL_CATALOG_THRESHOLD) {
    return {
      mode: "placeholder",
      totalSkills: locations.length,
      entries: [],
      block: renderPlaceholderSkillCatalogBlock(locations.length),
    };
  }

  const entries = await Promise.all(locations.map(readSkillCatalogEntry));
  return {
    mode: "inline",
    totalSkills: entries.length,
    entries,
    block: renderInlineSkillCatalogBlock(entries),
  };
};

export const renderSkillCatalogBlock = async (
  stellaAppDir: string,
  options: SkillCatalogRenderOptions = {},
): Promise<string> => {
  const state = await buildSkillCatalogPromptState(stellaAppDir, options);
  return state.block;
};

export const renderFullSkillCatalogBlock = async (
  stellaAppDir: string,
  options: SkillCatalogRenderOptions = {},
): Promise<string> => {
  const entries = await listSkillCatalogEntries(stellaAppDir, options);
  const lines = ["<skills>", "## Available skills"];
  if (entries.length === 0) {
    lines.push("- No saved skills yet.");
  } else {
    for (const entry of entries) {
      const suffix = entry.hasProgram
        ? " Includes optional `scripts/program.ts`."
        : "";
      lines.push(
        `- \`${entry.id}\` — ${entry.description} (path: ${entry.path})${suffix}`,
      );
    }
  }
  lines.push("</skills>");
  return lines.join("\n");
};
