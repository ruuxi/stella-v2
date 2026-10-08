/**
 * Cloud home: memory and skills, served from the owner's object. Agents and
 * Worker routes reach the same data through server-internal operations
 * (`memory.*`, `skills.*`) on `OwnerGate.homeControl`.
 *
 * Refusals carry the reason a client branches on in `BackendError.reason`:
 * `CLOUD_HOME_REVISION_CONFLICT`, `CLOUD_HOME_IDEMPOTENCY_CONFLICT`,
 * `CLOUD_MEMORY_WIPE_ACTIVE`, `CLOUD_MEMORY_EPOCH_STALE`,
 * `CLOUD_MEMORY_REIMPORT_NOT_REQUIRED`, `MEMORY_POLICY_CHANGING` (a setting
 * change is still being applied; retry with the same request id),
 * `owner_generation_stale`, and for the `memory.files.*` sync calls
 * `CLOUD_MEMORY_OFF`, `CLOUD_MEMORY_REIMPORT_REQUIRED` (memory from before a
 * wipe is uploaded only after `memory.authorizeReimport`) and
 * `CLOUD_MEMORY_FILE_REFUSED` (not a memory path, over its cap, or too large
 * to read back).
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

/**
 * One memory file in the owner's cloud, by its `~/.stella`-relative path:
 * `core-memory.md`, `PERSONALITY.md` or a Markdown file under `memories/`.
 * `sha` is the hex SHA-256 of its bytes.
 */
export type MemorySyncFile = {
  path: string;
  size: number;
  sha: string;
  updatedAt: number;
};

/** The cloud side of a desktop's memory sync, and the epoch it belongs to. */
export type MemorySyncListing = {
  memoryEpoch: string;
  importDisposition: MemoryImportDisposition;
  files: MemorySyncFile[];
};

type MemorySyncFenced = {
  /** The epoch the caller listed; a wipe since then refuses the call. */
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
   * The owner's cloud memory files, for a desktop's two-way sync. Refused
   * while memory is off or being erased.
   */
  "memory.files.list": { args: Record<string, never>; result: MemorySyncListing };
  /** One cloud memory file's text and sha; `null` when it does not exist. */
  "memory.files.read": {
    args: MemorySyncFenced & { path: string };
    result: { content: string; sha: string } | null;
  };
  /**
   * Write one cloud memory file through the shared memory rules (redaction,
   * caps), only if its sha is still `expectSha` (`null`: only if there is
   * none). `importing` marks memory this computer kept from before the
   * current epoch; after a wipe that needs `memory.authorizeReimport`.
   */
  "memory.files.write": {
    args: MemorySyncFenced & {
      path: string;
      content: string;
      expectSha: string | null;
      importing: boolean;
    };
    result:
      | { status: "written"; sha: string; bytes: number }
      | { status: "conflict"; actualSha: string | null };
  };
  /** Delete one cloud memory file, only if its sha is still `expectSha`. */
  "memory.files.delete": {
    args: MemorySyncFenced & { path: string; expectSha: string };
    result:
      | { status: "deleted" | "missing" }
      | { status: "conflict"; actualSha: string | null };
  };
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
