/**
 * The owner's mirrored skills as the orchestrator sees them on every host:
 * a `<skills>` block listing `~/.stella/skills/<slug>/SKILL.md` paths, read
 * with the ordinary `Read` tool. The cloud store pins one version of each
 * skill for the whole turn and verifies every file it hands back.
 */

import {
  renderInlineSkillCatalogBlock,
  SKILLS_DISPLAY_ROOT,
  skillDisplayPath,
} from "@stella/runtime/kernel/shared/skill-catalog-render.js";
import type {
  CloudHomeStore,
  CloudSkillCatalogEntry,
  CloudSkillCatalogSnapshot,
} from "./cloud-home-store.js";

const SKILL_PROGRAM_PATH = "scripts/program.ts";

/** The `<skills>` block for a pinned cloud catalog; "" when there is none. */
export const buildCloudSkillsBlock = (
  snapshot: CloudSkillCatalogSnapshot,
): string => {
  if (snapshot.entries.length === 0) return "";
  return renderInlineSkillCatalogBlock(
    snapshot.entries.map((entry) => ({
      id: entry.slug,
      description: entry.description,
      path: skillDisplayPath(entry.slug),
      hasProgram: entry.files.some((file) => file.path === SKILL_PROGRAM_PATH),
    })),
  );
};

export type CloudSkillFileRef = Readonly<{
  entry: CloudSkillCatalogEntry;
  /** Package-relative path inside the pinned skill version. */
  path: string;
}>;

const SKILL_PATH_PREFIXES = [
  `${SKILLS_DISPLAY_ROOT}/`,
  "/.stella/skills/",
];

/**
 * Resolve a `Read` path against the pinned catalog. Accepts the display
 * form (`~/.stella/skills/<slug>/...`) and any absolute path that ends in
 * `/.stella/skills/<slug>/...` (a model echoing a home directory it saw
 * elsewhere). Returns null for paths outside the skills tree.
 */
export const resolveCloudSkillPath = (
  snapshot: CloudSkillCatalogSnapshot,
  filePath: string,
): { ref: CloudSkillFileRef | null; skillsPath: boolean } => {
  const raw = filePath.trim().replace(/\\/g, "/");
  let rest: string | null = null;
  for (const prefix of SKILL_PATH_PREFIXES) {
    const index = raw.indexOf(prefix);
    if (index === 0 || (index > 0 && prefix.startsWith("/"))) {
      rest = raw.slice(index + prefix.length);
      break;
    }
  }
  if (rest === null) return { ref: null, skillsPath: false };
  const segments = rest.split("/").filter((segment) => segment.length > 0);
  const slug = segments.shift();
  if (!slug || segments.some((segment) => segment === "..")) {
    return { ref: null, skillsPath: true };
  }
  const entry = snapshot.entries.find((candidate) => candidate.slug === slug);
  if (!entry) return { ref: null, skillsPath: true };
  const path = segments.length === 0 ? "SKILL.md" : segments.join("/");
  return { ref: { entry, path }, skillsPath: true };
};

export const readCloudSkillFile = async (
  home: CloudHomeStore,
  snapshot: CloudSkillCatalogSnapshot,
  ref: CloudSkillFileRef,
): Promise<string> => home.readSkillText(snapshot, ref.entry.skillId, ref.path);
