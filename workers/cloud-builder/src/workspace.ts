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

/** The optional user Drive materialized for a cloud turn. */
export const WORLD_DRIVE_ROOT = `${WORLD_ROOT}/drive`;

/**
 * Scratch root for the legacy app-build turn. Outside the world on purpose:
 * an app build is rebuilt from its sources every time and is never restored.
 */
export const APP_BUILD_ROOT = "/workspace/app";

/** Stable owner-scoped workspace key used as the second world-name domain. */
export const checkpointKey = async (ownerId: string): Promise<string> =>
  `ws:${await sha256Hex(ownerId)}`;

/** Durable Object name for an owner's one shared cloud filesystem. */
export const worldName = async (ownerId: string): Promise<string> =>
  `${await sha256Hex(ownerId)}:${await sha256Hex(await checkpointKey(ownerId))}`;

/** Backup name derived from the checkpoint key; stable across turns. */
export const checkpointBackupName = (key: string): string =>
  `stella-${key.slice(3, 27)}`;
