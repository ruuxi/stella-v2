import type { UpdatePlan } from "./update-plan.js";

/**
 * The briefs the app sends an agent when git work it pressed a button for
 * genuinely needs a judgement, carrying the state the app already established.
 *
 * These replace fabricated user turns. The app used to synthesize sentences
 * like "Update Stella to the latest version" and "Merge the changes from my
 * other computer." into the conversation as though the user had typed them,
 * and the orchestrator then re-derived the shas, the divergence and the
 * conflicts from scratch — all of which the app had in hand. Worse, the user
 * saw themselves asking for something they never asked for: they pressed a
 * button. So nothing claims they typed anything. Each of these goes straight
 * to a background agent, which writes no user row at all, which is the rule
 * `userAuthoredPrompt` already states for journal rows — visibility follows
 * authorship — rather than a second convention beside it.
 *
 * Every brief ends up in the same place: a finished draft, which then waits
 * in Updates until the user adds it. What differs is what the agent is
 * reconciling.
 */

export type AgentBrief = { description: string; prompt: string };

/**
 * The name for a merge the app dispatched. The `update-`
 * prefix is what `isStellaDraft` reads: such a draft is Stella settling its
 * own version, so it stays out of the chat and off the user's other
 * computers as a change of theirs.
 */
export const mergeDraftName = (tip: string) => `update-${tip.slice(0, 12)}`;

const listing = (paths: string[], limit = 40) => {
  const shown = paths.slice(0, limit).map((path) => `- ${path}`);
  if (paths.length > limit) shown.push(`- …and ${paths.length - limit} more`);
  return shown.join("\n");
};

/** Why a merge reached an agent: it conflicts, or its result does not build. */
const reason = (
  plan: Extract<UpdatePlan, { kind: "clean" | "conflict" }>,
  gateOutput: string | undefined,
  what: string,
) =>
  plan.kind === "conflict"
    ? `Git cannot merge it on its own: ${plan.conflicts.length} file(s) conflict.

Conflicting files:
${listing(plan.conflicts)}`
    : `Git merges it without a single conflict, but the merged tree fails the check the app runs before it applies ${what} by itself: Electron main and preload must build. Resolve what the merge got wrong, not just the symptom.

Build output:
\`\`\`
${gateOutput ?? "(not captured)"}
\`\`\``;

const state = (
  plan: Extract<UpdatePlan, { kind: "clean" | "conflict" }>,
  head: string,
  theirs: { label: string; ref: string },
) => `State the app established, so you do not have to:

- ${theirs.label}: \`${plan.tip}\` — "${plan.subject}"
- Ref to merge: \`${theirs.ref}\` (already fetched; never fetch or pull yourself)
- This checkout's HEAD: \`${head}\`
- Commit the two sides last shared (the merge base): \`${plan.base}\`
- Commits that side has that this checkout lacks: ${plan.count}
- This checkout has changes of its own against that merge base: ${plan.localChanges ? "yes" : "no"}`;

const KEEP_MERGE = `Keep the merge commit — do not squash or rebase it.`;

export const upstreamMergeBrief = (
  plan: Extract<UpdatePlan, { kind: "clean" | "conflict" }>,
  head: string,
  gateOutput?: string,
): AgentBrief => ({
  description: `Merge Stella update ${plan.tip.slice(0, 7)}`,
  prompt: `An official Stella update has to be merged with this computer's own changes. The user already pressed Update, so nobody is waiting on a question — finish the draft. It then waits in Updates until they add it, so Stella never relaunches under them.

Follow the "Updates" section of the modify-stella skill. Name the draft \`${mergeDraftName(plan.tip)}\`.

${reason(plan, gateOutput, "an update")}

${state(plan, head, {
  label: "Published version (upstream)",
  ref: "refs/remotes/stella-upstream/main",
})}

Resolve every conflict by keeping the user's changes: take the new version's code, then carry the user's changes onto it so both work. ${KEEP_MERGE}`,
});

export const remoteMergeBrief = (
  plan: Extract<UpdatePlan, { kind: "clean" | "conflict" }>,
  head: string,
  forkRef: string,
  gateOutput?: string,
): AgentBrief => ({
  description: `Merge changes from another computer ${plan.tip.slice(0, 7)}`,
  prompt: `The user changed Stella on another of their computers, and that change has to be merged with this computer's own changes. They already pressed the button to add it here, so nobody is waiting on a question — finish the draft. It then waits in Updates until they add it, so Stella never relaunches under them.

Follow the "Rebase, merge, or undo for the user" section of the modify-stella skill, the "changes from another computer diverged" case. Name the draft \`${mergeDraftName(plan.tip)}\`.

${reason(plan, gateOutput, "a change from another computer")}

${state(plan, head, {
  label: "The other computer's version (the fork)",
  ref: forkRef,
})}

Both sides are the user's own work, so neither wins by default: keep what each one was for. ${KEEP_MERGE}`,
});

/**
 * A finished draft whose base moved under it. The agent brings it up to date
 * on the branch it is already on; it then waits in Updates for the user to
 * add, since taking it can relaunch Stella.
 */
export const staleDraftBrief = (
  plan: Extract<UpdatePlan, { kind: "clean" | "conflict" }>,
  head: string,
  name: string,
  gateOutput?: string,
): AgentBrief => ({
  description: `Bring the draft "${name}" up to date`,
  prompt: `A finished change of the user's was made against an older version of Stella and no longer fits the current one. They pressed Update on it, so they want it — bring it up to date and leave it finished on its own branch, \`draft/${name}\`. It then waits in Updates until they add it.

Follow the "Rebase, merge, or undo for the user" section of the modify-stella skill, the "stale draft" case: \`git worktree add "$STELLA_DRAFTS_DIR/${name}" draft/${name}\` (no \`-b\`), rebase onto the checkout's current branch, resolve, check, finish.

${reason(plan, gateOutput, "a change")}

${state(plan, head, {
  label: `The draft's tip (draft/${name})`,
  ref: `refs/heads/draft/${name}`,
})}

Keep what the change was for: take the current version's code, then carry the change onto it so it still does what it set out to do.`,
});

/**
 * An undo later changes conflict with, or one that leaves Stella unable to
 * build. Unlike the merges above, the result is not taken by the app:
 * removing a change that other work was built on top of has no single right
 * answer, so the user sees what it came to and applies it themselves.
 */
export const undoBrief = (args: {
  sha: string;
  /** The change is the commits in `base..sha`, which arrived together. */
  base: string;
  subject: string;
  head: string;
  conflicts: string[];
  /** The build's complaint, when taking the change out lifts cleanly but breaks the build. */
  buildOutput?: string;
}): AgentBrief => ({
  description: `Undo "${args.subject}"`,
  prompt: `The user asked to undo a change to Stella, and it cannot be lifted out mechanically: ${
    args.buildOutput !== undefined
      ? "taking it out leaves Electron main or preload unable to build, so work that came after it depends on it."
      : "work that came after it builds on it."
  }

Follow the "Rebase, merge, or undo for the user" section of the modify-stella skill, the "undo that conflicts or doesn't build" case: start a draft, \`git revert --no-edit ${args.base}..${args.sha}\`, resolve, check, finish. Finish it the normal way and tell the user it is ready — this one they apply themselves, because what to keep of the later work is a judgement and they should see it first.

State the app established, so you do not have to:

- Change to undo: the commits in \`${args.base}..${args.sha}\` (they arrived together) — "${args.subject}"
- This checkout's HEAD: \`${args.head}\`
- Files later work and this undo disagree about: ${args.conflicts.length}

${
  args.conflicts.length > 0
    ? `Disagreeing files:
${listing(args.conflicts)}

`
    : ""
}${
  args.buildOutput !== undefined
    ? `The build of HEAD with the change taken out:

\`\`\`
${args.buildOutput}
\`\`\`

`
    : ""
}Take out what the change did, and keep the later work that was built on it working. If the two are genuinely incompatible, say so in your completion rather than quietly dropping either.`,
});
