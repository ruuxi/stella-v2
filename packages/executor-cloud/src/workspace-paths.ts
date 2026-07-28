/**
 * Workspace identity → sandbox mount path.
 *
 * The mount paths are part of the cloud contract, not a local convention:
 * the BuildSession DO checkpoints exactly one directory per (owner,
 * workspace) pair, so the executor and the DO must agree on the path
 * character-for-character or a turn checkpoints the wrong tree.
 */

import path from "node:path";

export type WorkspaceKind = "drive" | "project" | "app" | "stella";

const WORKSPACE_ROOTS: Record<WorkspaceKind, string> = {
  drive: "/workspace/drive",
  project: "/workspace/project",
  app: "/workspace/app",
  stella: "/workspace/stella",
};

export type WorkspaceIdentity = {
  /** The raw workspace value from the turn input, e.g. `project:stella-v2`. */
  workspace: string;
  kind: WorkspaceKind;
  /** Slug for `project:<slug>` / `app:<slug>`; empty for the singletons. */
  slug: string;
  root: string;
};

/**
 * Drive folder a workspace's deliverables are filed under. The drive is one
 * flat namespace per owner (contract C3), so two workspaces that both produce
 * `report.md` would otherwise overwrite each other.
 */
export const drivePrefixFor = (identity: WorkspaceIdentity): string => {
  switch (identity.kind) {
    case "drive":
      return "";
    case "project":
      return `projects/${identity.slug}/`;
    case "app":
      return `apps/${identity.slug}/`;
    case "stella":
      return "stella/";
  }
};

/**
 * Where the tool host keeps its private state (shell state, deferred-delete
 * logs, office sessions) for this workspace.
 *
 * A project workspace root IS the user's git checkout and the agent is told to
 * commit its work there, so its state dir sits beside the checkout instead of
 * inside it — nothing Stella writes for its own bookkeeping belongs in a
 * commit the user reviews. It is deliberately outside the checkpointed root:
 * this state is per-turn scratch, not workspace content.
 */
export const toolStateDirFor = (identity: WorkspaceIdentity): string =>
  identity.kind === "project"
    ? path.join(path.dirname(identity.root), ".stella-state")
    : path.join(identity.root, ".stella");

/**
 * Resolve the turn's workspace to its fixed mount. `computer` is a desktop-only
 * placement and is rejected rather than silently mapped somewhere writable.
 */
export const resolveWorkspace = (
  workspace: string | undefined,
  fallbackRoot: string,
): WorkspaceIdentity => {
  const value = (workspace ?? "").trim();
  if (value === "computer") {
    throw new Error("The computer workspace cannot run in the cloud.");
  }
  if (value === "drive" || value === "stella") {
    return {
      workspace: value,
      kind: value,
      slug: "",
      root: WORKSPACE_ROOTS[value],
    };
  }
  for (const kind of ["project", "app"] as const) {
    if (value.startsWith(`${kind}:`)) {
      const slug = value.slice(kind.length + 1).trim();
      if (!slug) throw new Error(`Workspace "${value}" has no slug.`);
      return { workspace: value, kind, slug, root: WORKSPACE_ROOTS[kind] };
    }
  }
  // An unrecognized workspace still has to land somewhere the DO checkpoints,
  // and the DO passes its own root through the environment.
  return {
    workspace: value || "drive",
    kind: "drive",
    slug: "",
    root: fallbackRoot,
  };
};
