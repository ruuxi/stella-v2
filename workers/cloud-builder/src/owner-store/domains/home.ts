/**
 * Cloud home: the owner's memory policy and mirrored skills metadata. Skill
 * bytes stay in `AGENT_HOME`, under `agent-home/<sha256(owner)>/generations/
 * <sha256(generation)>/`. Memory itself is plain files in the owner's world
 * (`world-memory.ts`); this domain only governs it.
 *
 * - **Memory policy:** one `home_state` row holds the memory switch, the
 *   memory epoch and the wipe/import state. Changes to the switch and wipes go
 *   through the gate's `OwnerMemoryPolicy` (it closes model grants first), whose
 *   transport is `readMemoryPolicy` / `applyMemoryPolicyChange` below.
 * - **Skill writes are R2-first:** `skills.begin` reserves exact object keys
 *   and digests, the caller uploads and verifies those bytes, and
 *   `skills.commit` advances the head. Reservations that never commit are
 *   reclaimed by `home.intentSweep`.
 * - **Wipe:** `home.memoryWipe` erases the memory files from the owner's
 *   world, then opens a new memory epoch.
 * - **Desktop sync:** `memory.files.*` let each of the owner's computers keep
 *   its `~/.stella` memory the same as the world's, by compare-and-set, only
 *   while memory is on, and only in the epoch the computer listed. Memory a
 *   computer kept from before a wipe goes up only once the owner allowed it
 *   (`memory.authorizeReimport`).
 * - **Context:** every skill or policy change bumps `content_revision` and
 *   tells the gate (`host.homeChanged`) so cached turn context is rebuilt.
 */

import type {
  CloudSkillHead,
} from "@stella/contracts/cloud-home-sync";
import type {
  HomeCalls,
  MemoryImportDisposition,
  MemoryLifecycleState,
  MemoryPreference,
  MemoryWipeStage,
  MemoryWipeStatus,
  SkillMirrorDeletion,
} from "@stella/contracts/backend/home";
import type {
  MemoryPolicy,
  MemoryPolicyChange,
} from "@stella/contracts/turn-plane/memory-policy";
import { isSyncedMemoryPath } from "@stella/runtime/kernel/memory/memory-client.js";
import { sha256BytesHex, sha256Hex } from "../../hash.js";
import {
  MemorySyncFileError,
  createWorldMemoryFile,
  createWorldMemorySync,
  ownerMemoryWorld,
  wipeWorldMemory,
} from "../../world-memory.js";
import {
  array,
  boolean,
  empty,
  literal,
  nullable,
  number,
  object,
  string,
} from "../args.js";
import { RpcError } from "../errors.js";
import type {
  InternalDef,
  OwnerContext,
  OwnerDb,
  OwnerDbReader,
  OwnerDomain,
} from "../registry.js";

// ── Limits ────────────────────────────────────────────────────────────────

const WRITE_INTENT_TTL_MS = 15 * 60_000;
/** Bytes a writer reserved may land a little after its reservation expired. */
const INTENT_SWEEP_GRACE_MS = 5 * 60_000;
const MAX_SKILLS = 50;
const SKILL_MAX_FILES = 256;
const SKILL_MAX_FILE_BYTES = 5 * 1024 * 1024;
const SKILL_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const WIPE_RETRY_MAX_MS = 15 * 60_000;
/** Before any write, every owner starts in this epoch. Opaque, never ordered. */
const INITIAL_MEMORY_EPOCH = "initial";

const SHA256 = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SKILL_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

const WIPE_JOB = "home.memoryWipe";
const INTENT_SWEEP_JOB = "home.intentSweep";
const INTENT_SWEEP_JOB_ID = "home.intentSweep";
const wipeJobId = (operationId: string) => `${WIPE_JOB}:${operationId}`;

export const HOME_MIGRATION = {
  id: "home.1-init",
  statements: [
    `CREATE TABLE home_state (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       owner_generation TEXT NOT NULL,
       memory_enabled INTEGER NOT NULL,
       policy_revision INTEGER NOT NULL,
       policy_request_id TEXT,
       policy_request_revision INTEGER,
       policy_request_enabled INTEGER,
       policy_updated_at INTEGER NOT NULL,
       memory_epoch TEXT NOT NULL,
       memory_state TEXT NOT NULL,
       import_disposition TEXT NOT NULL,
       last_wiped_epoch TEXT,
       reimport_request_id TEXT,
       content_revision INTEGER NOT NULL
     )`,
    `CREATE TABLE memory_wipe (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       operation_id TEXT NOT NULL,
       request_id TEXT NOT NULL,
       owner_generation TEXT NOT NULL,
       target_epoch TEXT NOT NULL,
       next_epoch TEXT NOT NULL,
       stage TEXT NOT NULL,
       attempts INTEGER NOT NULL,
       next_retry_at INTEGER NOT NULL,
       last_error_code TEXT,
       objects_deleted INTEGER NOT NULL,
       rows_deleted INTEGER NOT NULL,
       completed_at INTEGER,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE TABLE skills (
       skill_id TEXT PRIMARY KEY,
       slug TEXT NOT NULL UNIQUE,
       name TEXT NOT NULL,
       description TEXT NOT NULL,
       source TEXT NOT NULL,
       availability TEXT NOT NULL,
       version_id TEXT,
       revision INTEGER NOT NULL,
       deleted_at INTEGER,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE TABLE skill_versions (
       version_id TEXT PRIMARY KEY,
       skill_id TEXT NOT NULL,
       owner_generation TEXT NOT NULL,
       revision INTEGER NOT NULL,
       base_version_id TEXT,
       manifest_r2_key TEXT NOT NULL,
       manifest_sha256 TEXT NOT NULL,
       tree_sha256 TEXT NOT NULL,
       file_count INTEGER NOT NULL,
       total_size_bytes INTEGER NOT NULL,
       source TEXT NOT NULL,
       idempotency_key TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
    `CREATE INDEX skill_versions_manifest ON skill_versions (manifest_r2_key)`,
    `CREATE TABLE skill_files (
       version_id TEXT NOT NULL,
       path TEXT NOT NULL,
       skill_id TEXT NOT NULL,
       r2_key TEXT NOT NULL,
       sha256 TEXT NOT NULL,
       size_bytes INTEGER NOT NULL,
       content_type TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       PRIMARY KEY (version_id, path)
     )`,
    `CREATE INDEX skill_files_key ON skill_files (r2_key)`,
    `CREATE TABLE skill_write_intents (
       intent_id TEXT PRIMARY KEY,
       idempotency_key TEXT NOT NULL UNIQUE,
       owner_generation TEXT NOT NULL,
       skill_id TEXT NOT NULL,
       slug TEXT NOT NULL,
       name TEXT NOT NULL,
       description TEXT NOT NULL,
       source TEXT NOT NULL,
       availability TEXT NOT NULL,
       base_revision INTEGER NOT NULL,
       base_version_id TEXT,
       version_id TEXT NOT NULL,
       next_revision INTEGER NOT NULL,
       manifest_r2_key TEXT NOT NULL,
       manifest_sha256 TEXT NOT NULL,
       tree_sha256 TEXT NOT NULL,
       file_count INTEGER NOT NULL,
       total_size_bytes INTEGER NOT NULL,
       files_json TEXT NOT NULL,
       status TEXT NOT NULL,
       conflict_revision INTEGER,
       conflict_version_id TEXT,
       expires_at INTEGER NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE INDEX skill_write_intents_open ON skill_write_intents (status, expires_at)`,
  ],
};

const HOME_TABLES = [
  "home_state",
  "memory_wipe",
  "skills",
  "skill_versions",
  "skill_files",
  "skill_write_intents",
] as const;

// ── Errors ────────────────────────────────────────────────────────────────

const conflict = (reason: string, message: string) =>
  new RpcError("CONFLICT", message, { reason, retryable: false });

const badRequest = (message: string) => new RpcError("BAD_REQUEST", message);

const wipeActive = () =>
  conflict("CLOUD_MEMORY_WIPE_ACTIVE", "Cloud memory is being permanently erased for this account.");

const epochStale = () =>
  conflict("CLOUD_MEMORY_EPOCH_STALE", "This memory operation started before cloud memory was erased.");

const generationStale = () =>
  conflict("owner_generation_stale", "This request is from before your cloud data was reset.");

// ── Validation ────────────────────────────────────────────────────────────

const sha256Arg = (value: string): string => {
  const digest = value.trim().toLowerCase();
  if (!SHA256.test(digest)) throw badRequest("Expected a lowercase SHA-256 digest.");
  return digest;
};

const idempotencyArg = (value: string): string => {
  const key = value.trim();
  if (!IDEMPOTENCY_KEY.test(key)) throw badRequest("Invalid cloud-home idempotency key.");
  return key;
};

const opaqueArg = (value: string, label: string): string => {
  const id = value.trim();
  if (!OPAQUE_ID.test(id)) throw badRequest(`Invalid ${label}.`);
  return id;
};

const revisionArg = number({ int: true, min: 0 });

const SKILL_SOURCES = [
  "bundled",
  "desktop_sync",
  "mobile_sync",
  "cloud_created",
  "owner_migration",
] as const;
type SkillSource = (typeof SKILL_SOURCES)[number];

const SKILL_AVAILABILITY = ["orchestrator", "general", "both"] as const;
type SkillAvailability = (typeof SKILL_AVAILABILITY)[number];

/** A safe relative path: no absolute, parent, hidden or control-character segments. */
const safeRelativePath = (value: string, label: string): string => {
  const path = value.normalize("NFC").trim();
  if (
    !path ||
    path.length > 240 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(path) ||
    path
      .split("/")
      .some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith(".") || segment.length > 96)
  ) {
    throw badRequest(`Invalid ${label}.`);
  }
  return path;
};

const normalizeLabel = (value: string, label: string, maxChars: number): string => {
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > maxChars) {
    throw badRequest(`${label} must be 1-${maxChars} characters.`);
  }
  return normalized;
};

const normalizeSlug = (value: string): string => {
  const slug = value.normalize("NFC").trim().toLowerCase();
  if (!SKILL_SLUG.test(slug)) {
    throw badRequest("Skill ids must be lowercase letters, numbers, and hyphens.");
  }
  return slug;
};

// ── Identities and object keys ───────────────────────────────────────────

const generationPrefix = async (ownerId: string, ownerGeneration: string): Promise<string> => {
  const [ownerHash, generationHash] = await Promise.all([sha256Hex(ownerId), sha256Hex(ownerGeneration)]);
  return `agent-home/${ownerHash}/generations/${generationHash}/`;
};

const skillIdOf = async (ownerId: string, slug: string) =>
  `skill-${(await sha256Hex(`${ownerId}\0${slug}`)).slice(0, 40)}`;

const skillVersionId = async (ownerId: string, skillId: string, idempotencyKey: string, treeSha256: string) =>
  `skillver-${(await sha256Hex(`${ownerId}\0${skillId}\0${idempotencyKey}\0${treeSha256}`)).slice(0, 40)}`;

// ── Home state ────────────────────────────────────────────────────────────

type StateRow = {
  owner_generation: string;
  memory_enabled: number;
  policy_revision: number;
  policy_request_id: string | null;
  policy_request_revision: number | null;
  policy_request_enabled: number | null;
  policy_updated_at: number;
  memory_epoch: string;
  memory_state: string;
  import_disposition: string;
  last_wiped_epoch: string | null;
  reimport_request_id: string | null;
  content_revision: number;
};

const DEFAULT_STATE: StateRow = {
  owner_generation: "",
  memory_enabled: 1,
  policy_revision: 0,
  policy_request_id: null,
  policy_request_revision: null,
  policy_request_enabled: null,
  policy_updated_at: 0,
  memory_epoch: INITIAL_MEMORY_EPOCH,
  memory_state: "open",
  import_disposition: "automatic_allowed",
  last_wiped_epoch: null,
  reimport_request_id: null,
  content_revision: 0,
};

const STATE_COLUMNS = Object.keys(DEFAULT_STATE) as Array<keyof StateRow>;

const stateRow = (db: OwnerDbReader): StateRow | null =>
  db.one<StateRow>(`SELECT ${STATE_COLUMNS.join(", ")} FROM home_state WHERE id = 1`);

const readState = (db: OwnerDbReader): StateRow => stateRow(db) ?? DEFAULT_STATE;

/** Upsert the state row, stamped with the generation the write ran under. */
const writeState = (db: OwnerDb, ownerGeneration: string, patch: Partial<StateRow>): StateRow => {
  const next: StateRow = { ...readState(db), ...patch, owner_generation: ownerGeneration };
  db.run(
    `INSERT INTO home_state (id, ${STATE_COLUMNS.join(", ")})
       VALUES (1, ${STATE_COLUMNS.map(() => "?").join(", ")})
     ON CONFLICT (id) DO UPDATE SET ${STATE_COLUMNS.map((column) => `${column} = excluded.${column}`).join(", ")}`,
    ...STATE_COLUMNS.map((column) => next[column]),
  );
  return next;
};

/** Note a content or policy change; the caller then awaits `announce`. */
const bumpContent = (db: OwnerDb, ownerGeneration: string): number =>
  writeState(db, ownerGeneration, { content_revision: readState(db).content_revision + 1 }).content_revision;

const announce = async (ctx: OwnerContext, ownerGeneration: string, revision: number): Promise<void> => {
  await ctx.host.homeChanged(ownerGeneration, revision);
};

/** The open memory epoch, refused while a wipe runs or after it moved on. */
const assertMemoryOpen = (db: OwnerDbReader, expectedEpoch?: string): StateRow => {
  const state = readState(db);
  if (state.memory_state === "wiping") throw wipeActive();
  if (expectedEpoch !== undefined && opaqueArg(expectedEpoch, "memory epoch") !== state.memory_epoch) {
    throw epochStale();
  }
  return state;
};

/** The policy an owner's turns run under. Refused while a wipe runs. */
export const readMemoryPolicy = (db: OwnerDbReader, ownerGeneration: string): MemoryPolicy => {
  const state = readState(db);
  if (state.memory_state === "wiping") {
    throw new RpcError("UNAVAILABLE", "Cloud memory is being erased.", { reason: "CLOUD_MEMORY_WIPE_ACTIVE" });
  }
  return {
    ownerGeneration,
    memoryEpoch: state.memory_epoch,
    memoryEnabled: state.memory_enabled === 1,
    revision: state.policy_revision,
    updatedAt: state.policy_updated_at,
  };
};

// ── Memory wipe ──────────────────────────────────────────────────────────

type WipeRow = {
  operation_id: string;
  request_id: string;
  owner_generation: string;
  target_epoch: string;
  next_epoch: string;
  stage: string;
  attempts: number;
  next_retry_at: number;
  last_error_code: string | null;
  objects_deleted: number;
  rows_deleted: number;
  completed_at: number | null;
  updated_at: number;
};

const readWipe = (db: OwnerDbReader): WipeRow | null => db.one<WipeRow>("SELECT * FROM memory_wipe WHERE id = 1");

const wipeStatus = (
  db: OwnerDbReader,
  subject: string,
  callerGeneration = "",
): MemoryWipeStatus => {
  const state = readState(db);
  const wipe = readWipe(db);
  return {
    subject,
    // An owner with no home write yet has no stored generation; the caller's
    // checked one stands in for it.
    ownerGeneration: state.owner_generation || callerGeneration,
    state: state.memory_state as MemoryLifecycleState,
    memoryEpoch: state.memory_epoch,
    importDisposition: state.import_disposition as MemoryImportDisposition,
    ...(state.last_wiped_epoch ? { lastWipedEpoch: state.last_wiped_epoch } : {}),
    job: wipe
      ? {
          operationId: wipe.operation_id,
          stage: wipe.stage as MemoryWipeStage,
          attempts: wipe.attempts,
          nextRetryAt: wipe.next_retry_at,
          ...(wipe.last_error_code ? { lastErrorCode: wipe.last_error_code } : {}),
          objectsDeleted: wipe.objects_deleted,
          rowsDeleted: wipe.rows_deleted,
          ...(wipe.completed_at !== null ? { completedAt: wipe.completed_at } : {}),
          updatedAt: wipe.updated_at,
        }
      : null,
  };
};

const preference = (db: OwnerDbReader, subject: string): MemoryPreference => {
  const state = readState(db);
  return {
    subject,
    ownerGeneration: state.owner_generation,
    memoryEpoch: state.memory_epoch,
    memoryEnabled: state.memory_enabled === 1,
    revision: state.policy_revision,
    updatedAt: state.policy_updated_at,
    state: state.memory_state as MemoryLifecycleState,
    importDisposition: state.import_disposition as MemoryImportDisposition,
    ...(state.last_wiped_epoch ? { lastWipedEpoch: state.last_wiped_epoch } : {}),
  };
};

const startWipe = (
  ctx: OwnerContext,
  ownerGeneration: string,
  input: { requestId: string; expectedMemoryEpoch: string },
): void => {
  const requestId = idempotencyArg(input.requestId);
  const expectedEpoch = opaqueArg(input.expectedMemoryEpoch, "memory epoch");
  const state = readState(ctx.db);
  const existing = readWipe(ctx.db);
  if (existing?.request_id === requestId) {
    if (existing.target_epoch !== expectedEpoch) {
      throw conflict("CLOUD_HOME_IDEMPOTENCY_CONFLICT", "That memory wipe request names a different memory epoch.");
    }
    return;
  }
  if (state.memory_state === "wiping") throw wipeActive();
  if (state.memory_epoch !== expectedEpoch) throw epochStale();
  const operationId = `memorywipe-${crypto.randomUUID()}`;
  writeState(ctx.db, ownerGeneration, { memory_state: "wiping" });
  ctx.db.run(
    `INSERT INTO memory_wipe
       (id, operation_id, request_id, owner_generation, target_epoch, next_epoch, stage,
        attempts, next_retry_at, last_error_code, objects_deleted, rows_deleted, completed_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, 'sweeping', 0, ?, NULL, 0, 0, NULL, ?)
     ON CONFLICT (id) DO UPDATE SET
       operation_id = excluded.operation_id, request_id = excluded.request_id,
       owner_generation = excluded.owner_generation, target_epoch = excluded.target_epoch,
       next_epoch = excluded.next_epoch, stage = 'sweeping', attempts = 0,
       next_retry_at = excluded.next_retry_at, last_error_code = NULL,
       objects_deleted = 0, rows_deleted = 0, completed_at = NULL, updated_at = excluded.updated_at`,
    operationId,
    requestId,
    ownerGeneration,
    state.memory_epoch,
    crypto.randomUUID(),
    ctx.now,
    ctx.now,
  );
  ctx.jobs.schedule(WIPE_JOB, ctx.now, { operationId }, { id: wipeJobId(operationId) });
};

const parseWipePayload = object({ operationId: string({ max: 128 }) });

const currentWipe = (db: OwnerDbReader, operationId: string): WipeRow | null => {
  const wipe = readWipe(db);
  const state = readState(db);
  return wipe && wipe.operation_id === operationId && wipe.stage !== "completed" && state.memory_state === "wiping"
    ? wipe
    : null;
};

/** Open the next memory epoch once the files are gone. Synchronous: one write. */
const finishWipe = (ctx: OwnerContext, wipe: WipeRow, filesDeleted: number): number => {
  writeState(ctx.db, wipe.owner_generation, {
    memory_epoch: wipe.next_epoch,
    memory_state: "open",
    import_disposition: "explicit_required",
    last_wiped_epoch: wipe.target_epoch,
    reimport_request_id: null,
  });
  ctx.db.run(
    `UPDATE memory_wipe SET stage = 'completed', objects_deleted = objects_deleted + ?, last_error_code = NULL,
       next_retry_at = ?, completed_at = ?, updated_at = ? WHERE id = 1`,
    filesDeleted,
    ctx.now,
    ctx.now,
    ctx.now,
  );
  return bumpContent(ctx.db, wipe.owner_generation);
};

/**
 * Erase the memory files (`core-memory.md`, `memories/`, `PERSONALITY.md`
 * under `.stella/`) from the owner's world, then open the next epoch. A
 * failure retries with backoff and stays visible in the status.
 */
const runMemoryWipe = async (ctx: OwnerContext, rawPayload: unknown): Promise<void> => {
  const payload = parseWipePayload(rawPayload);
  if (!currentWipe(ctx.db, payload.operationId)) return;
  let deleted = 0;
  let failure: string | null = null;
  try {
    await eraseLegacyMemory(ctx);
    deleted = await wipeWorldMemory(await ownerMemoryWorld(ctx.env.WORLDS, ctx.ownerId));
  } catch {
    // World errors can carry internal paths; keep only the class.
    failure = "MEMORY_WIPE_STORAGE_FAILURE";
  }
  const now = Date.now();
  const current = currentWipe(ctx.db, payload.operationId);
  if (!current) return;
  if (failure) {
    const attempts = current.attempts + 1;
    const delay = Math.min(WIPE_RETRY_MAX_MS, 1_000 * 2 ** Math.min(attempts, 10));
    ctx.db.run(
      `UPDATE memory_wipe SET attempts = ?, next_retry_at = ?, last_error_code = ?, updated_at = ? WHERE id = 1`,
      attempts,
      now + delay,
      failure,
      now,
    );
    ctx.jobs.schedule(WIPE_JOB, now + delay, payload, { id: wipeJobId(payload.operationId) });
    return;
  }
  const revision = finishWipe({ ...ctx, now }, current, deleted);
  await announce(ctx, current.owner_generation, revision);
};

// ── Memory policy changes (the gate's `OwnerMemoryPolicy` transport) ─────

/**
 * Apply a memory switch change or start a wipe, under the generation the gate
 * verified. Idempotent on `requestId`. Throws `RpcError` refusals.
 */
export const applyMemoryPolicyChange = async (
  ctx: OwnerContext,
  change: MemoryPolicyChange,
): Promise<void> => {
  const ownerGeneration = change.expectedOwnerGeneration;
  if (change.kind === "wipe") {
    startWipe(ctx, ownerGeneration, change);
    return;
  }
  const requestId = idempotencyArg(change.requestId);
  const state = readState(ctx.db);
  if (state.policy_request_id === requestId) {
    if (
      state.policy_request_revision !== change.expectedRevision ||
      state.policy_request_enabled !== (change.memoryEnabled ? 1 : 0)
    ) {
      throw conflict("CLOUD_HOME_IDEMPOTENCY_CONFLICT", "That memory preference request names different input.");
    }
    return;
  }
  if (state.policy_revision !== change.expectedRevision) {
    throw conflict("CLOUD_HOME_REVISION_CONFLICT", "Cloud memory preference changed before this request.");
  }
  writeState(ctx.db, ownerGeneration, {
    memory_enabled: change.memoryEnabled ? 1 : 0,
    policy_revision: state.policy_revision + 1,
    policy_request_id: requestId,
    policy_request_revision: change.expectedRevision,
    policy_request_enabled: change.memoryEnabled ? 1 : 0,
    policy_updated_at: ctx.now,
  });
  await announce(ctx, ownerGeneration, bumpContent(ctx.db, ownerGeneration));
};

/**
 * The generation a client's request runs under. A client acts on what the
 * views showed it: the generation the home state was last written under, or
 * `""` before the first write (a new owner, or after a reset purged it). A
 * request naming anything else is from before a reset. The write is stamped
 * with the owner's current generation.
 */
const requestGeneration = async (ctx: OwnerContext, expected: string): Promise<string> => {
  const { ownerGeneration } = await ctx.host.snapshot();
  if (expected === ownerGeneration || expected === readState(ctx.db).owner_generation) return ownerGeneration;
  throw generationStale();
};

const callerSubject = (ctx: { caller: { ownerId: string } | null; ownerId: string }) =>
  ctx.caller?.ownerId ?? ctx.ownerId;

const generationArg = string({ min: 1, max: 512 });

// ── Memory sync ──────────────────────────────────────────────────────────

const memoryOff = () =>
  conflict("CLOUD_MEMORY_OFF", "Memory is off for this account.");

const reimportRequired = () =>
  conflict(
    "CLOUD_MEMORY_REIMPORT_REQUIRED",
    "Cloud memory was erased. Memory a computer kept from before goes up only after you allow it.",
  );

/** Sync runs while memory is on and open, in the epoch the caller listed. */
const assertSyncOpen = (db: OwnerDbReader, expectedEpoch?: string): StateRow => {
  const state = assertMemoryOpen(db, expectedEpoch);
  if (state.memory_enabled !== 1) throw memoryOff();
  return state;
};

const memorySync = (ctx: OwnerContext) =>
  createWorldMemorySync(() => ownerMemoryWorld(ctx.env.WORLDS, ctx.ownerId));

const fileRefusal = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof MemorySyncFileError) {
      throw new RpcError("BAD_REQUEST", error.message, {
        reason: "CLOUD_MEMORY_FILE_REFUSED",
        retryable: false,
      });
    }
    throw error;
  }
};

/**
 * A wipe that began while a sync write was on its way to the world may have
 * swept before the write landed. Take the write back out, then refuse it, so
 * a computer can never put memory into the epoch after the one it listed.
 */
const settleAgainstWipe = async (
  ctx: OwnerContext,
  epoch: string,
  path: string,
  sha: string,
): Promise<void> => {
  const state = readState(ctx.db);
  if (state.memory_state !== "wiping" && state.memory_epoch === epoch) return;
  await memorySync(ctx)
    .remove(path, sha)
    .catch(() => undefined);
  throw state.memory_state === "wiping" ? wipeActive() : epochStale();
};

// ── Legacy memory ────────────────────────────────────────────────────────
//
// Before memory moved into the world it was `memory_docs` rows (with
// `memory_doc_versions` and `memory_write_intents`) over R2 copies in
// `AGENT_HOME`. An owner whose home was created then still has those tables.
// `importLegacyMemory` copies each document the world layout keeps into the
// world, never over a file already there, then erases the rows and their R2
// copies, so it happens once. A wipe erases them too.

const LEGACY_MEMORY_TABLES = ["memory_docs", "memory_doc_versions", "memory_write_intents"] as const;
const LEGACY_DISPLAY_PREFIX = "~/.stella/";

type LegacyDocRow = { display_path: string; memory_epoch: string; r2_key: string; sha256: string };

const hasLegacyMemory = (db: OwnerDbReader): boolean =>
  db.one("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'memory_docs'") !== null;

/** Delete every legacy memory row's R2 copy, then the legacy tables. */
const eraseLegacyMemory = async (ctx: OwnerContext): Promise<void> => {
  if (!hasLegacyMemory(ctx.db)) return;
  const keys = [
    ...new Set(
      LEGACY_MEMORY_TABLES.flatMap((table) =>
        ctx.db.all<{ r2_key: string }>(`SELECT r2_key FROM ${table}`).map((row) => row.r2_key),
      ),
    ),
  ];
  if (keys.length > 0) {
    const bucket = ctx.env.AGENT_HOME;
    if (!bucket) throw new Error("Cloud home storage is unavailable.");
    for (let index = 0; index < keys.length; index += 1_000) {
      await bucket.delete(keys.slice(index, index + 1_000));
    }
  }
  for (const table of LEGACY_MEMORY_TABLES) ctx.db.run(`DROP TABLE IF EXISTS ${table}`);
};

/** Where a legacy document lives in the world, or null when the layout keeps no such file. */
const legacyWorldPath = (displayPath: string): string | null => {
  if (!displayPath.startsWith(LEGACY_DISPLAY_PREFIX)) return null;
  const path = displayPath.slice(LEGACY_DISPLAY_PREFIX.length);
  return isSyncedMemoryPath(path) ? path : null;
};

/** Copy legacy memory into the world, then erase it; the files written. */
const importLegacyMemory = async (ctx: OwnerContext): Promise<number> => {
  if (!hasLegacyMemory(ctx.db)) return 0;
  const state = readState(ctx.db);
  // The wipe erases legacy memory itself.
  if (state.memory_state === "wiping") return 0;
  const rows = ctx.db.all<LegacyDocRow>("SELECT display_path, memory_epoch, r2_key, sha256 FROM memory_docs");
  const bucket = ctx.env.AGENT_HOME;
  if (rows.length > 0 && !bucket) throw new Error("Cloud home storage is unavailable.");
  const world = () => ownerMemoryWorld(ctx.env.WORLDS, ctx.ownerId);
  const written: { path: string; sha: string }[] = [];
  for (const row of rows) {
    // Imported and user Markdown copies have had no reader since the move.
    const path = legacyWorldPath(row.display_path);
    if (!path || row.memory_epoch !== state.memory_epoch || !bucket) continue;
    const object = await bucket.get(row.r2_key);
    if (!object) continue;
    const bytes = new Uint8Array(await object.arrayBuffer());
    if ((await sha256BytesHex(bytes)) !== row.sha256) continue;
    const sha = await createWorldMemoryFile(world, path, bytes);
    if (sha) written.push({ path, sha });
  }
  const after = readState(ctx.db);
  if (after.memory_state === "wiping" || after.memory_epoch !== state.memory_epoch) {
    // A wipe began meanwhile and may already have swept: take the copies back out.
    for (const file of written) {
      await memorySync(ctx)
        .remove(file.path, file.sha)
        .catch(() => undefined);
    }
    return 0;
  }
  await eraseLegacyMemory(ctx);
  return written.length;
};

const syncPathArg = string({ min: 1, max: 240 });
const syncEpochArg = string({ min: 1, max: 128 });
const syncShaArg = string({ pattern: SHA256 });

// ── Skills ────────────────────────────────────────────────────────────────

type SkillFile = { path: string; r2Key: string; sha256: string; sizeBytes: number; contentType: string };

type SkillRow = {
  skill_id: string;
  slug: string;
  name: string;
  description: string;
  source: string;
  availability: string;
  version_id: string | null;
  revision: number;
  deleted_at: number | null;
  updated_at: number;
};

type SkillVersionRow = {
  version_id: string;
  skill_id: string;
  owner_generation: string;
  manifest_r2_key: string;
  manifest_sha256: string;
  tree_sha256: string;
  file_count: number;
  total_size_bytes: number;
};

type SkillIntentRow = {
  intent_id: string;
  idempotency_key: string;
  owner_generation: string;
  skill_id: string;
  slug: string;
  name: string;
  description: string;
  source: string;
  availability: string;
  base_revision: number;
  base_version_id: string | null;
  version_id: string;
  next_revision: number;
  manifest_r2_key: string;
  manifest_sha256: string;
  tree_sha256: string;
  file_count: number;
  total_size_bytes: number;
  files_json: string;
  status: string;
  conflict_revision: number | null;
  conflict_version_id: string | null;
  expires_at: number;
};

/** A tombstoned head reads as absent: the next upload starts at revision 1. */
const liveSkill = (db: OwnerDbReader, skillId: string): { row: SkillRow | null; live: SkillRow | null } => {
  const row = db.one<SkillRow>("SELECT * FROM skills WHERE skill_id = ?", skillId);
  return { row, live: row && row.deleted_at === null ? row : null };
};

const skillIntent = (db: OwnerDbReader, column: "intent_id" | "idempotency_key", value: string) =>
  db.one<SkillIntentRow>(`SELECT * FROM skill_write_intents WHERE ${column} = ?`, value);

const skillReceipt = (row: SkillIntentRow) => ({
  intentId: row.intent_id,
  status: row.status,
  ownerGeneration: row.owner_generation,
  skillId: row.skill_id,
  slug: row.slug,
  name: row.name,
  description: row.description,
  source: row.source,
  availability: row.availability,
  baseRevision: row.base_revision,
  ...(row.base_version_id ? { baseVersionId: row.base_version_id } : {}),
  versionId: row.version_id,
  nextRevision: row.next_revision,
  manifestR2Key: row.manifest_r2_key,
  manifestSha256: row.manifest_sha256,
  treeSha256: row.tree_sha256,
  fileCount: row.file_count,
  totalSizeBytes: row.total_size_bytes,
  files: JSON.parse(row.files_json) as SkillFile[],
  expiresAt: row.expires_at,
  ...(row.conflict_revision !== null ? { conflictRevision: row.conflict_revision } : {}),
  ...(row.conflict_version_id ? { conflictVersionId: row.conflict_version_id } : {}),
});

const skillBeginArgs = object({
  ownerGeneration: generationArg,
  slug: string({ max: 63 }),
  name: string({ max: 1_000 }),
  description: string({ max: 4_000 }),
  source: literal(...SKILL_SOURCES),
  availability: literal(...SKILL_AVAILABILITY),
  expectedRevision: revisionArg,
  manifestSha256: string({ max: 64 }),
  treeSha256: string({ max: 64 }),
  files: array(
    object({
      path: string({ max: 240 }),
      sha256: string({ max: 64 }),
      sizeBytes: number({ int: true, min: 0 }),
      contentType: string({ max: 240 }),
    }),
    { max: SKILL_MAX_FILES },
  ),
  idempotencyKey: string({ max: 128 }),
});

const beginSkillWrite = async (ctx: OwnerContext, raw: unknown) => {
  const args = skillBeginArgs(raw);
  const slug = normalizeSlug(args.slug);
  const name = normalizeLabel(args.name, "Skill name", 120);
  const description = normalizeLabel(args.description, "Skill description", 1_000);
  const manifestSha256 = sha256Arg(args.manifestSha256);
  const treeSha256 = sha256Arg(args.treeSha256);
  const idempotencyKey = idempotencyArg(args.idempotencyKey);
  if (args.files.length === 0) throw badRequest(`A skill needs 1-${SKILL_MAX_FILES} regular files.`);
  const seen = new Set<string>();
  const inputs = args.files.map((file) => {
    const path = safeRelativePath(file.path, "skill file path");
    if (seen.has(path)) throw badRequest(`Duplicate skill file path: ${path}`);
    seen.add(path);
    if (file.sizeBytes > SKILL_MAX_FILE_BYTES) {
      throw badRequest(`Skill file ${path} exceeds the per-file size limit.`);
    }
    const contentType = file.contentType.trim();
    if (!contentType || contentType.length > 120) {
      throw badRequest(`Skill file ${path} has an invalid content type.`);
    }
    return { path, sha256: sha256Arg(file.sha256), sizeBytes: file.sizeBytes, contentType };
  });
  inputs.sort((a, b) => a.path.localeCompare(b.path));
  if (!seen.has("SKILL.md")) throw badRequest("Every skill package must include SKILL.md.");
  const totalSizeBytes = inputs.reduce((total, file) => total + file.sizeBytes, 0);
  if (totalSizeBytes > SKILL_MAX_TOTAL_BYTES) throw badRequest("Skill package exceeds the total size limit.");
  const calculatedTree = await sha256Hex(
    inputs.map((file) => `${file.path}\0${file.sha256}\0${file.sizeBytes}\0${file.contentType}\n`).join(""),
  );
  if (calculatedTree !== treeSha256) throw badRequest("Skill tree digest does not match its file manifest.");
  const skillId = await skillIdOf(ctx.ownerId, slug);
  const versionId = await skillVersionId(ctx.ownerId, skillId, idempotencyKey, treeSha256);
  const versionRoot = `${await generationPrefix(ctx.ownerId, args.ownerGeneration)}skills/${skillId}/${versionId}/`;
  const files: SkillFile[] = inputs.map((file) => ({
    path: file.path,
    r2Key: `${versionRoot}files/${file.path}`,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
    contentType: file.contentType,
  }));

  const replay = skillIntent(ctx.db, "idempotency_key", idempotencyKey);
  if (replay) {
    const replayFiles = JSON.parse(replay.files_json) as SkillFile[];
    if (
      replay.slug !== slug ||
      replay.name !== name ||
      replay.description !== description ||
      replay.source !== args.source ||
      replay.availability !== args.availability ||
      replay.base_revision !== args.expectedRevision ||
      replay.manifest_sha256 !== manifestSha256 ||
      replay.tree_sha256 !== treeSha256 ||
      replayFiles.length !== files.length ||
      replayFiles.some(
        (file, index) =>
          file.path !== files[index]!.path ||
          file.sha256 !== files[index]!.sha256 ||
          file.sizeBytes !== files[index]!.sizeBytes ||
          file.contentType !== files[index]!.contentType,
      )
    ) {
      throw conflict("CLOUD_SKILL_IDEMPOTENCY_CONFLICT", "That skill idempotency key names a different package.");
    }
    return skillReceipt(replay);
  }
  const { live } = liveSkill(ctx.db, skillId);
  const currentRevision = live?.revision ?? 0;
  if (currentRevision !== args.expectedRevision) {
    throw conflict("CLOUD_SKILL_REVISION_CONFLICT", "The cloud skill changed before this upload began.");
  }
  if (!live) {
    const count = ctx.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM skills WHERE deleted_at IS NULL")?.n ?? 0;
    if (count >= MAX_SKILLS) throw badRequest(`Cloud Skills supports at most ${MAX_SKILLS} installed skills.`);
  }
  const intentId = `skillintent-${crypto.randomUUID()}`;
  ctx.db.run(
    `INSERT INTO skill_write_intents
       (intent_id, idempotency_key, owner_generation, skill_id, slug, name, description, source,
        availability, base_revision, base_version_id, version_id, next_revision, manifest_r2_key,
        manifest_sha256, tree_sha256, file_count, total_size_bytes, files_json, status,
        conflict_revision, conflict_version_id, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, NULL, ?, ?, ?)`,
    intentId,
    idempotencyKey,
    args.ownerGeneration,
    skillId,
    slug,
    name,
    description,
    args.source,
    args.availability,
    currentRevision,
    live?.version_id ?? null,
    versionId,
    currentRevision + 1,
    `${versionRoot}manifest.json`,
    manifestSha256,
    treeSha256,
    files.length,
    totalSizeBytes,
    JSON.stringify(files),
    ctx.now + WRITE_INTENT_TTL_MS,
    ctx.now,
    ctx.now,
  );
  scheduleIntentSweep(ctx);
  return skillReceipt(skillIntent(ctx.db, "intent_id", intentId)!);
};

const skillCommitArgs = object({
  ownerGeneration: generationArg,
  intentId: string({ max: 128 }),
  versionId: string({ max: 128 }),
  manifestR2Key: string({ max: 1_024 }),
  manifestSha256: string({ max: 64 }),
  treeSha256: string({ max: 64 }),
});

const setSkillIntentStatus = (
  ctx: OwnerContext,
  intent: SkillIntentRow,
  status: string,
  conflictWith?: { revision: number; versionId: string | null },
): SkillIntentRow => {
  ctx.db.run(
    `UPDATE skill_write_intents SET status = ?, conflict_revision = ?, conflict_version_id = ?, updated_at = ?
     WHERE intent_id = ?`,
    status,
    conflictWith?.revision ?? null,
    conflictWith?.versionId ?? null,
    ctx.now,
    intent.intent_id,
  );
  return skillIntent(ctx.db, "intent_id", intent.intent_id)!;
};

const commitSkillWrite = async (ctx: OwnerContext, raw: unknown) => {
  const args = skillCommitArgs(raw);
  const intent = skillIntent(ctx.db, "intent_id", opaqueArg(args.intentId, "skill intent id"));
  if (!intent) throw new RpcError("NOT_FOUND", "Skill write intent not found.");
  if (
    intent.owner_generation !== args.ownerGeneration ||
    intent.version_id !== args.versionId ||
    intent.manifest_r2_key !== args.manifestR2Key ||
    intent.manifest_sha256 !== sha256Arg(args.manifestSha256) ||
    intent.tree_sha256 !== sha256Arg(args.treeSha256)
  ) {
    throw badRequest("Skill write receipt does not match its intent.");
  }
  if (intent.status === "conflict") return skillReceipt(intent);
  const { live } = liveSkill(ctx.db, intent.skill_id);
  if (intent.status === "committed") {
    // A later device-root deletion may have tombstoned this head. Restoring
    // the identical package replays this key, so republish the head.
    if (live) return skillReceipt(intent);
  } else {
    if (intent.status !== "prepared") {
      throw conflict("CLOUD_HOME_INTENT_INACTIVE", "Skill write intent is no longer active.");
    }
    if (intent.expires_at < ctx.now) return skillReceipt(setSkillIntentStatus(ctx, intent, "aborted"));
    if ((live?.revision ?? 0) !== intent.base_revision || (live?.version_id ?? null) !== intent.base_version_id) {
      return skillReceipt(
        setSkillIntentStatus(ctx, intent, "conflict", {
          revision: live?.revision ?? 0,
          versionId: live?.version_id ?? null,
        }),
      );
    }
  }
  const existing = ctx.db.one<SkillVersionRow>("SELECT * FROM skill_versions WHERE version_id = ?", intent.version_id);
  if (existing) {
    if (existing.manifest_r2_key !== intent.manifest_r2_key || existing.tree_sha256 !== intent.tree_sha256) {
      throw new Error("Skill version id collision.");
    }
  } else {
    ctx.db.run(
      `INSERT INTO skill_versions
         (version_id, skill_id, owner_generation, revision, base_version_id, manifest_r2_key,
          manifest_sha256, tree_sha256, file_count, total_size_bytes, source, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      intent.version_id,
      intent.skill_id,
      intent.owner_generation,
      intent.next_revision,
      intent.base_version_id,
      intent.manifest_r2_key,
      intent.manifest_sha256,
      intent.tree_sha256,
      intent.file_count,
      intent.total_size_bytes,
      intent.source,
      intent.idempotency_key,
      ctx.now,
    );
    for (const file of JSON.parse(intent.files_json) as SkillFile[]) {
      ctx.db.run(
        `INSERT INTO skill_files (version_id, path, skill_id, r2_key, sha256, size_bytes, content_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        intent.version_id,
        file.path,
        intent.skill_id,
        file.r2Key,
        file.sha256,
        file.sizeBytes,
        file.contentType,
        ctx.now,
      );
    }
  }
  ctx.db.run(
    `INSERT INTO skills
       (skill_id, slug, name, description, source, availability, version_id, revision, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT (skill_id) DO UPDATE SET
       slug = excluded.slug, name = excluded.name, description = excluded.description,
       source = excluded.source, availability = excluded.availability, version_id = excluded.version_id,
       revision = excluded.revision, deleted_at = NULL, updated_at = excluded.updated_at`,
    intent.skill_id,
    intent.slug,
    intent.name,
    intent.description,
    intent.source,
    intent.availability,
    intent.version_id,
    intent.next_revision,
    ctx.now,
    ctx.now,
  );
  const committed = setSkillIntentStatus(ctx, intent, "committed");
  await announce(ctx, args.ownerGeneration, bumpContent(ctx.db, args.ownerGeneration));
  return skillReceipt(committed);
};

const liveSkills = (db: OwnerDbReader): SkillRow[] =>
  db.all<SkillRow>("SELECT * FROM skills WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?", MAX_SKILLS);

const skillVersion = (db: OwnerDbReader, versionId: string | null): SkillVersionRow | null =>
  versionId ? db.one<SkillVersionRow>("SELECT * FROM skill_versions WHERE version_id = ?", versionId) : null;

/**
 * The skills a cloud turn may materialize: exactly what the owner's device
 * root holds, mirrored, with the exact file allowlist of each version.
 */
const skillCatalog = (db: OwnerDbReader, agentType: "orchestrator" | "general") =>
  liveSkills(db).flatMap((skill) => {
    if (skill.availability !== "both" && skill.availability !== agentType) return [];
    const version = skillVersion(db, skill.version_id);
    if (!version) return [];
    const files = db.all<{ path: string; r2_key: string; sha256: string; size_bytes: number; content_type: string }>(
      "SELECT path, r2_key, sha256, size_bytes, content_type FROM skill_files WHERE version_id = ? ORDER BY path",
      version.version_id,
    );
    return [
      {
        skillId: skill.skill_id,
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        source: skill.source,
        availability: skill.availability,
        revision: skill.revision,
        versionId: version.version_id,
        manifestSha256: version.manifest_sha256,
        treeSha256: version.tree_sha256,
        fileCount: version.file_count,
        totalSizeBytes: version.total_size_bytes,
        files: files.map((file) => ({
          path: file.path,
          r2Key: file.r2_key,
          sha256: file.sha256,
          sizeBytes: file.size_bytes,
          contentType: file.content_type,
        })),
        updatedAt: skill.updated_at,
      },
    ];
  });

/** Mirror heads for the device's reconciliation. No object keys. */
const skillHeads = (db: OwnerDbReader): CloudSkillHead[] =>
  liveSkills(db).map((skill) => {
    const version = skillVersion(db, skill.version_id);
    return {
      skillId: skill.skill_id,
      ownerGeneration: version?.owner_generation ?? readState(db).owner_generation,
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      source: skill.source as SkillSource,
      availability: skill.availability as SkillAvailability,
      revision: skill.revision,
      ...(skill.version_id ? { versionId: skill.version_id } : {}),
      ...(version
        ? {
            manifestSha256: version.manifest_sha256,
            treeSha256: version.tree_sha256,
            fileCount: version.file_count,
            totalSizeBytes: version.total_size_bytes,
          }
        : {}),
      updatedAt: skill.updated_at,
    };
  });

/**
 * Tombstone a mirrored skill the device root stopped holding. A head that
 * moved past the revision the device saw is left alone, so one device never
 * erases another device's newer upload.
 */
const deleteMirroredSkill = async (
  ctx: OwnerContext,
  args: HomeCalls["skills.deleteMirrored"]["args"],
): Promise<SkillMirrorDeletion> => {
  if (!args.clientScope.trim()) throw badRequest("Cloud Home client scope was invalid.");
  if (args.expectedRevision < 1) throw badRequest("expectedRevision must be a published revision.");
  const skillId = await skillIdOf(ctx.ownerId, normalizeSlug(args.slug));
  const { ownerGeneration } = await ctx.host.snapshot();
  const { row, live } = liveSkill(ctx.db, skillId);
  if (!live) return { skillId, status: "deleted", revision: row?.revision ?? 0 };
  if (live.revision !== args.expectedRevision) return { skillId, status: "conflict", revision: live.revision };
  ctx.db.run("UPDATE skills SET deleted_at = ?, updated_at = ? WHERE skill_id = ?", ctx.now, ctx.now, skillId);
  await announce(ctx, ownerGeneration, bumpContent(ctx.db, ownerGeneration));
  return { skillId, status: "deleted", revision: live.revision };
};

// ── Intent sweep ──────────────────────────────────────────────────────────

/** Arm the sweep for the earliest reservation that never committed. */
const scheduleIntentSweep = (ctx: OwnerContext): void => {
  const next = ctx.db.one<{ at: number | null }>(
    "SELECT MIN(expires_at) AS at FROM skill_write_intents WHERE status != 'committed'",
  )?.at;
  if (typeof next === "number") {
    ctx.jobs.schedule(INTENT_SWEEP_JOB, next + INTENT_SWEEP_GRACE_MS, {}, { id: INTENT_SWEEP_JOB_ID });
  }
};

/**
 * Reservations that never committed: expire them, delete the bytes they may
 * have uploaded unless a committed version also uses that key, and drop the
 * rows. Committed receipts stay for idempotent replay.
 */
const runIntentSweep = async (ctx: OwnerContext): Promise<void> => {
  const cutoff = ctx.now - INTENT_SWEEP_GRACE_MS;
  const skills = ctx.db.all<{ intent_id: string; manifest_r2_key: string; files_json: string }>(
    "SELECT intent_id, manifest_r2_key, files_json FROM skill_write_intents WHERE status != 'committed' AND expires_at <= ? LIMIT 20",
    cutoff,
  );
  const keys = new Set<string>();
  for (const intent of skills) {
    if (!ctx.db.one("SELECT 1 AS used FROM skill_versions WHERE manifest_r2_key = ?", intent.manifest_r2_key)) {
      keys.add(intent.manifest_r2_key);
    }
    for (const file of JSON.parse(intent.files_json) as SkillFile[]) {
      if (!ctx.db.one("SELECT 1 AS used FROM skill_files WHERE r2_key = ?", file.r2Key)) keys.add(file.r2Key);
    }
  }
  if (keys.size > 0) {
    const bucket = ctx.env.AGENT_HOME;
    if (!bucket) throw new Error("Cloud home storage is unavailable.");
    const list = [...keys];
    for (let index = 0; index < list.length; index += 1_000) {
      await bucket.delete(list.slice(index, index + 1_000));
    }
  }
  for (const intent of skills) ctx.db.run("DELETE FROM skill_write_intents WHERE intent_id = ?", intent.intent_id);
  // `+ 1`: the run that is finishing keeps its own job row until it returns.
  const next = ctx.db.one<{ at: number | null }>(
    "SELECT MIN(expires_at) AS at FROM skill_write_intents WHERE status != 'committed'",
  )?.at;
  if (typeof next === "number") {
    ctx.jobs.schedule(
      INTENT_SWEEP_JOB,
      Math.max(next + INTENT_SWEEP_GRACE_MS, Date.now() + 1),
      {},
      { id: INTENT_SWEEP_JOB_ID },
    );
  }
};

// ── Internal operations ───────────────────────────────────────────────────

const generationOnly = object({ ownerGeneration: generationArg });

const internal: Record<string, InternalDef> = {
  /** The policy a turn runs under. Refused while a wipe runs. */
  "memory.context": (ctx, raw) => {
    const args = generationOnly(raw);
    assertMemoryOpen(ctx.db);
    return readMemoryPolicy(ctx.db, args.ownerGeneration);
  },
  /** Copy memory from before the move into the world, once (`importLegacyMemory`). */
  "memory.legacyImport": async (ctx, raw) => {
    generationOnly(raw);
    return { imported: await importLegacyMemory(ctx) };
  },
  "skills.catalog": (ctx, raw) => {
    const args = object({ ownerGeneration: generationArg, agentType: literal("orchestrator", "general") })(raw);
    return skillCatalog(ctx.db, args.agentType);
  },
  "skills.begin": beginSkillWrite,
  "skills.commit": commitSkillWrite,
};

// ── Domain ────────────────────────────────────────────────────────────────

const epochRequest = object({
  requestId: string({ min: 1, max: 128 }),
  expectedOwnerGeneration: string({ max: 512 }),
  expectedMemoryEpoch: string({ min: 1, max: 128 }),
});

export const homeDomain = {
  name: "home",
  migrations: [HOME_MIGRATION],
  calls: {
    "memory.setEnabled": {
      scope: "owner",
      parse: object({
        requestId: string({ min: 1, max: 128 }),
        memoryEnabled: boolean(),
        expectedRevision: revisionArg,
        expectedOwnerGeneration: string({ max: 512 }),
      }),
      handler: async (ctx: OwnerContext, args: HomeCalls["memory.setEnabled"]["args"]) => {
        const ownerGeneration = await requestGeneration(ctx, args.expectedOwnerGeneration);
        await ctx.host.changeMemoryPolicy({
          kind: "preference",
          ownerId: ctx.ownerId,
          expectedOwnerGeneration: ownerGeneration,
          requestId: args.requestId,
          expectedRevision: args.expectedRevision,
          memoryEnabled: args.memoryEnabled,
        });
        return preference(ctx.db, callerSubject(ctx));
      },
    },
    "memory.startWipe": {
      scope: "owner",
      parse: epochRequest,
      handler: async (ctx: OwnerContext, args: HomeCalls["memory.startWipe"]["args"]) => {
        const ownerGeneration = await requestGeneration(ctx, args.expectedOwnerGeneration);
        await ctx.host.changeMemoryPolicy({
          kind: "wipe",
          ownerId: ctx.ownerId,
          expectedOwnerGeneration: ownerGeneration,
          requestId: args.requestId,
          expectedMemoryEpoch: args.expectedMemoryEpoch,
        });
        return wipeStatus(ctx.db, callerSubject(ctx));
      },
    },
    "memory.authorizeReimport": {
      scope: "owner",
      parse: epochRequest,
      handler: async (ctx: OwnerContext, args: HomeCalls["memory.authorizeReimport"]["args"]) => {
        const ownerGeneration = await requestGeneration(ctx, args.expectedOwnerGeneration);
        const requestId = idempotencyArg(args.requestId);
        const state = assertMemoryOpen(ctx.db, args.expectedMemoryEpoch);
        if (state.import_disposition === "automatic_allowed") {
          throw conflict(
            "CLOUD_MEMORY_REIMPORT_NOT_REQUIRED",
            "This memory epoch does not require a reimport confirmation.",
          );
        }
        if (state.import_disposition === "explicit_required") {
          writeState(ctx.db, ownerGeneration, {
            import_disposition: "explicit_allowed",
            reimport_request_id: requestId,
          });
        }
        return wipeStatus(ctx.db, callerSubject(ctx));
      },
    },
    "memory.files.list": {
      scope: "owner",
      parse: empty(),
      handler: async (ctx: OwnerContext) => {
        assertSyncOpen(ctx.db);
        await importLegacyMemory(ctx);
        const before = assertSyncOpen(ctx.db);
        const files = await fileRefusal(() => memorySync(ctx).list());
        // The listing holds only for the epoch it was taken in.
        const state = assertSyncOpen(ctx.db, before.memory_epoch);
        return {
          memoryEpoch: state.memory_epoch,
          importDisposition: state.import_disposition as MemoryImportDisposition,
          files,
        };
      },
    },
    "memory.files.read": {
      scope: "owner",
      parse: object({ path: syncPathArg, expectedMemoryEpoch: syncEpochArg }),
      handler: async (ctx: OwnerContext, args: HomeCalls["memory.files.read"]["args"]) => {
        assertSyncOpen(ctx.db, args.expectedMemoryEpoch);
        return await fileRefusal(() => memorySync(ctx).read(args.path));
      },
    },
    "memory.files.write": {
      scope: "owner",
      parse: object({
        path: syncPathArg,
        expectedMemoryEpoch: syncEpochArg,
        // The shared caps refuse anything longer once redacted.
        content: string({ max: 200_000 }),
        expectSha: nullable(syncShaArg),
        importing: boolean(),
      }),
      handler: async (ctx: OwnerContext, args: HomeCalls["memory.files.write"]["args"]) => {
        const state = assertSyncOpen(ctx.db, args.expectedMemoryEpoch);
        if (args.importing && state.import_disposition === "explicit_required") {
          throw reimportRequired();
        }
        const outcome = await fileRefusal(() =>
          memorySync(ctx).write(args.path, args.content, args.expectSha),
        );
        if (outcome.status === "written") {
          await settleAgainstWipe(ctx, args.expectedMemoryEpoch, args.path, outcome.sha);
        }
        return outcome;
      },
    },
    "memory.files.delete": {
      scope: "owner",
      parse: object({
        path: syncPathArg,
        expectedMemoryEpoch: syncEpochArg,
        expectSha: syncShaArg,
      }),
      handler: async (ctx: OwnerContext, args: HomeCalls["memory.files.delete"]["args"]) => {
        assertSyncOpen(ctx.db, args.expectedMemoryEpoch);
        return await fileRefusal(() => memorySync(ctx).remove(args.path, args.expectSha));
      },
    },
    "skills.deleteMirrored": {
      scope: "owner",
      parse: object({
        clientScope: string({ min: 1, max: 512 }),
        slug: string({ min: 1, max: 63 }),
        expectedRevision: revisionArg,
      }),
      handler: (ctx: OwnerContext, args: HomeCalls["skills.deleteMirrored"]["args"]) =>
        deleteMirroredSkill(ctx, args),
    },
  },
  views: {
    "memory.preference": {
      parse: empty(),
      read: (ctx) => preference(ctx.db, callerSubject(ctx)),
    },
    "memory.wipeStatus": {
      parse: empty(),
      read: (ctx) => wipeStatus(ctx.db, callerSubject(ctx)),
    },
    "skills.heads": {
      parse: object({ clientScope: string({ min: 1, max: 512 }) }),
      read: (ctx) => skillHeads(ctx.db),
    },
  },
  jobs: {
    [WIPE_JOB]: { run: runMemoryWipe, maxAttempts: 50 },
    [INTENT_SWEEP_JOB]: { run: (ctx) => runIntentSweep(ctx), maxAttempts: 50 },
  },
  internal,
  /** R2 bytes go with the owner prefix sweep in `/owners/purge`. */
  purge: (ctx) => {
    const wipe = readWipe(ctx.db);
    if (wipe) ctx.jobs.cancel(wipeJobId(wipe.operation_id));
    ctx.jobs.cancel(INTENT_SWEEP_JOB_ID);
    for (const table of HOME_TABLES) ctx.db.run(`DELETE FROM ${table}`);
    for (const table of LEGACY_MEMORY_TABLES) ctx.db.run(`DROP TABLE IF EXISTS ${table}`);
    return { pending: false };
  },
} satisfies OwnerDomain;
