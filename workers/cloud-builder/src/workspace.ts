/**
 * The one world an owner's cloud turns operate on.
 *
 * Every owner has a single checkpointed tree mounted at `/workspace/world`.
 * Each agent thread runs in a container of its own, and every one of them
 * mounts the same world there, synced with the world store at command
 * boundaries. The mount path is fixed: the checkpoint restored into
 * `/workspace/world` on one turn must land at the same path on the next, or
 * every absolute path the agent wrote down becomes a lie. `/workspace`
 * itself stays outside the checkpoint and holds per-turn files the agent
 * never owns.
 */

import { sha256Hex } from "./hash.js";
import { sandboxLifecycleId } from "./sandbox-lifecycle.js";

/** The single checkpointed mount every cloud turn runs in. */
export const WORLD_ROOT = "/workspace/world";

/** The optional user Drive materialized for a cloud turn. */
export const WORLD_DRIVE_ROOT = `${WORLD_ROOT}/drive`;

export const driveRootForWorld = (worldRoot: string): string =>
  `${worldRoot}/drive`;

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

/**
 * Stable Cloudflare Sandbox id for one agent thread's container. Keyed by the
 * thread, not the attempt, so a retry and every follow-up message to the same
 * agent come back to the same container.
 */
export const agentSandboxId = async (
  ownerId: string,
  threadId: string,
): Promise<string> =>
  await sandboxLifecycleId("agent", {
    ownerId,
    workspaceKey: await checkpointKey(ownerId),
    threadId,
  });

/**
 * Stable Cloudflare Sandbox id for the owner's own container, where Claude
 * Code signs in. No agent runs in it.
 */
export const worldSandboxId = async (ownerId: string): Promise<string> =>
  await sandboxLifecycleId("world", {
    ownerId,
    workspaceKey: await checkpointKey(ownerId),
  });

/** One command session (cwd, env, timeout) per agent turn. */
export const agentTurnSessionId = (turnId: string): string =>
  `agent-run-${turnId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 56);

/** Backup name derived from the checkpoint key; stable across turns. */
export const checkpointBackupName = (key: string): string =>
  `stella-${key.slice(3, 27)}`;
