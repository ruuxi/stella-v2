import type { UpdatePlan } from "./update-plan.js";

/**
 * The brief the app sends an agent when an update really does need a
 * judgement, carrying the state the app already established.
 *
 * It replaces a fabricated user turn. The app used to synthesize "Update
 * Stella to the latest version" into the conversation as though the user had
 * typed it, and the orchestrator then re-derived the shas, the divergence and
 * the conflicts from scratch — all of which the app had in hand. The user
 * never typed it, so nothing should claim they did: this goes straight to a
 * background agent, which writes no user row at all. That is the same rule
 * `userAuthoredPrompt` states for journal rows — visibility follows
 * authorship — rather than a second convention next to it.
 */

export type UpdateBrief = { description: string; prompt: string };

/** The draft name the top bar takes on its own; see `isUpdateDraft`. */
export const updateDraftName = (tip: string) => `update-${tip.slice(0, 12)}`;

const listing = (paths: string[], limit = 40) => {
  const shown = paths.slice(0, limit).map((path) => `- ${path}`);
  if (paths.length > limit) shown.push(`- …and ${paths.length - limit} more`);
  return shown.join("\n");
};

export const updateBrief = (
  plan: Extract<UpdatePlan, { kind: "clean" | "conflict" }>,
  head: string,
  gateOutput?: string,
): UpdateBrief => {
  const name = updateDraftName(plan.tip);
  const why =
    plan.kind === "conflict"
      ? `Git cannot merge it on its own: ${plan.conflicts.length} file(s) conflict.

Conflicting files:
${listing(plan.conflicts)}`
      : `Git merges it without a single conflict, but the merged tree fails the check the app runs before it applies an update by itself: Electron main and preload must build. Resolve what the merge got wrong, not just the symptom.

Build output:
\`\`\`
${gateOutput ?? "(not captured)"}
\`\`\``;

  return {
    description: `Merge Stella update ${plan.tip.slice(0, 7)}`,
    prompt: `An official Stella update has to be merged with this computer's own changes. The user already pressed Update, so nobody is waiting on a question — finish the draft and the app takes it by itself.

Follow the "Updates" section of the modify-stella skill. Name the draft \`${name}\`.

${why}

State the app established, so you do not have to:

- Published version (upstream): \`${plan.tip}\` — "${plan.subject}"
- Upstream ref to merge: \`refs/remotes/stella-upstream/main\` (already fetched; never fetch or pull yourself)
- This checkout's HEAD: \`${head}\`
- Upstream commit last merged here (the merge base): \`${plan.base}\`
- Commits upstream has that this checkout lacks: ${plan.count}
- This checkout has local changes of its own against that merge base: ${plan.localChanges ? "yes" : "no"}

Resolve every conflict by keeping the user's changes: take the new version's code, then carry the user's changes onto it so both work. Keep the merge commit — do not squash or rebase it.`,
  };
};
