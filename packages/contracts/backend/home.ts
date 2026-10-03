/**
 * Cloud home: memory and skills, served from the owner's object. Agents and
 * Worker routes reach the same data through server-internal operations
 * (`memory.*`, `skills.*`) on `OwnerGate.homeControl`.
 *
 * Refusals carry the reason a client branches on in `BackendError.reason`:
 * `CLOUD_HOME_REVISION_CONFLICT`, `CLOUD_HOME_IDEMPOTENCY_CONFLICT`,
 * `CLOUD_MEMORY_WIPE_ACTIVE`, `CLOUD_MEMORY_EPOCH_STALE`,
 * `CLOUD_MEMORY_REIMPORT_NOT_REQUIRED`, `MEMORY_POLICY_CHANGING` (a setting
 * change is still being applied; retry with the same request id), and
 * `owner_generation_stale`.
 */

import type { CloudSkillHead, CloudSkillMirrorDeletion } from "../cloud-home-sync.js";
import type { MemoryPolicy } from "../turn-plane/memory-policy.js";

export type MemoryLifecycleState = "open" | "wiping";

export type MemoryImportDisposition =
  | "automatic_allowed"
  | "explicit_required"
  | "explicit_allowed";

export type MemoryWipeStage = "sweeping" | "metadata" | "releasing" | "completed";

export type MemoryWipeJob = {
  operationId: string;
  stage: MemoryWipeStage;
  attempts: number;
  nextRetryAt: number;
  lastErrorCode?: string;
  objectsDeleted: number;
  rowsDeleted: number;
  completedAt?: number;
  updatedAt: number;
};

export type MemoryWipeStatus = {
  /** The owner the status belongs to (the caller's owner id). */
  subject: string;
  ownerGeneration: string;
  state: MemoryLifecycleState;
  memoryEpoch: string;
  importDisposition: MemoryImportDisposition;
  lastWipedEpoch?: string;
  /** The latest wipe, kept as its receipt after it completes. */
  job: MemoryWipeJob | null;
};

/**
 * The memory switch and the epoch it applies to, plus wipe and import state.
 * `ownerGeneration` is the generation the home state was last written under,
 * `""` before the first write (a new owner, or after a reset). Calls take it
 * back as `expectedOwnerGeneration`; their results carry the generation the
 * write was stamped with.
 */
export type MemoryPreference = MemoryPolicy & {
  subject: string;
  state: MemoryLifecycleState;
  importDisposition: MemoryImportDisposition;
  lastWipedEpoch?: string;
};

export type SkillMirrorDeletion = CloudSkillMirrorDeletion & {
  skillId: string;
  revision: number;
};

type MemoryEpochRequest = {
  /** Stable across retries of one user action. */
  requestId: string;
  expectedOwnerGeneration: string;
  expectedMemoryEpoch: string;
};

export type HomeCalls = {
  /** Turn cloud memory on or off. Compare-and-set on the preference revision. */
  "memory.setEnabled": {
    args: {
      requestId: string;
      memoryEnabled: boolean;
      expectedRevision: number;
      expectedOwnerGeneration: string;
    };
    result: MemoryPreference;
  };
  /** Permanently erase cloud memory and open a new memory epoch. */
  "memory.startWipe": { args: MemoryEpochRequest; result: MemoryWipeStatus };
  /** Allow local memory to be imported again after a wipe. */
  "memory.authorizeReimport": { args: MemoryEpochRequest; result: MemoryWipeStatus };
  /**
   * Tombstone a mirrored skill the device root no longer holds. A head that
   * moved past `expectedRevision` is left alone (`conflict`).
   */
  "skills.deleteMirrored": {
    args: { clientScope: string; slug: string; expectedRevision: number };
    result: SkillMirrorDeletion;
  };
};

export type HomeViews = {
  "memory.preference": { args: Record<string, never>; result: MemoryPreference };
  "memory.wipeStatus": { args: Record<string, never>; result: MemoryWipeStatus };
  /**
   * Mirror heads the device diffs its skills root against. `clientScope`
   * only partitions client caches across accounts.
   */
  "skills.heads": { args: { clientScope: string }; result: CloudSkillHead[] };
};
