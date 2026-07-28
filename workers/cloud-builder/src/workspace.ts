/**
 * Workspace identity for cloud turns.
 *
 * A workspace is what a turn operates on, and it decides three things that
 * must never drift apart: the sandbox mount path, the KV key its checkpoint
 * lives under, and whether the turn is dispatchable from the cloud at all.
 * Mount paths are fixed per kind — the checkpoint restored into
 * `/workspace/project` on one turn must land at the same path on the next,
 * or every absolute path the agent wrote down becomes a lie.
 */

import { sha256Hex } from "./hash.js";

export type WorkspaceKind = "drive" | "project" | "app" | "stella" | "computer";

export type ResolvedWorkspace = {
  kind: WorkspaceKind;
  /** Normalized workspace string; the value hashed into the checkpoint key. */
  canonical: string;
  /** Slug for `project:` and `app:` workspaces. */
  slug?: string;
  /** Fixed sandbox mount path. Absent for `computer`. */
  mountPath?: string;
};

const MOUNT_PATHS: Record<Exclude<WorkspaceKind, "computer">, string> = {
  drive: "/workspace/drive",
  project: "/workspace/project",
  app: "/workspace/app",
  stella: "/workspace/stella",
};

// Matches the ceiling Convex accepts (64 characters) so a slug that survived
// the spawn gate can never be rejected here as an unknown workspace.
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const resolveWorkspace = (
  raw: string | undefined,
): ResolvedWorkspace | null => {
  const value = (raw ?? "drive").trim().toLowerCase();
  if (!value) return null;
  if (value === "drive" || value === "stella") {
    return { kind: value, canonical: value, mountPath: MOUNT_PATHS[value] };
  }
  if (value === "computer") return { kind: "computer", canonical: value };
  const separator = value.indexOf(":");
  if (separator === -1) return null;
  const prefix = value.slice(0, separator);
  const slug = value.slice(separator + 1);
  if (prefix !== "project" && prefix !== "app") return null;
  if (!SLUG_PATTERN.test(slug)) return null;
  return {
    kind: prefix,
    canonical: `${prefix}:${slug}`,
    slug,
    mountPath: MOUNT_PATHS[prefix],
  };
};

/**
 * KV key for a workspace's directory backup descriptor. Owner-scoped so two
 * users' `project:orbit` never share a checkpoint.
 */
export const checkpointKey = async (
  ownerId: string,
  canonicalWorkspace: string,
): Promise<string> =>
  `ws:${await sha256Hex(`${ownerId}:${canonicalWorkspace}`)}`;

/**
 * KV key for the instance size a workspace has been observed to need. Derived
 * from the checkpoint key so the two are purged together, and so the learning
 * is owner-scoped exactly like the checkpoint it belongs to.
 */
export const instanceSizeKey = (workspaceKey: string): string =>
  `${workspaceKey}:size`;

/** Backup name derived from the checkpoint key; stable across turns. */
export const checkpointBackupName = (key: string): string =>
  `stella-${key.slice(3, 27)}`;
