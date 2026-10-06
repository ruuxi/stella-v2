import { git, gitRaw, isAncestor } from "./git.js";

/**
 * What taking some other version means for this checkout, decided before
 * anything is touched. The other version is the published app (upstream), the
 * same owner's other computer (the fork), or a finished draft whose base
 * moved — the question is identical in all three, so the answer is computed
 * in one place.
 *
 * The checkout only ever fast-forwards, so a branch that is not the other
 * side's ancestor cannot simply advance. That is a statement about the shape
 * of history, not about the files: a checkout whose own commits are four past
 * update-merges plus a change and its revert has diverged while its tree is
 * identical to the upstream commit it last merged. Reporting that as a
 * conflict, and handing it to an agent, is work nobody needed.
 *
 * So divergence is split by what git can actually tell us:
 *
 * - `fast-forward` — local is an ancestor of the other side. Advance.
 * - `clean` — diverged, and the three-way merge has no textual conflict.
 *   `identical` means the merged tree is byte-for-byte the other side's tree,
 *   so nothing of this checkout's own is in the result. Whether that is
 *   reason enough to skip checking the result depends on whether the other
 *   side's tree is known good, which is the caller's question, not this
 *   one's.
 * - `conflict` — real textual conflicts, naming the files. The only case
 *   where a judgement exists to make.
 *
 * Nothing here writes a ref or touches the working tree. `clean` carries the
 * merged tree, already written to the object database by `merge-tree`, which
 * is what the apply path commits.
 */

export type UpdatePlan =
  | { kind: "none" }
  | {
      kind: "fast-forward";
      /** Upstream's tip. */
      tip: string;
      /** Commits upstream has that this checkout lacks. */
      count: number;
      subject: string;
    }
  | {
      kind: "clean";
      tip: string;
      count: number;
      subject: string;
      /** The commit the two sides last shared. */
      base: string;
      /** The merge's result, written to the object database. */
      tree: string;
      /** The result is the other side's tree exactly; nothing of ours is in it. */
      identical: boolean;
      /** The checkout's tree differs from `base`: the user has real changes. */
      localChanges: boolean;
    }
  | {
      kind: "conflict";
      tip: string;
      count: number;
      subject: string;
      base: string;
      /** Files the merge could not resolve, in git's order. */
      conflicts: string[];
      localChanges: boolean;
    };

/**
 * `merge-tree --write-tree` prints the result tree, then (on conflict) one
 * `<mode> <object> <stage>\t<path>` line per conflicted stage, then a blank
 * line and git's own messages. Three stages name the same file, so the paths
 * are de-duplicated.
 */
export const conflictedPaths = (stdout: string): string[] => {
  const [stages = ""] = stdout.split("\n\n");
  const paths: string[] = [];
  for (const line of stages.split("\n").slice(1)) {
    const path = line.split("\t")[1]?.trim();
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
};

export const classifyUpdate = async (
  cwd: string,
  head: string,
  ref: string,
): Promise<UpdatePlan> => {
  const tip = (
    await gitRaw(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
  ).stdout.trim();
  if (!tip || tip === head || (await isAncestor(cwd, tip, head))) {
    return { kind: "none" };
  }
  const [count, subject] = await Promise.all([
    git(cwd, ["rev-list", "--count", `${head}..${tip}`]).then(Number),
    git(cwd, ["log", "-1", "--format=%s", tip]),
  ]);
  if (await isAncestor(cwd, head, tip)) {
    return { kind: "fast-forward", tip, count, subject };
  }
  const base = await git(cwd, ["merge-base", head, tip]);
  // One diff settles the provably-safe subcase: no net local difference from
  // the upstream commit last merged means no merge judgement exists to make.
  const localChanges =
    (await gitRaw(cwd, ["diff", "--quiet", base, head])).code !== 0;
  const merge = await gitRaw(cwd, [
    "merge-tree",
    "--write-tree",
    "--merge-base",
    base,
    head,
    tip,
  ]);
  if (merge.code === 1) {
    return {
      kind: "conflict",
      tip,
      count,
      subject,
      base,
      conflicts: conflictedPaths(merge.stdout),
      localChanges,
    };
  }
  if (merge.code !== 0) {
    throw new Error(merge.stderr.trim() || "Could not work out the merge.");
  }
  const tree = merge.stdout.split("\n")[0]!.trim();
  const upstreamTree = await git(cwd, ["rev-parse", `${tip}^{tree}`]);
  return {
    kind: "clean",
    tip,
    count,
    subject,
    base,
    tree,
    identical: tree === upstreamTree,
    localChanges,
  };
};
