/**
 * The one world a cloud turn runs in, and where its private state lives.
 *
 * The mount path is part of the cloud contract, not a local convention: the
 * BuildSession DO checkpoints exactly one directory per owner, so the executor
 * and the DO must agree on the path character-for-character or a turn
 * checkpoints the wrong tree.
 */

import path from "node:path";

/** The single checkpointed root, mirrored from the builder worker. */
export const WORLD_ROOT = "/workspace/world";

/** Stella's own editable renderer source, a plain directory in the world. */
export const WORLD_STELLA_ROOT = `${WORLD_ROOT}/stella`;

/**
 * Where the tool host keeps its private state (shell state, deferred-delete
 * logs, office sessions).
 *
 * It is deliberately a dot-directory inside the world root rather than a
 * sibling: `/workspace` outside the world is root-owned and holds per-turn
 * files the tool account must never write. This state is per-turn scratch that
 * happens to ride along in the checkpoint.
 */
export const toolStateDir = (root: string): string => path.join(root, ".stella");
