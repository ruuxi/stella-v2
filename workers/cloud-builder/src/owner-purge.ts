/**
 * One pass of an owner's reset or account deletion, run by the owner's own
 * object (`OwnerGate.closeOwner` and the `account.purge` job).
 *
 * It is the worker's `/owners/purge/begin` → `/owners/purge` →
 * `/owners/purge/release` sequence without Convex driving it: fence the owner
 * and cancel its running turns, purge durable turn state, the hosted browser
 * profile, every owner-store domain (`purgeOwnerData`) and the owner's R2 and
 * KV stores, then lift a reset's fence. Deletion keeps its fence for good.
 *
 * Every step is "delete if present", so a pass with `pending` stores is
 * simply run again with the same `requestId`, which rejoins the same fence.
 */

import type { Env } from "./build-session/shared/env.js";
import { errorMessage, log } from "./build-session/shared/keys.js";
import {
  beginOwnerPurge,
  callOwnerFence,
  purgeOwnerStorage,
} from "./build-session/owner-purge-transfer.js";
import type { OwnerPurgeMode } from "./owner-store/registry.js";

export type OwnerPurgePass = {
  /** Stores this pass did not finish. Empty means the purge is complete. */
  pending: string[];
};

const purgeTurnState = async (env: Env, ownerId: string, generation: string): Promise<boolean> => {
  try {
    const response = await callOwnerFence(env, ownerId, "turn-state/purge", { schemaVersion: 1, generation });
    const result = (await response.json().catch(() => null)) as { pending?: unknown } | null;
    return !response.ok || result?.pending !== false;
  } catch (error) {
    log("error", "owner_storage_purge_step_failed", { store: "turn-state", message: errorMessage(error) });
    return true;
  }
};

const purgeBrowserProfile = async (env: Env, ownerId: string): Promise<boolean> => {
  if (!env.BROWSER_GATEWAY) return true;
  const requestId = crypto.randomUUID();
  try {
    const response = await env.BROWSER_GATEWAY.fetch("https://browser-gateway/internal/owners/purge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, ownerId, requestId }),
    });
    const result = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return !(response.ok && result?.requestId === requestId && result.purged === true);
  } catch {
    log("error", "owner_storage_purge_step_failed", { store: "browser-profile:default" });
    return true;
  }
};

export const runOwnerPurge = async (input: {
  env: Env;
  ownerId: string;
  mode: OwnerPurgeMode;
  /** Stable for one reset or deletion, so a retry rejoins its fence. */
  requestId: string;
  purgeOwnerData: () => Promise<{ pending: string[] }>;
}): Promise<OwnerPurgePass> => {
  const { env, ownerId, mode } = input;
  const { generation } = await beginOwnerPurge(
    env,
    ownerId,
    mode === "delete" ? "permanent" : "temporary",
    input.requestId,
  );
  const pending: string[] = [];
  if (await purgeTurnState(env, ownerId, generation)) pending.push("turn-state");
  if (await purgeBrowserProfile(env, ownerId)) pending.push("browser-profile:default");
  try {
    const ownerData = await input.purgeOwnerData();
    pending.push(...ownerData.pending.map((domain) => `owner-data:${domain}`));
  } catch (error) {
    pending.push("owner-data");
    log("error", "owner_storage_purge_step_failed", { store: "owner-data", message: errorMessage(error) });
  }
  const storage = await purgeOwnerStorage(env, ownerId, { ownerId, purgeGeneration: generation, mode });
  pending.push(...storage.pending);
  if (pending.length === 0 && mode === "reset") {
    const released = await callOwnerFence(env, ownerId, "release", { generation });
    if (!released.ok) pending.push("fence");
  }
  log("info", "owner_purge_pass", { mode, deleted: storage.deleted, pending });
  return { pending };
};
