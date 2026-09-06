/**
 * Pure renderer for the `<skills>` block the orchestrator and general
 * agents read. The device catalog (`skill-catalog.ts`) lists skills from
 * `~/.stella/skills/`; the cloud Durable Object renders the owner's mirrored
 * catalog with the same `~/.stella/skills/<id>/SKILL.md` paths so the
 * canonical prompt's "open its SKILL.md first with `Read`" holds on both.
 */

export type RenderedSkillCatalogEntry = {
  id: string;
  description: string;
  /** Display path of the skill's `SKILL.md`, e.g. `~/.stella/skills/pdf/SKILL.md`. */
  path: string;
  hasProgram: boolean;
};

/** Canonical display root shared by device and cloud skill catalogs. */
export const SKILLS_DISPLAY_ROOT = "~/.stella/skills";

export const skillDisplayPath = (id: string): string =>
  `${SKILLS_DISPLAY_ROOT}/${id}/SKILL.md`;

export const renderInlineSkillCatalogBlock = (
  entries: readonly RenderedSkillCatalogEntry[],
): string => {
  const lines = ["<skills>", "## Skills"];

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

  lines.push("## How to use skills");
  lines.push(
    "- If a task matches a skill description, open its `SKILL.md` first with `Read`.",
  );
  lines.push(
    `- When you finish a non-trivial reusable workflow, consider saving it as a new skill under \`${SKILLS_DISPLAY_ROOT}/\`.`,
  );
  lines.push("</skills>");

  return lines.join("\n");
};
