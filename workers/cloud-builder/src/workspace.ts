/**
 * The one world an owner's cloud turns operate on.
 *
 * Every owner has a single checkpointed tree mounted at `/workspace/world`.
 * The mount path is fixed: the checkpoint restored into `/workspace/world` on
 * one turn must land at the same path on the next, or every absolute path the
 * agent wrote down becomes a lie. `/workspace` itself stays outside the
 * checkpoint and holds per-turn files the agent never owns.
 */

import { sha256Hex } from "./hash.js";

/** The single checkpointed mount every cloud turn runs in. */
export const WORLD_ROOT = "/workspace/world";

/** Stella's own editable renderer source, a plain directory inside the world. */
export const WORLD_STELLA_ROOT = `${WORLD_ROOT}/stella`;

/**
 * Scratch root for the legacy app-build turn. Outside the world on purpose:
 * an app build is rebuilt from its sources every time and is never restored.
 */
export const APP_BUILD_ROOT = "/workspace/app";

/**
 * KV key for an owner's world checkpoint descriptor. Owner-scoped: two users
 * never share a checkpoint, and one user never has two.
 */
export const checkpointKey = async (ownerId: string): Promise<string> =>
  `ws:${await sha256Hex(ownerId)}`;

/**
 * KV key for the instance size the world has been observed to need. Derived
 * from the checkpoint key so the two are purged together, and so the learning
 * is owner-scoped exactly like the checkpoint it belongs to.
 */
export const instanceSizeKey = (workspaceKey: string): string =>
  `${workspaceKey}:size`;

/** Backup name derived from the checkpoint key; stable across turns. */
export const checkpointBackupName = (key: string): string =>
  `stella-${key.slice(3, 27)}`;
