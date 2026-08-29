import { sha256Hex } from "./hash.js";
import { validNativeStateCheckpointMac } from "./native-state-checkpoint.js";
import {
  TURN_STATE_ARCHIVE_CONTENT_TYPE,
  TURN_STATE_MAX_ARCHIVE_BYTES,
  copyTurnStateArchive,
  turnStateArchiveMetadataMatches,
  type TurnStateArchiveTarget,
} from "./turn-state-archive.js";
import {
  TURN_STATE_OBJECT_FORMAT,
  TURN_STATE_OBJECT_PREFIX,
  TURN_STATE_SCHEMA_VERSION,
  WORLD_REGISTRY_SEGMENT,
  assertTurnStateTransferSourceEmpty,
  commitTurnStateOperation,
  confirmTurnStateRestore,
  drainTurnStateRetirements,
  markTurnStateObjectUploaded,
  prepareTurnStateOperation,
  publishTurnStateWorkspace,
  purgeTurnState,
  resolveTurnState,
  type StrongTurnStateStorage,
  type TurnStateArchive,
  type TurnStateCandidate,
  type TurnStateIdentity,
  type TurnStateNativeCheckpoint,
  type TurnStateObjectStore,
  type TurnStateWorkspaceHead,
} from "./turn-state-registry.js";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_STORAGE_KEY_BYTES = 4_096;
const MAX_CURSOR_BYTES = 4_096;
const ROUTE_OPERATION_PREFIX = "turn-state:v1:route-operation:";
const TRANSFER_STAGE_PREFIX = "turn-state:v1:transfer-stage:";
const TRANSFER_ACTIVATION_PREFIX = "turn-state:v1:transfer-activation:";
const LEGACY_SEED_BINDING_PREFIX = "turn-state:v1:legacy-seed:";
const ABORT_UNPUBLISHED_PREFIX = "turn-state:v1:abort-unpublished:";
const OWNER_MARKER_KEY = "turn-state:v1:owner";
const OWNER_FENCE_KEY = "ownerPurgeFence";
const MAX_TRANSFER_ENTRIES = 512;
const MAX_TRANSFER_PAGE_ENTRIES = 16;
const LEGACY_SEED_THREAD_ID = "__stella_legacy_workspace_seed_v1__";
const LEGACY_SEED_HISTORY_CURSOR = "v1:legacy-workspace-seed";

type OwnerLease = {
  leaseId: string;
  sessionId: string;
  turnId: string;
  namespace: "build" | "orchestrator" | "activity";
  role: "run" | "aux" | "orchestrator" | "activity" | "transfer";
  reservationGeneration?: string;
  ownerGeneration?: string;
  expiresAt?: number;
};

/**
 * The already-loaded, durable owner fence. The caller must pass the owner id
 * which was bound to this owner-fence Durable Object on its first trusted
 * direct-stub request; request JSON is never allowed to establish that scope.
 */
export type TurnStateOwnerFence = {
  ownerId: string;
  generation: string;
  state: "open" | "blocked";
  active: Record<string, OwnerLease>;
};

type RouteOperationAuthorization = {
  schemaVersion: typeof TURN_STATE_SCHEMA_VERSION;
  scope: "turn" | "legacy-seed";
  ownerHash: string;
  workspaceHash: string;
  threadHash: string;
  operationId: string;
  ownerId: string;
  ownerGeneration: string;
  fenceGeneration: string;
  leaseId: string;
  sessionId: string;
  turnId: string;
  threadId: string;
  attemptGeneration: number;
  baseWorkspaceRevision: number;
  requestFingerprint: string;
  createdAt: number;
  objectKeys: { workspace: string; native?: string };
};

/** Stable source description copied page-by-page by the transfer coordinator. */
export type TurnStateTransferManifest = {
  schemaVersion: typeof TURN_STATE_SCHEMA_VERSION;
  transferOperationId: string;
  sourceOwnerHash: string;
  sourceOwnerGeneration: string;
  sourceWorkspaceHash: string;
  destinationOwnerHash: string;
  destinationOwnerGeneration: string;
  destinationWorkspaceHash: string;
  count: number;
  fingerprint: string;
};

export type TurnStateTransferThreadCandidate = {
  schemaVersion: typeof TURN_STATE_SCHEMA_VERSION;
  sourceOperationId: string;
  requestFingerprint: string;
  historyCursor: string;
  native?: TurnStateArchive;
  nativeCheckpoint?: TurnStateNativeCheckpoint;
  createdAt: number;
};

export type TurnStateTransferEntry =
  | {
      schemaVersion: typeof TURN_STATE_SCHEMA_VERSION;
      entryKind: "workspace";
      disposition: "committed" | "published" | "candidate";
      originThreadId: string;
      entryFingerprint: string;
      head: TurnStateWorkspaceHead;
    }
  | {
      schemaVersion: typeof TURN_STATE_SCHEMA_VERSION;
      entryKind: "thread";
      threadId: string;
      threadHash: string;
      disposition: "committed" | "candidate";
      candidateOrdinal?: number;
      entryFingerprint: string;
      candidate: TurnStateTransferThreadCandidate;
    };

type UnsignedTurnStateTransferEntry = TurnStateTransferEntry extends infer Entry
  ? Entry extends TurnStateTransferEntry
    ? Omit<Entry, "schemaVersion" | "entryFingerprint">
    : never
  : never;

export type TurnStateTransferExportResponse = {
  manifest: TurnStateTransferManifest;
  entries: TurnStateTransferEntry[];
  nextCursor?: number;
};

export type TurnStateTransferStageResponse = {
  manifestFingerprint: string;
  entryKind: TurnStateTransferEntry["entryKind"];
  entryFingerprint: string;
  threadHash?: string;
  replayed: boolean;
};

export type TurnStateTransferActivationResponse = {
  manifestFingerprint: string;
  activationReceipt: string;
  count: number;
  replayed: boolean;
};

export type TurnStateTransferRetireResponse = {
  manifestFingerprint: string;
  activationReceipt: string;
  pending: boolean;
  deleted: number;
  prefix: string;
  emptyReceipt?: string;
};

export type TurnStateTransferDestinationStatus = {
  state: "empty" | "staging" | "activated" | "occupied";
  activationReceipt?: string;
};

type TransferStageRecord = {
  schemaVersion: typeof TURN_STATE_SCHEMA_VERSION;
  ownerHash: string;
  ownerGeneration: string;
  workspaceHash: string;
  transferOperationId: string;
  manifestFingerprint: string;
  entryFingerprint: string;
  sourceOwnerHash: string;
  sourceOwnerGeneration: string;
  sourceWorkspaceHash: string;
  entry: TurnStateTransferEntry;
  destinationOperationId: string;
  destinationRequestFingerprint: string;
  destinationTurnHash: string;
  destinationObjectKey?: string;
  state: "reserved" | "copied";
  archive?: TurnStateArchive;
  nativeCheckpoint?: TurnStateNativeCheckpoint;
};

type TransferActivationRecord = {
  schemaVersion: typeof TURN_STATE_SCHEMA_VERSION;
  ownerHash: string;
  ownerGeneration: string;
  workspaceHash: string;
  transferOperationId: string;
  manifestFingerprint: string;
  sourceOwnerHash: string;
  sourceOwnerGeneration: string;
  sourceWorkspaceHash: string;
  count: number;
  entryFingerprints: Array<[entryKey: string, entryFingerprint: string]>;
  activationReceipt: string;
};

type RegistryThreadRecord = {
  schemaVersion: typeof TURN_STATE_SCHEMA_VERSION;
  ownerHash: string;
  ownerGeneration: string;
  workspaceHash: string;
  threadId: string;
  threadHash: string;
  committed?: TurnStateCandidate;
  candidates: TurnStateCandidate[];
};

type RegistryWorkspaceRecord = {
  schemaVersion: typeof TURN_STATE_SCHEMA_VERSION;
  ownerHash: string;
  ownerGeneration: string;
  workspaceHash: string;
  committed?: TurnStateWorkspaceHead;
  published?: TurnStateWorkspaceHead;
  candidate?: TurnStateWorkspaceHead;
};

type RegistryObjectRecord = {
  schemaVersion: typeof TURN_STATE_SCHEMA_VERSION;
  ownerHash: string;
  ownerGeneration: string;
  workspaceHash: string;
  threadHash: string;
  operationId: string;
  kind: "workspace" | "native";
  key: string;
  state: "reserved" | "uploaded" | "referenced" | "retiring";
  descriptor?: TurnStateArchive;
};

type RegistryOperationRecord = {
  schemaVersion: typeof TURN_STATE_SCHEMA_VERSION;
  identity: TurnStateIdentity;
  ownerHash: string;
  workspaceHash: string;
  threadHash: string;
  operationId: string;
  requestFingerprint: string;
  historyCursor: string;
  baseWorkspaceRevision: number;
  nativeCheckpoint?: TurnStateNativeCheckpoint;
  objectKeys: { workspace: string; native?: string };
  state: "prepared" | "committed";
  receipt?: string;
  createdAt: number;
};

type RegistryRetirementRecord = {
  schemaVersion: typeof TURN_STATE_SCHEMA_VERSION;
  ownerHash: string;
  ownerGeneration: string;
  workspaceHash: string;
  threadHash: string;
  operationId: string;
  objectKeys: string[];
  createdAt: number;
};

type AbortUnpublishedRecord = {
  schemaVersion: typeof TURN_STATE_SCHEMA_VERSION;
  ownerHash: string;
  ownerGeneration: string;
  workspaceHash: string;
  threadHash: string;
  threadId: string;
  operationId: string;
  baseWorkspaceRevision: number;
  candidateHistoryCursor: string;
  canonicalHistoryCursor: string;
  objectKeys: string[];
  abortReceipt: string;
};

type LegacySeedBinding = {
  schemaVersion: typeof TURN_STATE_SCHEMA_VERSION;
  ownerHash: string;
  ownerGeneration: string;
  workspaceHash: string;
  operationId: string;
  requestFingerprint: string;
  createdAt: number;
};

class TurnStateOwnerRouteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "TurnStateOwnerRouteError";
  }
}

const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const exactText = (value: unknown, max = 512): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f]/u.test(value);

const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const exactObject = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> => {
  if (!plainObject(value)) {
    throw new TurnStateOwnerRouteError(
      "JSON object required.",
      400,
      "invalid_json",
    );
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new TurnStateOwnerRouteError(
      "Turn state request shape is invalid.",
      400,
      "invalid_request",
    );
  }
  return value;
};

const requiredText = (
  row: Record<string, unknown>,
  key: string,
  max = 512,
): string => {
  const value = row[key];
  if (!exactText(value, max)) {
    throw new TurnStateOwnerRouteError(
      `${key} is invalid.`,
      400,
      "invalid_request",
    );
  }
  return value;
};

const requiredSafeInteger = (
  row: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  const value = row[key];
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new TurnStateOwnerRouteError(
      `${key} is invalid.`,
      400,
      "invalid_request",
    );
  }
  return value as number;
};

const requiredHex = (row: Record<string, unknown>, key: string): string => {
  const value = row[key];
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TurnStateOwnerRouteError(
      `${key} is invalid.`,
      400,
      "invalid_request",
    );
  }
  return value;
};

const readBoundedJson = async (request: Request): Promise<unknown> => {
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new TurnStateOwnerRouteError(
      "application/json required.",
      415,
      "invalid_content_type",
    );
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > MAX_REQUEST_BYTES
    ) {
      throw new TurnStateOwnerRouteError(
        "Turn state request is too large.",
        413,
        "request_too_large",
      );
    }
  }
  if (!request.body) {
    throw new TurnStateOwnerRouteError(
      "JSON object required.",
      400,
      "invalid_json",
    );
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new TurnStateOwnerRouteError(
          "Turn state request is too large.",
          413,
          "request_too_large",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    throw new TurnStateOwnerRouteError(
      "JSON object required.",
      400,
      "invalid_json",
    );
  }
};

const validateCheckpointKey = (key: string): void => {
  if (
    !exactText(key, MAX_STORAGE_KEY_BYTES) ||
    !key.startsWith(`${TURN_STATE_OBJECT_PREFIX}/`)
  ) {
    throw new Error("Turn state object key escaped the checkpoint prefix.");
  }
};

const validateRegistryKey = (key: string): void => {
  if (
    !exactText(key, MAX_STORAGE_KEY_BYTES) ||
    !key.startsWith("turn-state:v1:")
  ) {
    throw new Error("Turn state registry key escaped its namespace.");
  }
};

type DurableStorageBase = Pick<
  DurableObjectStorage,
  "get" | "put" | "delete" | "list"
>;

const bytewiseCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const adaptDurableStorage = (
  base: DurableStorageBase,
  transact: <T>(
    closure: (transaction: StrongTurnStateStorage) => Promise<T>,
  ) => Promise<T>,
): StrongTurnStateStorage => ({
  async get<T = unknown>(key: string): Promise<T | undefined> {
    validateRegistryKey(key);
    return await base.get<T>(key);
  },
  async put(key: string, value: unknown): Promise<void> {
    validateRegistryKey(key);
    await base.put(key, value);
  },
  async delete(key: string): Promise<boolean> {
    validateRegistryKey(key);
    return await base.delete(key);
  },
  async list<T = unknown>(
    options: { prefix?: string; startAfter?: string; limit?: number } = {},
  ): Promise<Map<string, T>> {
    const { prefix, startAfter, limit } = options;
    if (prefix !== undefined) validateRegistryKey(prefix);
    if (startAfter !== undefined) {
      validateRegistryKey(startAfter);
      if (prefix && !startAfter.startsWith(prefix)) {
        throw new Error("Turn state registry cursor escaped its prefix.");
      }
    }
    if (
      limit !== undefined &&
      (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
    ) {
      throw new Error("Turn state registry page size is invalid.");
    }
    const page = await base.list<T>({
      ...(prefix ? { prefix } : {}),
      ...(startAfter ? { startAfter } : {}),
      ...(limit ? { limit } : {}),
    });
    if (limit !== undefined && page.size > limit) {
      throw new Error("Turn state registry returned an oversized page.");
    }
    const rows = [...page.entries()].sort(([left], [right]) =>
      bytewiseCompare(left, right),
    );
    for (const [key] of rows) {
      validateRegistryKey(key);
      if (
        (prefix && !key.startsWith(prefix)) ||
        (startAfter && key <= startAfter)
      ) {
        throw new Error("Turn state registry listing escaped its page.");
      }
    }
    return new Map(rows);
  },
  transaction: transact,
});

/** Cloudflare Durable Object storage adapter used by the registry. */
export const createDurableObjectTurnStateStorage = (
  storage: DurableObjectStorage,
): StrongTurnStateStorage => {
  let root!: StrongTurnStateStorage;
  root = adaptDurableStorage(
    storage,
    async (closure) =>
      await storage.transaction(async (transaction) => {
        const wrapped = createTransactionTurnStateStorage(transaction);
        return await closure(wrapped);
      }),
  );
  return root;
};

const createTransactionTurnStateStorage = (
  transaction: DurableObjectTransaction,
): StrongTurnStateStorage => {
  let wrapped!: StrongTurnStateStorage;
  wrapped = adaptDurableStorage(
    transaction,
    async (nested) => await nested(wrapped),
  );
  return wrapped;
};

const validateR2Cursor = (cursor: string): void => {
  if (!exactText(cursor, MAX_CURSOR_BYTES)) {
    throw new Error("Turn state R2 cursor is invalid.");
  }
};

/** R2 adapter used for full-prefix deletion and read-after-delete checks. */
export const createR2TurnStateObjectStore = (
  bucket: R2Bucket,
): TurnStateObjectStore => ({
  async list(prefix: string, cursor?: string) {
    if (
      !exactText(prefix, MAX_STORAGE_KEY_BYTES) ||
      !prefix.startsWith(`${TURN_STATE_OBJECT_PREFIX}/`) ||
      !prefix.endsWith("/")
    ) {
      throw new Error("Turn state R2 prefix is invalid.");
    }
    if (cursor !== undefined) validateR2Cursor(cursor);
    const page = await bucket.list({
      prefix,
      ...(cursor ? { cursor } : {}),
      limit: 1_000,
    });
    const keys = page.objects.map((object) => object.key).sort(bytewiseCompare);
    if (new Set(keys).size !== keys.length) {
      throw new Error("Turn state R2 listing returned duplicate keys.");
    }
    for (const key of keys) {
      validateCheckpointKey(key);
      if (!key.startsWith(prefix)) {
        throw new Error("Turn state R2 listing escaped its prefix.");
      }
    }
    if (page.truncated) {
      validateR2Cursor(page.cursor);
      if (page.cursor === cursor) {
        throw new Error("Turn state R2 listing did not advance.");
      }
      return { keys, cursor: page.cursor, complete: false };
    }
    return { keys, complete: true };
  },
  async delete(key: string): Promise<void> {
    validateCheckpointKey(key);
    await bucket.delete(key);
  },
  async head(key: string): Promise<{ size: number; etag: string } | null> {
    validateCheckpointKey(key);
    const object = await bucket.head(key);
    if (!object) return null;
    if (
      !Number.isSafeInteger(object.size) ||
      object.size < 0 ||
      object.size > TURN_STATE_MAX_ARCHIVE_BYTES ||
      !exactText(object.etag, 512)
    ) {
      throw new Error("Turn state R2 HEAD metadata is invalid.");
    }
    return { size: object.size, etag: object.etag };
  },
});

const parseCommonLease = (
  row: Record<string, unknown>,
): {
  ownerId: string;
  ownerGeneration: string;
  generation: string;
  leaseId: string;
  sessionId: string;
  turnId: string;
} => ({
  ownerId: requiredText(row, "ownerId"),
  ownerGeneration: requiredText(row, "ownerGeneration"),
  generation: requiredText(row, "generation"),
  leaseId: requiredText(row, "leaseId"),
  sessionId: requiredText(row, "sessionId"),
  turnId: requiredText(row, "turnId"),
});

const assertOwnerScope = (
  scopedOwnerId: string,
  fence: TurnStateOwnerFence,
  requestedOwnerId: string,
): void => {
  if (
    !exactText(scopedOwnerId) ||
    !exactText(fence.ownerId) ||
    fence.ownerId !== scopedOwnerId ||
    requestedOwnerId !== scopedOwnerId
  ) {
    throw new TurnStateOwnerRouteError(
      "Turn state owner scope changed.",
      409,
      "owner_scope_mismatch",
    );
  }
};

const assertOpenLease = (
  scopedOwnerId: string,
  fence: TurnStateOwnerFence,
  request: ReturnType<typeof parseCommonLease>,
): OwnerLease => {
  assertOwnerScope(scopedOwnerId, fence, request.ownerId);
  const active = fence.active[request.leaseId];
  if (
    fence.state !== "open" ||
    request.generation !== fence.generation ||
    !active ||
    active.leaseId !== request.leaseId ||
    active.sessionId !== request.sessionId ||
    active.turnId !== request.turnId ||
    active.ownerGeneration !== request.ownerGeneration ||
    active.namespace !== "build" ||
    active.role !== "run"
  ) {
    throw new TurnStateOwnerRouteError(
      "The exact owner turn lease is no longer open.",
      409,
      "owner_fence_changed",
    );
  }
  return active;
};

const withCurrentOpenLeaseTransaction = async <T>(
  args: {
    storage: DurableObjectStorage;
    scopedOwnerId: string;
  },
  request: ReturnType<typeof parseCommonLease>,
  operation: (
    storage: StrongTurnStateStorage,
    fence: TurnStateOwnerFence,
  ) => Promise<T>,
): Promise<T> =>
  await args.storage.transaction(async (transaction) => {
    const fence = await transaction.get<TurnStateOwnerFence>(OWNER_FENCE_KEY);
    if (!fence) {
      throw new TurnStateOwnerRouteError(
        "The durable owner fence is missing.",
        409,
        "owner_fence_changed",
      );
    }
    assertOpenLease(args.scopedOwnerId, fence, request);
    return await operation(
      createTransactionTurnStateStorage(transaction),
      fence,
    );
  });

const assertOpenWorldActivityLease = (
  scopedOwnerId: string,
  fence: TurnStateOwnerFence,
  request: ReturnType<typeof parseCommonLease>,
  now: number,
): OwnerLease => {
  assertOwnerScope(scopedOwnerId, fence, request.ownerId);
  const active = fence.active[request.leaseId];
  if (
    fence.state !== "open" ||
    request.generation !== fence.generation ||
    !active ||
    active.leaseId !== request.leaseId ||
    active.sessionId !== request.sessionId ||
    active.turnId !== request.turnId ||
    active.ownerGeneration !== request.ownerGeneration ||
    active.namespace !== "activity" ||
    active.role !== "run" ||
    !Number.isSafeInteger(active.expiresAt) ||
    active.expiresAt! <= now
  ) {
    throw new TurnStateOwnerRouteError(
      "The exact world purge lease is no longer open.",
      409,
      "owner_fence_changed",
    );
  }
  return active;
};

const withCurrentOpenWorldActivityLeaseTransaction = async <T>(
  args: {
    storage: DurableObjectStorage;
    scopedOwnerId: string;
    now?: () => number;
  },
  request: ReturnType<typeof parseCommonLease>,
  operation: (storage: StrongTurnStateStorage) => Promise<T>,
): Promise<T> =>
  await args.storage.transaction(async (transaction) => {
    const fence = await transaction.get<TurnStateOwnerFence>(OWNER_FENCE_KEY);
    if (!fence) {
      throw new TurnStateOwnerRouteError(
        "The durable owner fence is missing.",
        409,
        "owner_fence_changed",
      );
    }
    assertOpenWorldActivityLease(
      args.scopedOwnerId,
      fence,
      request,
      transferRouteNow(args.now),
    );
    return await operation(createTransactionTurnStateStorage(transaction));
  });

type TransferRouteIdentity = ReturnType<typeof parseCommonLease> & {
  transferOperationId: string;
  fromOwnerId: string;
  fromOwnerGeneration: string;
  toOwnerId: string;
  toOwnerGeneration: string;
};

const parseTransferIdentity = (
  row: Record<string, unknown>,
  side: "source" | "destination",
): TransferRouteIdentity => {
  const lease = parseCommonLease(row);
  const transferOperationId = requiredHex(row, "transferOperationId");
  const fromOwnerId = requiredText(row, "fromOwnerId");
  const fromOwnerGeneration = requiredText(row, "fromOwnerGeneration");
  const toOwnerId = requiredText(row, "toOwnerId");
  const toOwnerGeneration = requiredText(row, "toOwnerGeneration");
  if (
    fromOwnerId === toOwnerId ||
    lease.turnId !== `owner-transfer:${transferOperationId}` ||
    (side === "source" &&
      (lease.ownerId !== fromOwnerId ||
        lease.ownerGeneration !== fromOwnerGeneration)) ||
    (side === "destination" &&
      (lease.ownerId !== toOwnerId ||
        lease.ownerGeneration !== toOwnerGeneration))
  ) {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer identity is invalid.",
      400,
      "invalid_request",
    );
  }
  return {
    ...lease,
    transferOperationId,
    fromOwnerId,
    fromOwnerGeneration,
    toOwnerId,
    toOwnerGeneration,
  };
};

const assertTransferLease = (
  scopedOwnerId: string,
  fence: TurnStateOwnerFence,
  request: TransferRouteIdentity,
  now: number,
): OwnerLease => {
  assertOwnerScope(scopedOwnerId, fence, request.ownerId);
  const active = fence.active[request.leaseId];
  if (
    !active ||
    active.leaseId !== request.leaseId ||
    active.sessionId !== request.sessionId ||
    active.turnId !== request.turnId ||
    active.ownerGeneration !== request.ownerGeneration ||
    active.namespace !== "activity" ||
    active.role !== "transfer" ||
    active.reservationGeneration !== request.generation ||
    !Number.isSafeInteger(active.expiresAt) ||
    (active.expiresAt as number) <= now
  ) {
    throw new TurnStateOwnerRouteError(
      "The exact owner transfer reservation is no longer active.",
      409,
      "owner_transfer_fence_changed",
    );
  }
  return active;
};

const transferRouteNow = (now: (() => number) | undefined): number => {
  const value = now?.() ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Turn state transfer route clock is invalid.");
  }
  return value;
};

const withCurrentTransferLeaseTransaction = async <T>(
  args: {
    storage: DurableObjectStorage;
    scopedOwnerId: string;
    nativeIntegritySecret?: string;
    now?: () => number;
  },
  request: TransferRouteIdentity,
  operation: (
    storage: StrongTurnStateStorage,
    fence: TurnStateOwnerFence,
  ) => Promise<T>,
): Promise<T> =>
  await args.storage.transaction(async (transaction) => {
    const fence = await transaction.get<TurnStateOwnerFence>(OWNER_FENCE_KEY);
    if (!fence) {
      throw new TurnStateOwnerRouteError(
        "The durable owner transfer fence is missing.",
        409,
        "owner_transfer_fence_changed",
      );
    }
    assertTransferLease(
      args.scopedOwnerId,
      fence,
      request,
      transferRouteNow(args.now),
    );
    return await operation(
      createTransactionTurnStateStorage(transaction),
      fence,
    );
  });

const currentBlockedFence = async (
  storage: DurableObjectStorage,
  scopedOwnerId: string,
  row: Record<string, unknown>,
): Promise<{
  fence: TurnStateOwnerFence;
  ownerId: string;
  generation: string;
}> => {
  const fence = await storage.get<TurnStateOwnerFence>(OWNER_FENCE_KEY);
  if (!fence) {
    throw new TurnStateOwnerRouteError(
      "The durable owner fence is missing.",
      409,
      "owner_purge_fence_changed",
    );
  }
  const blocked = assertBlockedFence(scopedOwnerId, fence, row);
  return { fence, ...blocked };
};

const assertBlockedFence = (
  scopedOwnerId: string,
  fence: TurnStateOwnerFence,
  row: Record<string, unknown>,
): { ownerId: string; generation: string } => {
  const ownerId = requiredText(row, "ownerId");
  const generation = requiredText(row, "generation");
  assertOwnerScope(scopedOwnerId, fence, ownerId);
  if (
    fence.state !== "blocked" ||
    fence.generation !== generation ||
    Object.keys(fence.active).length !== 0
  ) {
    throw new TurnStateOwnerRouteError(
      "The blocked owner purge generation is not drained.",
      409,
      "owner_purge_fence_changed",
    );
  }
  return { ownerId, generation };
};

const parseNativeCheckpoint = (
  value: unknown,
  historyCursor: string,
): TurnStateNativeCheckpoint => {
  const row = exactObject(value, [
    "engine",
    "sessionId",
    "cursor",
    "tree",
    "mac",
  ]);
  if (row.engine !== "anthropic") {
    throw new TurnStateOwnerRouteError(
      "Native checkpoint engine is invalid.",
      400,
      "invalid_request",
    );
  }
  const cursor = requiredText(row, "cursor", 1_024);
  if (cursor !== historyCursor) {
    throw new TurnStateOwnerRouteError(
      "Native checkpoint cursor is invalid.",
      400,
      "invalid_request",
    );
  }
  const tree = exactObject(row.tree, [
    "algorithm",
    "digest",
    "entries",
    "bytes",
  ]);
  if (tree.algorithm !== "sha256") {
    throw new TurnStateOwnerRouteError(
      "Native checkpoint tree is invalid.",
      400,
      "invalid_request",
    );
  }
  return {
    engine: "anthropic",
    sessionId: requiredText(row, "sessionId"),
    cursor,
    tree: {
      algorithm: "sha256",
      digest: requiredHex(tree, "digest"),
      entries: requiredSafeInteger(tree, "entries", 1, 10_000_000),
      bytes: requiredSafeInteger(
        tree,
        "bytes",
        0,
        TURN_STATE_MAX_ARCHIVE_BYTES,
      ),
    },
    mac: requiredHex(row, "mac"),
  };
};

const parseArchive = (value: unknown): TurnStateArchive => {
  const row = exactObject(value, [
    "schemaVersion",
    "kind",
    "format",
    "key",
    "sizeBytes",
    "sha256",
    "etag",
    "complete",
  ]);
  if (
    row.schemaVersion !== TURN_STATE_SCHEMA_VERSION ||
    (row.kind !== "workspace" && row.kind !== "native") ||
    row.format !== TURN_STATE_OBJECT_FORMAT ||
    row.complete !== true
  ) {
    throw new TurnStateOwnerRouteError(
      "Turn state archive is invalid.",
      400,
      "invalid_request",
    );
  }
  const key = requiredText(row, "key", MAX_STORAGE_KEY_BYTES);
  if (!key.startsWith(`${TURN_STATE_OBJECT_PREFIX}/`)) {
    throw new TurnStateOwnerRouteError(
      "Turn state archive key is invalid.",
      400,
      "invalid_request",
    );
  }
  return {
    schemaVersion: TURN_STATE_SCHEMA_VERSION,
    kind: row.kind,
    format: TURN_STATE_OBJECT_FORMAT,
    key,
    sizeBytes: requiredSafeInteger(
      row,
      "sizeBytes",
      1,
      TURN_STATE_MAX_ARCHIVE_BYTES,
    ),
    sha256: requiredHex(row, "sha256"),
    etag: requiredText(row, "etag"),
    complete: true,
  };
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!plainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(bytewiseCompare)
      .map((key) => [key, canonicalize(value[key])]),
  );
};

const canonicalDigest = async (value: unknown): Promise<string> =>
  await sha256Hex(JSON.stringify(canonicalize(value)));

const nativeIntegrityKey = async (
  secret: string,
  ownerId: string,
  ownerGeneration: string,
  threadId: string,
): Promise<string> =>
  await sha256Hex(
    ["stella-native-state-v2", secret, ownerId, ownerGeneration, threadId].join(
      "\u0000",
    ),
  );

const nativeCheckpointPayload = (
  checkpoint: TurnStateNativeCheckpoint,
  threadId: string,
): string =>
  JSON.stringify([
    2,
    checkpoint.engine,
    threadId,
    checkpoint.sessionId,
    checkpoint.cursor,
    checkpoint.tree.algorithm,
    checkpoint.tree.digest,
    checkpoint.tree.entries,
    checkpoint.tree.bytes,
  ]);

const signNativeCheckpoint = async (
  checkpoint: TurnStateNativeCheckpoint,
  threadId: string,
  integrityKey: string,
): Promise<TurnStateNativeCheckpoint> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(integrityKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(nativeCheckpointPayload(checkpoint, threadId)),
  );
  return {
    ...checkpoint,
    mac: Array.from(new Uint8Array(signature), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
  };
};

const requireNativeIntegritySecret = (secret: string | undefined): string => {
  if (!exactText(secret, 4_096)) {
    throw new TurnStateOwnerRouteError(
      "Turn state native transfer integrity is unavailable.",
      503,
      "turn_state_transfer_native_unavailable",
    );
  }
  return secret;
};

const assertSourceNativeCheckpoint = async (
  checkpoint: TurnStateNativeCheckpoint | undefined,
  identity: TransferRouteIdentity,
  threadId: string,
  secret: string | undefined,
): Promise<void> => {
  if (!checkpoint) return;
  const integrityKey = await nativeIntegrityKey(
    requireNativeIntegritySecret(secret),
    identity.fromOwnerId,
    identity.fromOwnerGeneration,
    threadId,
  );
  if (
    !(await validNativeStateCheckpointMac({
      checkpoint,
      threadId,
      integrityKey,
    }))
  ) {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer native checkpoint failed source integrity.",
      409,
      "turn_state_transfer_native_conflict",
    );
  }
};

const remacDestinationNativeCheckpoint = async (
  checkpoint: TurnStateNativeCheckpoint | undefined,
  identity: TransferRouteIdentity,
  threadId: string,
  secret: string | undefined,
): Promise<TurnStateNativeCheckpoint | undefined> => {
  if (!checkpoint) return undefined;
  const integrityKey = await nativeIntegrityKey(
    requireNativeIntegritySecret(secret),
    identity.toOwnerId,
    identity.toOwnerGeneration,
    threadId,
  );
  return await signNativeCheckpoint(checkpoint, threadId, integrityKey);
};

const assertDestinationNativeCheckpoint = async (
  checkpoint: TurnStateNativeCheckpoint | undefined,
  identity: TransferRouteIdentity,
  threadId: string,
  secret: string | undefined,
): Promise<void> => {
  if (!checkpoint) return;
  const integrityKey = await nativeIntegrityKey(
    requireNativeIntegritySecret(secret),
    identity.toOwnerId,
    identity.toOwnerGeneration,
    threadId,
  );
  if (
    !(await validNativeStateCheckpointMac({
      checkpoint,
      threadId,
      integrityKey,
    }))
  ) {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer native checkpoint failed destination integrity.",
      409,
      "turn_state_transfer_native_conflict",
    );
  }
};

const parseTransferCandidate = (value: unknown): TurnStateCandidate => {
  const row = exactObject(
    value,
    [
      "schemaVersion",
      "operationId",
      "requestFingerprint",
      "historyCursor",
      "workspace",
      "receipt",
      "createdAt",
    ],
    ["native", "nativeCheckpoint"],
  );
  if (row.schemaVersion !== TURN_STATE_SCHEMA_VERSION) {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer candidate is invalid.",
      400,
      "invalid_request",
    );
  }
  const historyCursor = requiredText(row, "historyCursor", 1_024);
  const workspaceArchive = parseArchive(row.workspace);
  if (workspaceArchive.kind !== "workspace") {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer workspace archive is invalid.",
      400,
      "invalid_request",
    );
  }
  const hasNative = Object.hasOwn(row, "native");
  const hasNativeCheckpoint = Object.hasOwn(row, "nativeCheckpoint");
  if (hasNative !== hasNativeCheckpoint) {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer native pair is incomplete.",
      400,
      "invalid_request",
    );
  }
  const native = hasNative ? parseArchive(row.native) : undefined;
  if (native && native.kind !== "native") {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer native archive is invalid.",
      400,
      "invalid_request",
    );
  }
  const nativeCheckpoint = hasNativeCheckpoint
    ? parseNativeCheckpoint(row.nativeCheckpoint, historyCursor)
    : undefined;
  return {
    schemaVersion: TURN_STATE_SCHEMA_VERSION,
    operationId: requiredHex(row, "operationId"),
    requestFingerprint: requiredHex(row, "requestFingerprint"),
    historyCursor,
    workspace: workspaceArchive,
    ...(native ? { native } : {}),
    ...(nativeCheckpoint ? { nativeCheckpoint } : {}),
    receipt: requiredHex(row, "receipt"),
    createdAt: requiredSafeInteger(row, "createdAt", 0),
  };
};

const candidateReceipt = async (
  candidate: Omit<TurnStateCandidate, "receipt">,
): Promise<string> =>
  await sha256Hex(
    JSON.stringify([
      TURN_STATE_SCHEMA_VERSION,
      candidate.operationId,
      candidate.requestFingerprint,
      candidate.historyCursor,
      candidate.workspace,
      candidate.native ?? null,
      candidate.nativeCheckpoint ?? null,
    ]),
  );

const assertCandidateReceipt = async (
  candidate: TurnStateCandidate,
): Promise<void> => {
  const { receipt, ...unsigned } = candidate;
  if ((await candidateReceipt(unsigned)) !== receipt) {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer candidate receipt is invalid.",
      409,
      "turn_state_transfer_conflict",
    );
  }
};

const parseTransferWorkspaceHead = (value: unknown): TurnStateWorkspaceHead => {
  const row = exactObject(value, [
    "schemaVersion",
    "operationId",
    "requestFingerprint",
    "revision",
    "originThreadHash",
    "originHistoryCursor",
    "archive",
    "receipt",
    "createdAt",
  ]);
  if (row.schemaVersion !== TURN_STATE_SCHEMA_VERSION) {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer workspace head is invalid.",
      400,
      "invalid_request",
    );
  }
  const archive = parseArchive(row.archive);
  if (archive.kind !== "workspace") {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer workspace head archive is invalid.",
      400,
      "invalid_request",
    );
  }
  return {
    schemaVersion: TURN_STATE_SCHEMA_VERSION,
    operationId: requiredHex(row, "operationId"),
    requestFingerprint: requiredHex(row, "requestFingerprint"),
    revision: requiredSafeInteger(row, "revision", 1),
    originThreadHash: requiredHex(row, "originThreadHash"),
    originHistoryCursor: requiredText(row, "originHistoryCursor", 1_024),
    archive,
    receipt: requiredHex(row, "receipt"),
    createdAt: requiredSafeInteger(row, "createdAt", 0),
  };
};

const workspaceHeadReceipt = async (
  head: Omit<TurnStateWorkspaceHead, "receipt">,
  ownerHash: string,
  ownerGeneration: string,
  workspaceHash: string,
): Promise<string> =>
  await sha256Hex(
    JSON.stringify([
      TURN_STATE_SCHEMA_VERSION,
      ownerHash,
      ownerGeneration,
      workspaceHash,
      head.revision,
      head.operationId,
      head.requestFingerprint,
      head.archive,
    ]),
  );

const assertWorkspaceHeadReceipt = async (
  head: TurnStateWorkspaceHead,
  ownerHash: string,
  ownerGeneration: string,
  workspaceHash: string,
): Promise<void> => {
  const { receipt, ...unsigned } = head;
  if (
    (await workspaceHeadReceipt(
      unsigned,
      ownerHash,
      ownerGeneration,
      workspaceHash,
    )) !== receipt
  ) {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer workspace head receipt is invalid.",
      409,
      "turn_state_transfer_conflict",
    );
  }
};

const parseTransferThreadCandidate = (
  value: unknown,
): TurnStateTransferThreadCandidate => {
  const row = exactObject(
    value,
    [
      "schemaVersion",
      "sourceOperationId",
      "requestFingerprint",
      "historyCursor",
      "createdAt",
    ],
    ["native", "nativeCheckpoint"],
  );
  if (row.schemaVersion !== TURN_STATE_SCHEMA_VERSION) {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer thread candidate is invalid.",
      400,
      "invalid_request",
    );
  }
  const historyCursor = requiredText(row, "historyCursor", 1_024);
  const hasNative = Object.hasOwn(row, "native");
  const hasNativeCheckpoint = Object.hasOwn(row, "nativeCheckpoint");
  if (hasNative !== hasNativeCheckpoint) {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer native pair is incomplete.",
      400,
      "invalid_request",
    );
  }
  const native = hasNative ? parseArchive(row.native) : undefined;
  if (native && native.kind !== "native") {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer native archive is invalid.",
      400,
      "invalid_request",
    );
  }
  const nativeCheckpoint = hasNativeCheckpoint
    ? parseNativeCheckpoint(row.nativeCheckpoint, historyCursor)
    : undefined;
  return {
    schemaVersion: TURN_STATE_SCHEMA_VERSION,
    sourceOperationId: requiredHex(row, "sourceOperationId"),
    requestFingerprint: requiredHex(row, "requestFingerprint"),
    historyCursor,
    ...(native ? { native } : {}),
    ...(nativeCheckpoint ? { nativeCheckpoint } : {}),
    createdAt: requiredSafeInteger(row, "createdAt", 0),
  };
};

const transferEntryFingerprint = async (
  entry: UnsignedTurnStateTransferEntry,
): Promise<string> =>
  await canonicalDigest(["stella-turn-state-transfer-entry-v2", entry]);

const transferEntryKey = (entry: TurnStateTransferEntry): string => {
  if (entry.entryKind === "workspace") {
    const rank =
      entry.disposition === "committed"
        ? 0
        : entry.disposition === "published"
          ? 1
          : 2;
    return `0:workspace:${rank}`;
  }
  return `1:thread:${entry.threadHash}:${entry.disposition === "committed" ? 0 : 1}:${entry.candidateOrdinal ?? -1}`;
};

const transferManifestFingerprint = async (
  manifest: Omit<TurnStateTransferManifest, "fingerprint">,
  entries: Array<[entryKey: string, entryFingerprint: string]>,
): Promise<string> =>
  await canonicalDigest([
    "stella-turn-state-transfer-manifest-v2",
    manifest.schemaVersion,
    manifest.transferOperationId,
    manifest.sourceOwnerHash,
    manifest.sourceOwnerGeneration,
    manifest.sourceWorkspaceHash,
    manifest.destinationOwnerHash,
    manifest.destinationOwnerGeneration,
    manifest.destinationWorkspaceHash,
    manifest.count,
    [...entries].sort(
      ([leftKey, leftEntry], [rightKey, rightEntry]) =>
        bytewiseCompare(leftKey, rightKey) ||
        bytewiseCompare(leftEntry, rightEntry),
    ),
  ]);

const transferActivationReceipt = async (
  manifest: TurnStateTransferManifest,
): Promise<string> =>
  await canonicalDigest([
    "stella-turn-state-transfer-activation-v2",
    manifest.schemaVersion,
    manifest.transferOperationId,
    manifest.fingerprint,
    manifest.destinationOwnerHash,
    manifest.destinationOwnerGeneration,
    manifest.destinationWorkspaceHash,
    manifest.count,
  ]);

const parseTransferManifest = (value: unknown): TurnStateTransferManifest => {
  const row = exactObject(value, [
    "schemaVersion",
    "transferOperationId",
    "sourceOwnerHash",
    "sourceOwnerGeneration",
    "sourceWorkspaceHash",
    "destinationOwnerHash",
    "destinationOwnerGeneration",
    "destinationWorkspaceHash",
    "count",
    "fingerprint",
  ]);
  if (row.schemaVersion !== TURN_STATE_SCHEMA_VERSION) {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer manifest is invalid.",
      400,
      "invalid_request",
    );
  }
  return {
    schemaVersion: TURN_STATE_SCHEMA_VERSION,
    transferOperationId: requiredHex(row, "transferOperationId"),
    sourceOwnerHash: requiredHex(row, "sourceOwnerHash"),
    sourceOwnerGeneration: requiredText(row, "sourceOwnerGeneration"),
    sourceWorkspaceHash: requiredHex(row, "sourceWorkspaceHash"),
    destinationOwnerHash: requiredHex(row, "destinationOwnerHash"),
    destinationOwnerGeneration: requiredText(row, "destinationOwnerGeneration"),
    destinationWorkspaceHash: requiredHex(row, "destinationWorkspaceHash"),
    count: requiredSafeInteger(row, "count", 0, MAX_TRANSFER_ENTRIES),
    fingerprint: requiredHex(row, "fingerprint"),
  };
};

const transferIdentityHashes = async (identity: TransferRouteIdentity) => {
  const [
    sourceOwnerHash,
    sourceWorkspaceHash,
    destinationOwnerHash,
    destinationWorkspaceHash,
  ] = await Promise.all([
    sha256Hex(identity.fromOwnerId),
    sha256Hex(WORLD_REGISTRY_SEGMENT),
    sha256Hex(identity.toOwnerId),
    sha256Hex(WORLD_REGISTRY_SEGMENT),
  ]);
  return {
    sourceOwnerHash,
    sourceWorkspaceHash,
    destinationOwnerHash,
    destinationWorkspaceHash,
  };
};

const assertManifestIdentity = async (
  manifest: TurnStateTransferManifest,
  identity: TransferRouteIdentity,
): Promise<void> => {
  const hashes = await transferIdentityHashes(identity);
  if (
    manifest.transferOperationId !== identity.transferOperationId ||
    manifest.sourceOwnerHash !== hashes.sourceOwnerHash ||
    manifest.sourceOwnerGeneration !== identity.fromOwnerGeneration ||
    manifest.sourceWorkspaceHash !== hashes.sourceWorkspaceHash ||
    manifest.destinationOwnerHash !== hashes.destinationOwnerHash ||
    manifest.destinationOwnerGeneration !== identity.toOwnerGeneration ||
    manifest.destinationWorkspaceHash !== hashes.destinationWorkspaceHash
  ) {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer manifest belongs to another transfer.",
      409,
      "turn_state_transfer_conflict",
    );
  }
};

const assertCandidateArchiveScope = (
  candidate: TurnStateCandidate,
  ownerHash: string,
  workspaceHash: string,
  threadHash: string,
): void => {
  const prefix = `${TURN_STATE_OBJECT_PREFIX}/${ownerHash}/${workspaceHash}/${threadHash}/`;
  if (
    !candidate.workspace.key.startsWith(prefix) ||
    (candidate.native && !candidate.native.key.startsWith(prefix))
  ) {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer archive escaped its source scope.",
      409,
      "turn_state_transfer_conflict",
    );
  }
};

const collectSourceTransferEntries = async (
  storage: StrongTurnStateStorage,
  identity: TransferRouteIdentity,
  nativeIntegritySecret?: string,
): Promise<{
  manifest: TurnStateTransferManifest;
  entries: TurnStateTransferEntry[];
}> => {
  const hashes = await transferIdentityHashes(identity);
  const threadPrefix = `turn-state:v1:thread:${hashes.sourceWorkspaceHash}:`;
  const rows = await listAllStrongRecords(storage);
  const entries: TurnStateTransferEntry[] = [];
  const threadIds = new Map<string, string>();
  const threadCandidates = new Map<
    string,
    Array<{
      disposition: "committed" | "candidate";
      candidate: TurnStateCandidate;
    }>
  >();

  for (const [key, value] of rows) {
    if (!key.startsWith(threadPrefix)) continue;
    const threadHash = key.slice(threadPrefix.length);
    if (!/^[0-9a-f]{64}$/u.test(threadHash) || !plainObject(value)) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer source registry is malformed.",
        409,
        "turn_state_transfer_conflict",
      );
    }
    const thread = value as RegistryThreadRecord;
    if (
      thread.schemaVersion !== TURN_STATE_SCHEMA_VERSION ||
      thread.ownerHash !== hashes.sourceOwnerHash ||
      thread.ownerGeneration !== identity.fromOwnerGeneration ||
      thread.workspaceHash !== hashes.sourceWorkspaceHash ||
      thread.threadHash !== threadHash ||
      !exactText(thread.threadId) ||
      (await sha256Hex(thread.threadId)) !== threadHash ||
      !Array.isArray(thread.candidates) ||
      thread.candidates.length > 8
    ) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer source registry is malformed.",
        409,
        "turn_state_transfer_conflict",
      );
    }
    threadIds.set(threadHash, thread.threadId);
    const slots: Array<{
      disposition: "committed" | "candidate";
      candidateOrdinal?: number;
      value: unknown;
    }> = [
      ...(thread.committed
        ? [{ disposition: "committed" as const, value: thread.committed }]
        : []),
      ...thread.candidates.map((candidate, candidateOrdinal) => ({
        disposition: "candidate" as const,
        candidateOrdinal,
        value: candidate,
      })),
    ];
    const exactCandidates: Array<{
      disposition: "committed" | "candidate";
      candidate: TurnStateCandidate;
    }> = [];
    for (const slot of slots) {
      const candidate = parseTransferCandidate(slot.value);
      await assertCandidateReceipt(candidate);
      await assertSourceNativeCheckpoint(
        candidate.nativeCheckpoint,
        identity,
        thread.threadId,
        nativeIntegritySecret,
      );
      assertCandidateArchiveScope(
        candidate,
        hashes.sourceOwnerHash,
        hashes.sourceWorkspaceHash,
        threadHash,
      );
      exactCandidates.push({
        disposition: slot.disposition,
        candidate,
      });
      const transferCandidate: TurnStateTransferThreadCandidate = {
        schemaVersion: TURN_STATE_SCHEMA_VERSION,
        sourceOperationId: candidate.operationId,
        requestFingerprint: candidate.requestFingerprint,
        historyCursor: candidate.historyCursor,
        ...(candidate.native ? { native: candidate.native } : {}),
        ...(candidate.nativeCheckpoint
          ? { nativeCheckpoint: candidate.nativeCheckpoint }
          : {}),
        createdAt: candidate.createdAt,
      };
      const unsignedEntry: UnsignedTurnStateTransferEntry = {
        entryKind: "thread",
        threadId: thread.threadId,
        threadHash,
        disposition: slot.disposition,
        ...(slot.candidateOrdinal !== undefined
          ? { candidateOrdinal: slot.candidateOrdinal }
          : {}),
        candidate: transferCandidate,
      };
      entries.push({
        schemaVersion: TURN_STATE_SCHEMA_VERSION,
        ...unsignedEntry,
        entryFingerprint: await transferEntryFingerprint(unsignedEntry),
      });
    }
    threadCandidates.set(threadHash, exactCandidates);
  }

  const workspaceKey = `turn-state:v1:workspace:${hashes.sourceWorkspaceHash}`;
  const rawWorkspace = rows.get(workspaceKey);
  if (rawWorkspace !== undefined) {
    if (!plainObject(rawWorkspace)) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer workspace registry is malformed.",
        409,
        "turn_state_transfer_conflict",
      );
    }
    const workspaceState = rawWorkspace as RegistryWorkspaceRecord;
    if (
      workspaceState.schemaVersion !== TURN_STATE_SCHEMA_VERSION ||
      workspaceState.ownerHash !== hashes.sourceOwnerHash ||
      workspaceState.ownerGeneration !== identity.fromOwnerGeneration ||
      workspaceState.workspaceHash !== hashes.sourceWorkspaceHash
    ) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer workspace registry is malformed.",
        409,
        "turn_state_transfer_conflict",
      );
    }
    if (workspaceState.candidate && workspaceState.published) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer workspace publication topology is invalid.",
        409,
        "turn_state_transfer_conflict",
      );
    }
    const workspaceSlots: Array<{
      disposition: "committed" | "published" | "candidate";
      value: unknown;
    }> = [
      ...(workspaceState.committed
        ? [
            {
              disposition: "committed" as const,
              value: workspaceState.committed,
            },
          ]
        : []),
      ...(workspaceState.published
        ? [
            {
              disposition: "published" as const,
              value: workspaceState.published,
            },
          ]
        : []),
      ...(workspaceState.candidate
        ? [
            {
              disposition: "candidate" as const,
              value: workspaceState.candidate,
            },
          ]
        : []),
    ];
    const exactHeads: TurnStateWorkspaceHead[] = [];
    for (const slot of workspaceSlots) {
      const head = parseTransferWorkspaceHead(slot.value);
      const originThreadId = threadIds.get(head.originThreadHash);
      const matchingThreadState = threadCandidates
        .get(head.originThreadHash)
        ?.find(
          ({ candidate }) =>
            candidate.operationId === head.operationId &&
            candidate.historyCursor === head.originHistoryCursor &&
            candidate.requestFingerprint === head.requestFingerprint,
        );
      const archivePrefix = `${TURN_STATE_OBJECT_PREFIX}/${hashes.sourceOwnerHash}/${hashes.sourceWorkspaceHash}/${head.originThreadHash}/`;
      if (
        !originThreadId ||
        !matchingThreadState ||
        (slot.disposition === "candidate" &&
          matchingThreadState.disposition !== "candidate") ||
        matchingThreadState.candidate.createdAt !== head.createdAt ||
        !sameJson(matchingThreadState.candidate.workspace, head.archive) ||
        !head.archive.key.startsWith(archivePrefix)
      ) {
        throw new TurnStateOwnerRouteError(
          "Turn state transfer workspace origin is invalid.",
          409,
          "turn_state_transfer_conflict",
        );
      }
      await assertWorkspaceHeadReceipt(
        head,
        hashes.sourceOwnerHash,
        identity.fromOwnerGeneration,
        hashes.sourceWorkspaceHash,
      );
      exactHeads.push(head);
      const unsignedEntry: UnsignedTurnStateTransferEntry = {
        entryKind: "workspace",
        disposition: slot.disposition,
        originThreadId,
        head,
      };
      entries.push({
        schemaVersion: TURN_STATE_SCHEMA_VERSION,
        ...unsignedEntry,
        entryFingerprint: await transferEntryFingerprint(unsignedEntry),
      });
    }
    const committedRevision = workspaceState.committed?.revision ?? 0;
    const pending = workspaceState.published ?? workspaceState.candidate;
    if (pending && pending.revision !== committedRevision + 1) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer workspace revision topology is invalid.",
        409,
        "turn_state_transfer_conflict",
      );
    }
    if (
      new Set(exactHeads.map((head) => head.operationId)).size !==
      exactHeads.length
    ) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer workspace operations are duplicated.",
        409,
        "turn_state_transfer_conflict",
      );
    }
  } else if (entries.some((entry) => entry.entryKind === "thread")) {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer workspace registry is missing.",
      409,
      "turn_state_transfer_conflict",
    );
  }

  entries.sort((left, right) =>
    bytewiseCompare(transferEntryKey(left), transferEntryKey(right)),
  );
  if (entries.length > MAX_TRANSFER_ENTRIES) {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer source exceeds its bounded manifest.",
      409,
      "turn_state_transfer_too_large",
    );
  }
  const unsigned: Omit<TurnStateTransferManifest, "fingerprint"> = {
    schemaVersion: TURN_STATE_SCHEMA_VERSION,
    transferOperationId: identity.transferOperationId,
    sourceOwnerHash: hashes.sourceOwnerHash,
    sourceOwnerGeneration: identity.fromOwnerGeneration,
    sourceWorkspaceHash: hashes.sourceWorkspaceHash,
    destinationOwnerHash: hashes.destinationOwnerHash,
    destinationOwnerGeneration: identity.toOwnerGeneration,
    destinationWorkspaceHash: hashes.destinationWorkspaceHash,
    count: entries.length,
  };
  return {
    manifest: {
      ...unsigned,
      fingerprint: await transferManifestFingerprint(
        unsigned,
        entries.map((entry) => [
          transferEntryKey(entry),
          entry.entryFingerprint,
        ]),
      ),
    },
    entries,
  };
};
const parseTransferEntry = async (
  value: unknown,
  manifest: TurnStateTransferManifest,
): Promise<TurnStateTransferEntry> => {
  if (!plainObject(value)) {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer entry is invalid.",
      400,
      "invalid_request",
    );
  }
  let unsignedEntry: UnsignedTurnStateTransferEntry;
  if (value.entryKind === "workspace") {
    const row = exactObject(value, [
      "schemaVersion",
      "entryKind",
      "disposition",
      "originThreadId",
      "entryFingerprint",
      "head",
    ]);
    if (
      row.schemaVersion !== TURN_STATE_SCHEMA_VERSION ||
      row.entryKind !== "workspace" ||
      (row.disposition !== "committed" &&
        row.disposition !== "published" &&
        row.disposition !== "candidate")
    ) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer workspace entry is invalid.",
        400,
        "invalid_request",
      );
    }
    const head = parseTransferWorkspaceHead(row.head);
    const originThreadId = requiredText(row, "originThreadId");
    if (
      (await sha256Hex(originThreadId)) !== head.originThreadHash ||
      !head.archive.key.startsWith(
        `${TURN_STATE_OBJECT_PREFIX}/${manifest.sourceOwnerHash}/${manifest.sourceWorkspaceHash}/${head.originThreadHash}/`,
      )
    ) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer workspace origin is invalid.",
        409,
        "turn_state_transfer_conflict",
      );
    }
    await assertWorkspaceHeadReceipt(
      head,
      manifest.sourceOwnerHash,
      manifest.sourceOwnerGeneration,
      manifest.sourceWorkspaceHash,
    );
    unsignedEntry = {
      entryKind: "workspace",
      disposition: row.disposition,
      originThreadId,
      head,
    };
  } else {
    const row = exactObject(
      value,
      [
        "schemaVersion",
        "entryKind",
        "threadId",
        "threadHash",
        "disposition",
        "entryFingerprint",
        "candidate",
      ],
      ["candidateOrdinal"],
    );
    if (
      row.schemaVersion !== TURN_STATE_SCHEMA_VERSION ||
      row.entryKind !== "thread" ||
      (row.disposition !== "committed" && row.disposition !== "candidate")
    ) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer thread entry is invalid.",
        400,
        "invalid_request",
      );
    }
    const threadId = requiredText(row, "threadId");
    const threadHash = requiredHex(row, "threadHash");
    if ((await sha256Hex(threadId)) !== threadHash) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer thread identity is invalid.",
        409,
        "turn_state_transfer_conflict",
      );
    }
    const candidateOrdinal = Object.hasOwn(row, "candidateOrdinal")
      ? requiredSafeInteger(row, "candidateOrdinal", 0, 7)
      : undefined;
    if (
      (row.disposition === "candidate") !==
      (candidateOrdinal !== undefined)
    ) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer candidate ordinal is invalid.",
        400,
        "invalid_request",
      );
    }
    const candidate = parseTransferThreadCandidate(row.candidate);
    if (
      candidate.native &&
      !candidate.native.key.startsWith(
        `${TURN_STATE_OBJECT_PREFIX}/${manifest.sourceOwnerHash}/${manifest.sourceWorkspaceHash}/${threadHash}/`,
      )
    ) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer native archive escaped its source scope.",
        409,
        "turn_state_transfer_conflict",
      );
    }
    unsignedEntry = {
      entryKind: "thread",
      threadId,
      threadHash,
      disposition: row.disposition,
      ...(candidateOrdinal !== undefined ? { candidateOrdinal } : {}),
      candidate,
    };
  }
  const entryFingerprint = requiredHex(
    value as Record<string, unknown>,
    "entryFingerprint",
  );
  if (entryFingerprint !== (await transferEntryFingerprint(unsignedEntry))) {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer entry fingerprint is invalid.",
      409,
      "turn_state_transfer_conflict",
    );
  }
  return {
    schemaVersion: TURN_STATE_SCHEMA_VERSION,
    ...unsignedEntry,
    entryFingerprint,
  } as TurnStateTransferEntry;
};

const transferStagePrefix = (
  transferOperationId: string,
  workspaceHash: string,
): string => `${TRANSFER_STAGE_PREFIX}${transferOperationId}:${workspaceHash}:`;
const transferStageKey = (
  transferOperationId: string,
  workspaceHash: string,
  entryFingerprint: string,
): string =>
  `${transferStagePrefix(transferOperationId, workspaceHash)}${entryFingerprint}`;
const transferActivationKey = (
  transferOperationId: string,
  workspaceHash: string,
): string =>
  `${TRANSFER_ACTIVATION_PREFIX}${transferOperationId}:${workspaceHash}`;
const registryThreadKey = (workspaceHash: string, threadHash: string): string =>
  `turn-state:v1:thread:${workspaceHash}:${threadHash}`;
const registryWorkspaceKey = (workspaceHash: string): string =>
  `turn-state:v1:workspace:${workspaceHash}`;
const registryObjectKey = (key: string): string =>
  `turn-state:v1:object:${key}`;
const destinationHasThreadState = async (
  storage: StrongTurnStateStorage,
  workspaceHash: string,
): Promise<boolean> =>
  (
    await storage.list({
      prefix: `turn-state:v1:thread:${workspaceHash}:`,
      limit: 1,
    })
  ).size > 0;

const destinationTransferEntryPlan = async (
  identity: TransferRouteIdentity,
  manifest: TurnStateTransferManifest,
  entry: TurnStateTransferEntry,
): Promise<{
  operationId: string;
  requestFingerprint: string;
  turnHash: string;
  threadHash: string;
  objectKey?: string;
}> => {
  const threadHash =
    entry.entryKind === "workspace"
      ? entry.head.originThreadHash
      : entry.threadHash;
  const sourceRequestFingerprint =
    entry.entryKind === "workspace"
      ? entry.head.requestFingerprint
      : entry.candidate.requestFingerprint;
  const sourceOperationId =
    entry.entryKind === "workspace"
      ? entry.head.operationId
      : entry.candidate.sourceOperationId;
  const operationId = await canonicalDigest([
    "stella-turn-state-transfer-operation-v2",
    identity.transferOperationId,
    manifest.fingerprint,
    manifest.destinationOwnerHash,
    manifest.destinationOwnerGeneration,
    manifest.destinationWorkspaceHash,
    sourceOperationId,
  ]);
  const requestFingerprint = await canonicalDigest([
    "stella-turn-state-transfer-request-v2",
    operationId,
    sourceRequestFingerprint,
  ]);
  const turnHash = await canonicalDigest([
    "stella-turn-state-transfer-turn-v2",
    identity.transferOperationId,
    sourceOperationId,
  ]);
  const base = `${TURN_STATE_OBJECT_PREFIX}/${manifest.destinationOwnerHash}/${manifest.destinationWorkspaceHash}/${threadHash}/${turnHash}/1-${operationId}`;
  const objectKind =
    entry.entryKind === "workspace"
      ? "workspace"
      : entry.candidate.native
        ? "native"
        : undefined;
  return {
    operationId,
    requestFingerprint,
    turnHash,
    threadHash,
    ...(objectKind ? { objectKey: `${base}/${objectKind}.sqsh` } : {}),
  };
};

const archiveTarget = (
  kind: TurnStateArchive["kind"],
): TurnStateArchiveTarget =>
  kind === "native" ? { kind: "native" } : { kind: "workspace" };

const sha256ArrayBufferHex = (
  value: ArrayBuffer | undefined,
): string | null => {
  if (!value || value.byteLength !== 32) return null;
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const assertDurableArchiveObject = async (
  bucket: R2Bucket,
  archive: TurnStateArchive,
  target: TurnStateArchiveTarget,
): Promise<void> => {
  const stored = await bucket.head(archive.key);
  if (
    !stored ||
    stored.key !== archive.key ||
    stored.size !== archive.sizeBytes ||
    stored.etag !== archive.etag ||
    stored.httpMetadata?.contentType !== TURN_STATE_ARCHIVE_CONTENT_TYPE ||
    !turnStateArchiveMetadataMatches(stored.customMetadata, archive, target) ||
    sha256ArrayBufferHex(stored.checksums.sha256) !== archive.sha256
  ) {
    throw new TurnStateOwnerRouteError(
      "Turn state archive bytes do not match their R2 descriptor.",
      409,
      "archive_not_durable",
    );
  }
};

const abortUnpublishedTurnState = async (
  storage: StrongTurnStateStorage,
  args: {
    ownerId: string;
    ownerGeneration: string;
    threadId: string;
    operationId: string;
    baseWorkspaceRevision: number;
    candidateHistoryCursor: string;
    canonicalHistoryCursor: string;
  },
): Promise<{
  operationId: string;
  abortReceipt: string;
  replayed: boolean;
}> => {
  const [ownerHash, workspaceHash, threadHash] = await Promise.all([
    sha256Hex(args.ownerId),
    sha256Hex(WORLD_REGISTRY_SEGMENT),
    sha256Hex(args.threadId),
  ]);
  const abortKey = `${ABORT_UNPUBLISHED_PREFIX}${args.operationId}`;
  const existing = await storage.get<AbortUnpublishedRecord>(abortKey);
  if (existing) {
    if (
      existing.schemaVersion !== TURN_STATE_SCHEMA_VERSION ||
      existing.ownerHash !== ownerHash ||
      existing.ownerGeneration !== args.ownerGeneration ||
      existing.workspaceHash !== workspaceHash ||
      existing.threadHash !== threadHash ||
      existing.threadId !== args.threadId ||
      existing.operationId !== args.operationId ||
      existing.baseWorkspaceRevision !== args.baseWorkspaceRevision ||
      existing.candidateHistoryCursor !== args.candidateHistoryCursor ||
      existing.canonicalHistoryCursor !== args.canonicalHistoryCursor
    ) {
      throw new TurnStateOwnerRouteError(
        "Turn state unpublished abort conflicts with its durable replay.",
        409,
        "turn_state_abort_conflict",
      );
    }
    return {
      operationId: args.operationId,
      abortReceipt: existing.abortReceipt,
      replayed: true,
    };
  }

  const workspaceKey = registryWorkspaceKey(workspaceHash);
  const threadKey = registryThreadKey(workspaceHash, threadHash);
  const operationKey = `turn-state:v1:operation:${args.operationId}`;
  const [workspaceState, thread, operation] = await Promise.all([
    storage.get<RegistryWorkspaceRecord>(workspaceKey),
    storage.get<RegistryThreadRecord>(threadKey),
    storage.get<RegistryOperationRecord>(operationKey),
  ]);
  const candidate = workspaceState?.candidate;
  const threadMatches = thread?.candidates.filter(
    (value) => value.operationId === args.operationId,
  );
  const threadCandidate = threadMatches?.[0];
  const visibleRevision =
    workspaceState?.published?.revision ??
    workspaceState?.committed?.revision ??
    0;
  if (
    !workspaceState ||
    workspaceState.schemaVersion !== TURN_STATE_SCHEMA_VERSION ||
    workspaceState.ownerHash !== ownerHash ||
    workspaceState.ownerGeneration !== args.ownerGeneration ||
    workspaceState.workspaceHash !== workspaceHash ||
    !candidate ||
    candidate.operationId !== args.operationId ||
    candidate.originThreadHash !== threadHash ||
    candidate.originHistoryCursor !== args.candidateHistoryCursor ||
    candidate.revision !== args.baseWorkspaceRevision + 1 ||
    visibleRevision !== args.baseWorkspaceRevision ||
    workspaceState.published?.operationId === args.operationId ||
    workspaceState.committed?.operationId === args.operationId ||
    !thread ||
    thread.schemaVersion !== TURN_STATE_SCHEMA_VERSION ||
    thread.ownerHash !== ownerHash ||
    thread.ownerGeneration !== args.ownerGeneration ||
    thread.workspaceHash !== workspaceHash ||
    thread.threadHash !== threadHash ||
    thread.threadId !== args.threadId ||
    thread.committed?.operationId === args.operationId ||
    threadMatches?.length !== 1 ||
    !threadCandidate ||
    threadCandidate.historyCursor !== args.candidateHistoryCursor ||
    !operation ||
    operation.schemaVersion !== TURN_STATE_SCHEMA_VERSION ||
    operation.identity.ownerId !== args.ownerId ||
    operation.identity.ownerGeneration !== args.ownerGeneration ||
    operation.identity.threadId !== args.threadId ||
    operation.ownerHash !== ownerHash ||
    operation.workspaceHash !== workspaceHash ||
    operation.threadHash !== threadHash ||
    operation.operationId !== args.operationId ||
    operation.historyCursor !== args.candidateHistoryCursor ||
    operation.baseWorkspaceRevision !== args.baseWorkspaceRevision ||
    operation.state !== "committed" ||
    candidate.requestFingerprint !== operation.requestFingerprint ||
    threadCandidate.requestFingerprint !== operation.requestFingerprint ||
    candidate.createdAt !== operation.createdAt ||
    threadCandidate.createdAt !== operation.createdAt ||
    !sameJson(operation.nativeCheckpoint, threadCandidate.nativeCheckpoint) ||
    operation.receipt !== threadCandidate.receipt ||
    !sameJson(operation.objectKeys, {
      workspace: candidate.archive.key,
      ...(threadCandidate.native ? { native: threadCandidate.native.key } : {}),
    }) ||
    !sameJson(candidate.archive, threadCandidate.workspace)
  ) {
    throw new TurnStateOwnerRouteError(
      "Turn state unpublished candidate is no longer abortable.",
      409,
      "turn_state_abort_conflict",
    );
  }
  await assertCandidateReceipt(threadCandidate);
  await assertWorkspaceHeadReceipt(
    candidate,
    ownerHash,
    args.ownerGeneration,
    workspaceHash,
  );

  const descriptors = [candidate.archive, threadCandidate.native].filter(
    (value): value is TurnStateArchive => Boolean(value),
  );
  const objectKeys = descriptors.map((descriptor) => descriptor.key);
  const retirementKey = `turn-state:v1:retirement:${args.operationId}`;
  if (await storage.get(retirementKey)) {
    throw new TurnStateOwnerRouteError(
      "Turn state unpublished retirement already conflicts.",
      409,
      "turn_state_abort_conflict",
    );
  }
  for (const descriptor of descriptors) {
    const key = registryObjectKey(descriptor.key);
    const object = await storage.get<RegistryObjectRecord>(key);
    const expected = {
      schemaVersion: TURN_STATE_SCHEMA_VERSION,
      ownerHash,
      ownerGeneration: args.ownerGeneration,
      workspaceHash,
      threadHash,
      operationId: args.operationId,
      kind: descriptor.kind,
      key: descriptor.key,
    } satisfies Omit<RegistryObjectRecord, "state" | "descriptor">;
    if (
      !exactRegistryObjectIdentity(object, expected) ||
      object?.state !== "referenced" ||
      !sameJson(object.descriptor, descriptor)
    ) {
      throw new TurnStateOwnerRouteError(
        "Turn state unpublished archive is no longer abortable.",
        409,
        "turn_state_abort_conflict",
      );
    }
  }

  const abortReceipt = await canonicalDigest([
    "stella-turn-state-abort-unpublished-v1",
    ownerHash,
    args.ownerGeneration,
    workspaceHash,
    threadHash,
    args.operationId,
    args.baseWorkspaceRevision,
    args.candidateHistoryCursor,
    args.canonicalHistoryCursor,
    objectKeys,
  ]);
  await storage.put(workspaceKey, {
    ...workspaceState,
    candidate: undefined,
  } satisfies RegistryWorkspaceRecord);
  await storage.put(threadKey, {
    ...thread,
    candidates: thread.candidates.filter(
      (value) => value.operationId !== args.operationId,
    ),
  } satisfies RegistryThreadRecord);
  await storage.put(retirementKey, {
    schemaVersion: TURN_STATE_SCHEMA_VERSION,
    ownerHash,
    ownerGeneration: args.ownerGeneration,
    workspaceHash,
    threadHash,
    operationId: args.operationId,
    objectKeys,
    createdAt: operation.createdAt,
  } satisfies RegistryRetirementRecord);
  for (const descriptor of descriptors) {
    const key = registryObjectKey(descriptor.key);
    const object = (await storage.get<RegistryObjectRecord>(key))!;
    await storage.put(key, {
      ...object,
      state: "retiring",
    } satisfies RegistryObjectRecord);
  }
  await storage.put(abortKey, {
    schemaVersion: TURN_STATE_SCHEMA_VERSION,
    ownerHash,
    ownerGeneration: args.ownerGeneration,
    workspaceHash,
    threadHash,
    threadId: args.threadId,
    operationId: args.operationId,
    baseWorkspaceRevision: args.baseWorkspaceRevision,
    candidateHistoryCursor: args.candidateHistoryCursor,
    canonicalHistoryCursor: args.canonicalHistoryCursor,
    objectKeys,
    abortReceipt,
  } satisfies AbortUnpublishedRecord);
  return { operationId: args.operationId, abortReceipt, replayed: false };
};

const routeAuthorizationKey = (operationId: string): string =>
  `${ROUTE_OPERATION_PREFIX}${operationId}`;

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const sameLegacySeedAuthorization = (
  left: RouteOperationAuthorization,
  right: RouteOperationAuthorization,
): boolean =>
  left.schemaVersion === TURN_STATE_SCHEMA_VERSION &&
  left.scope === "legacy-seed" &&
  right.scope === "legacy-seed" &&
  left.ownerHash === right.ownerHash &&
  left.workspaceHash === right.workspaceHash &&
  left.threadHash === right.threadHash &&
  left.operationId === right.operationId &&
  left.ownerId === right.ownerId &&
  left.ownerGeneration === right.ownerGeneration &&
  left.threadId === LEGACY_SEED_THREAD_ID &&
  right.threadId === LEGACY_SEED_THREAD_ID &&
  left.attemptGeneration === 1 &&
  right.attemptGeneration === 1 &&
  left.baseWorkspaceRevision === 0 &&
  right.baseWorkspaceRevision === 0 &&
  left.requestFingerprint === right.requestFingerprint &&
  left.createdAt === right.createdAt &&
  sameJson(left.objectKeys, right.objectKeys);

const authorizePreparedOperation = async (
  storage: StrongTurnStateStorage,
  authorization: RouteOperationAuthorization,
  options: { allowLegacySeedAdoption?: boolean } = {},
): Promise<void> => {
  await storage.transaction(async (transaction) => {
    if (
      await transaction.get<AbortUnpublishedRecord>(
        `${ABORT_UNPUBLISHED_PREFIX}${authorization.operationId}`,
      )
    ) {
      throw new TurnStateOwnerRouteError(
        "Turn state operation was durably aborted.",
        409,
        "turn_state_abort_conflict",
      );
    }
    const key = routeAuthorizationKey(authorization.operationId);
    const existing = await transaction.get<RouteOperationAuthorization>(key);
    if (
      existing &&
      !sameJson(existing, authorization) &&
      !(
        options.allowLegacySeedAdoption &&
        sameLegacySeedAuthorization(existing, authorization)
      )
    ) {
      throw new TurnStateOwnerRouteError(
        "Turn state operation belongs to another exact lease.",
        409,
        "operation_scope_mismatch",
      );
    }
    if (!existing || !sameJson(existing, authorization)) {
      await transaction.put(key, authorization);
    }
  });
};

const clearRetiredRouteAuthorizations = async (
  storage: StrongTurnStateStorage,
  scope: { ownerId: string; ownerGeneration: string },
): Promise<void> => {
  const [ownerHash, workspaceHash] = await Promise.all([
    sha256Hex(scope.ownerId),
    sha256Hex(WORLD_REGISTRY_SEGMENT),
  ]);
  let startAfter: string | undefined;
  for (;;) {
    const page = await storage.list<RouteOperationAuthorization>({
      prefix: ROUTE_OPERATION_PREFIX,
      ...(startAfter ? { startAfter } : {}),
      limit: 128,
    });
    for (const [key, authorization] of page) {
      if (
        authorization.ownerHash !== ownerHash ||
        authorization.workspaceHash !== workspaceHash ||
        authorization.ownerGeneration !== scope.ownerGeneration
      ) {
        continue;
      }
      await storage.transaction(async (transaction) => {
        const current = await transaction.get<RouteOperationAuthorization>(key);
        if (!current || !sameJson(current, authorization)) return;
        const [operation, retirement] = await Promise.all([
          transaction.get(`turn-state:v1:operation:${current.operationId}`),
          transaction.get(`turn-state:v1:retirement:${current.operationId}`),
        ]);
        // A lost drain response may mean the registry already removed both
        // records in the previous attempt. The absence proof, rather than the
        // current drain result, is therefore the idempotent cleanup authority.
        if (operation === undefined && retirement === undefined) {
          await transaction.delete(key);
          // Abort receipts are compact tombstones, not operation authorization.
          // Keep them until the scoped owner/workspace purge so a response-loss
          // retry remains exact even after retirement has drained both archives.
        }
      });
    }
    if (page.size < 128) return;
    const next = [...page.keys()].at(-1);
    if (!next || next === startAfter) {
      throw new Error("Turn state authorization listing did not advance.");
    }
    startAfter = next;
  }
};

const requireOperationAuthorization = async (
  storage: StrongTurnStateStorage,
  operationId: string,
  lease: ReturnType<typeof parseCommonLease>,
): Promise<RouteOperationAuthorization> => {
  if (!/^[0-9a-f]{64}$/u.test(operationId)) {
    throw new TurnStateOwnerRouteError(
      "operationId is invalid.",
      400,
      "invalid_request",
    );
  }
  const authorization = await storage.get<RouteOperationAuthorization>(
    routeAuthorizationKey(operationId),
  );
  if (
    !authorization ||
    authorization.schemaVersion !== TURN_STATE_SCHEMA_VERSION ||
    authorization.operationId !== operationId ||
    authorization.ownerId !== lease.ownerId ||
    authorization.ownerGeneration !== lease.ownerGeneration ||
    authorization.fenceGeneration !== lease.generation ||
    authorization.leaseId !== lease.leaseId ||
    authorization.sessionId !== lease.sessionId ||
    authorization.turnId !== lease.turnId
  ) {
    throw new TurnStateOwnerRouteError(
      "Turn state operation belongs to another exact lease.",
      409,
      "operation_scope_mismatch",
    );
  }
  return authorization;
};

const listAllStrongRecords = async (
  storage: StrongTurnStateStorage,
): Promise<Map<string, Record<string, unknown>>> => {
  const output = new Map<string, Record<string, unknown>>();
  let startAfter: string | undefined;
  for (;;) {
    const page = await storage.list<Record<string, unknown>>({
      prefix: "turn-state:v1:",
      ...(startAfter ? { startAfter } : {}),
      limit: 128,
    });
    for (const [key, value] of page) output.set(key, value);
    if (page.size < 128) return output;
    const next = [...page.keys()].at(-1);
    if (!next || next === startAfter) {
      throw new Error("Turn state registry listing did not advance.");
    }
    startAfter = next;
  }
};

const assertFullWorldRegistryEmpty = async (
  storage: StrongTurnStateStorage,
  ownerId: string,
): Promise<void> => {
  const [ownerHash, workspaceHash] = await Promise.all([
    sha256Hex(ownerId),
    sha256Hex(WORLD_REGISTRY_SEGMENT),
  ]);
  const records = await listAllStrongRecords(storage);
  for (const [key, value] of records) {
    if (key === OWNER_MARKER_KEY) continue;
    if (!plainObject(value)) {
      throw new Error(
        "Turn state registry contains a malformed scoped record.",
      );
    }
    if (
      value.ownerHash === ownerHash &&
      value.workspaceHash === workspaceHash
    ) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer source registry is not empty.",
        409,
        "transfer_source_not_empty",
      );
    }
  }
};

const destinationTransferStatus = async (
  storage: StrongTurnStateStorage,
  identity: TransferRouteIdentity,
): Promise<TurnStateTransferDestinationStatus> => {
  const [ownerHash, workspaceHash] = await Promise.all([
    sha256Hex(identity.toOwnerId),
    sha256Hex(WORLD_REGISTRY_SEGMENT),
  ]);
  const activationKey = transferActivationKey(
    identity.transferOperationId,
    workspaceHash,
  );
  const activation = await storage.get<TransferActivationRecord>(activationKey);
  if (activation) {
    if (
      activation.schemaVersion !== TURN_STATE_SCHEMA_VERSION ||
      activation.ownerHash !== ownerHash ||
      activation.ownerGeneration !== identity.toOwnerGeneration ||
      activation.workspaceHash !== workspaceHash ||
      activation.transferOperationId !== identity.transferOperationId ||
      !/^[0-9a-f]{64}$/u.test(activation.activationReceipt)
    ) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer activation is invalid.",
        409,
        "turn_state_transfer_conflict",
      );
    }
    return {
      state: "activated",
      activationReceipt: activation.activationReceipt,
    };
  }

  const exactStagePrefix = transferStagePrefix(
    identity.transferOperationId,
    workspaceHash,
  );
  let exactStages = 0;
  const records = await listAllStrongRecords(storage);
  const allowed = new Set<string>();
  for (const [key, value] of records) {
    if (
      plainObject(value) &&
      key.startsWith(exactStagePrefix) &&
      value.transferOperationId === identity.transferOperationId &&
      value.ownerHash === ownerHash &&
      value.workspaceHash === workspaceHash &&
      value.ownerGeneration === identity.toOwnerGeneration
    ) {
      exactStages += 1;
      allowed.add(key);
      if (
        typeof value.destinationObjectKey === "string" &&
        value.destinationObjectKey.startsWith(`${TURN_STATE_OBJECT_PREFIX}/`)
      ) {
        allowed.add(registryObjectKey(value.destinationObjectKey));
      }
    }
  }
  for (const [key, value] of records) {
    if (key === OWNER_MARKER_KEY || !plainObject(value)) continue;
    if (
      value.ownerHash !== ownerHash ||
      value.workspaceHash !== workspaceHash
    ) {
      continue;
    }
    if (allowed.has(key)) continue;
    return { state: "occupied" };
  }
  return { state: exactStages > 0 ? "staging" : "empty" };
};

const listAllPrefix = async <T>(
  storage: StrongTurnStateStorage,
  prefix: string,
): Promise<Map<string, T>> => {
  const output = new Map<string, T>();
  let startAfter: string | undefined;
  for (;;) {
    const page = await storage.list<T>({
      prefix,
      ...(startAfter ? { startAfter } : {}),
      limit: 128,
    });
    for (const [key, value] of page) output.set(key, value);
    if (page.size < 128) return output;
    const next = [...page.keys()].at(-1);
    if (!next || next === startAfter) {
      throw new Error("Turn state transfer listing did not advance.");
    }
    startAfter = next;
  }
};

const sameTransferStageIdentity = (
  left: TransferStageRecord,
  right: TransferStageRecord,
): boolean =>
  left.schemaVersion === TURN_STATE_SCHEMA_VERSION &&
  left.ownerHash === right.ownerHash &&
  left.ownerGeneration === right.ownerGeneration &&
  left.workspaceHash === right.workspaceHash &&
  left.transferOperationId === right.transferOperationId &&
  left.manifestFingerprint === right.manifestFingerprint &&
  left.entryFingerprint === right.entryFingerprint &&
  left.sourceOwnerHash === right.sourceOwnerHash &&
  left.sourceOwnerGeneration === right.sourceOwnerGeneration &&
  left.sourceWorkspaceHash === right.sourceWorkspaceHash &&
  left.destinationOperationId === right.destinationOperationId &&
  left.destinationRequestFingerprint === right.destinationRequestFingerprint &&
  left.destinationTurnHash === right.destinationTurnHash &&
  left.destinationObjectKey === right.destinationObjectKey &&
  sameJson(left.entry, right.entry);

const exactRegistryObjectIdentity = (
  value: RegistryObjectRecord | undefined,
  expected: Omit<RegistryObjectRecord, "state" | "descriptor">,
): boolean =>
  Boolean(
    value &&
      value.schemaVersion === expected.schemaVersion &&
      value.ownerHash === expected.ownerHash &&
      value.ownerGeneration === expected.ownerGeneration &&
      value.workspaceHash === expected.workspaceHash &&
      value.threadHash === expected.threadHash &&
      value.operationId === expected.operationId &&
      value.kind === expected.kind &&
      value.key === expected.key,
  );

const stageObjectKind = (
  entry: TurnStateTransferEntry,
): TurnStateArchive["kind"] | undefined =>
  entry.entryKind === "workspace"
    ? "workspace"
    : entry.candidate.native
      ? "native"
      : undefined;

const assertDestinationTransferScope = async (
  storage: StrongTurnStateStorage,
  identity: TransferRouteIdentity,
  manifest: TurnStateTransferManifest,
  options: {
    objectState: "staged" | "activated";
    activatedRecords?: Map<string, unknown>;
  },
): Promise<void> => {
  const conflict = (): never => {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer destination contains unrelated scoped state.",
      409,
      "turn_state_transfer_destination_conflict",
    );
  };
  const allowed = new Map(options.activatedRecords ?? []);
  const stageRows = await listAllPrefix<TransferStageRecord>(
    storage,
    transferStagePrefix(
      identity.transferOperationId,
      manifest.destinationWorkspaceHash,
    ),
  );
  if (
    stageRows.size > manifest.count ||
    stageRows.size > MAX_TRANSFER_ENTRIES
  ) {
    conflict();
  }
  for (const [key, stage] of stageRows) {
    if (
      stage.schemaVersion !== TURN_STATE_SCHEMA_VERSION ||
      stage.ownerHash !== manifest.destinationOwnerHash ||
      stage.ownerGeneration !== identity.toOwnerGeneration ||
      stage.workspaceHash !== manifest.destinationWorkspaceHash ||
      stage.transferOperationId !== identity.transferOperationId ||
      stage.manifestFingerprint !== manifest.fingerprint ||
      stage.sourceOwnerHash !== manifest.sourceOwnerHash ||
      stage.sourceOwnerGeneration !== identity.fromOwnerGeneration ||
      stage.sourceWorkspaceHash !== manifest.sourceWorkspaceHash ||
      key !==
        transferStageKey(
          identity.transferOperationId,
          manifest.destinationWorkspaceHash,
          stage.entryFingerprint,
        ) ||
      (stage.state !== "reserved" && stage.state !== "copied")
    ) {
      conflict();
    }
    const parsedEntry = await parseTransferEntry(stage.entry, manifest);
    const plan = await destinationTransferEntryPlan(
      identity,
      manifest,
      parsedEntry,
    );
    if (
      !sameJson(parsedEntry, stage.entry) ||
      stage.entryFingerprint !== parsedEntry.entryFingerprint ||
      stage.destinationOperationId !== plan.operationId ||
      stage.destinationRequestFingerprint !== plan.requestFingerprint ||
      stage.destinationTurnHash !== plan.turnHash ||
      stage.destinationObjectKey !== plan.objectKey
    ) {
      conflict();
    }
    const expectedKind = stageObjectKind(parsedEntry);
    if (stage.state === "reserved") {
      if (stage.archive || stage.nativeCheckpoint) conflict();
    } else {
      if (
        Boolean(stage.archive) !== Boolean(plan.objectKey) ||
        stage.archive?.key !== plan.objectKey ||
        stage.archive?.kind !== expectedKind ||
        (stage.archive &&
          !sameJson(parseArchive(stage.archive), stage.archive)) ||
        (parsedEntry.entryKind === "workspace" && stage.nativeCheckpoint) ||
        (parsedEntry.entryKind === "thread" &&
          Boolean(stage.nativeCheckpoint) !==
            Boolean(parsedEntry.candidate.nativeCheckpoint)) ||
        (stage.nativeCheckpoint &&
          !sameJson(
            parseNativeCheckpoint(
              stage.nativeCheckpoint,
              parsedEntry.entryKind === "thread"
                ? parsedEntry.candidate.historyCursor
                : "",
            ),
            stage.nativeCheckpoint,
          ))
      ) {
        conflict();
      }
    }
    allowed.set(key, stage);
    if (!plan.objectKey || !expectedKind) continue;
    const objectKey = registryObjectKey(plan.objectKey);
    const object = await storage.get<RegistryObjectRecord>(objectKey);
    const expected = {
      schemaVersion: TURN_STATE_SCHEMA_VERSION,
      ownerHash: manifest.destinationOwnerHash,
      ownerGeneration: identity.toOwnerGeneration,
      workspaceHash: manifest.destinationWorkspaceHash,
      threadHash: plan.threadHash,
      operationId: plan.operationId,
      kind: expectedKind,
      key: plan.objectKey,
    } satisfies Omit<RegistryObjectRecord, "state" | "descriptor">;
    const expectedState =
      stage.state === "reserved"
        ? "reserved"
        : options.objectState === "activated"
          ? "referenced"
          : "uploaded";
    if (
      !exactRegistryObjectIdentity(object, expected) ||
      object?.state !== expectedState ||
      (stage.state === "reserved"
        ? object.descriptor !== undefined
        : !sameJson(object.descriptor, stage.archive))
    ) {
      conflict();
    }
    allowed.set(objectKey, object);
  }

  for (const [key, value] of await listAllPrefix<Record<string, unknown>>(
    storage,
    "turn-state:v1:",
  )) {
    if (
      !plainObject(value) ||
      value.ownerHash !== manifest.destinationOwnerHash ||
      value.workspaceHash !== manifest.destinationWorkspaceHash
    ) {
      continue;
    }
    const expected = allowed.get(key);
    if (expected === undefined || !sameJson(value, expected)) conflict();
  }
};

const reserveTransferStage = async (
  args: {
    storage: DurableObjectStorage;
    scopedOwnerId: string;
    now?: () => number;
  },
  identity: TransferRouteIdentity,
  manifest: TurnStateTransferManifest,
  entry: TurnStateTransferEntry,
  plan: Awaited<ReturnType<typeof destinationTransferEntryPlan>>,
): Promise<TransferStageRecord> =>
  await withCurrentTransferLeaseTransaction(args, identity, async (storage) => {
    const key = transferStageKey(
      identity.transferOperationId,
      manifest.destinationWorkspaceHash,
      entry.entryFingerprint,
    );
    const reservation: TransferStageRecord = {
      schemaVersion: TURN_STATE_SCHEMA_VERSION,
      ownerHash: manifest.destinationOwnerHash,
      ownerGeneration: identity.toOwnerGeneration,
      workspaceHash: manifest.destinationWorkspaceHash,
      transferOperationId: identity.transferOperationId,
      manifestFingerprint: manifest.fingerprint,
      entryFingerprint: entry.entryFingerprint,
      sourceOwnerHash: manifest.sourceOwnerHash,
      sourceOwnerGeneration: identity.fromOwnerGeneration,
      sourceWorkspaceHash: manifest.sourceWorkspaceHash,
      entry,
      destinationOperationId: plan.operationId,
      destinationRequestFingerprint: plan.requestFingerprint,
      destinationTurnHash: plan.turnHash,
      ...(plan.objectKey ? { destinationObjectKey: plan.objectKey } : {}),
      state: "reserved",
    };
    await assertDestinationTransferScope(storage, identity, manifest, {
      objectState: "staged",
    });
    const existing = await storage.get<TransferStageRecord>(key);
    if (existing) {
      if (
        !sameTransferStageIdentity(existing, reservation) ||
        (existing.state !== "reserved" && existing.state !== "copied") ||
        (existing.state === "copied" &&
          Boolean(existing.archive) !== Boolean(plan.objectKey))
      ) {
        throw new TurnStateOwnerRouteError(
          "Turn state transfer stage conflicts with its durable replay.",
          409,
          "turn_state_transfer_conflict",
        );
      }
      return existing;
    }
    if (
      await storage.get<TransferActivationRecord>(
        transferActivationKey(
          identity.transferOperationId,
          manifest.destinationWorkspaceHash,
        ),
      )
    ) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer activation is already sealed.",
        409,
        "turn_state_transfer_conflict",
      );
    }
    if (
      await storage.get(registryWorkspaceKey(manifest.destinationWorkspaceHash))
    ) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer destination workspace already exists.",
        409,
        "turn_state_transfer_destination_conflict",
      );
    }
    if (
      await destinationHasThreadState(
        storage,
        manifest.destinationWorkspaceHash,
      )
    ) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer destination workspace has thread state.",
        409,
        "turn_state_transfer_destination_conflict",
      );
    }
    const marker = await storage.get<{ ownerHash?: string }>(OWNER_MARKER_KEY);
    if (marker && marker.ownerHash !== manifest.destinationOwnerHash) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer destination owner registry conflicts.",
        409,
        "turn_state_transfer_destination_conflict",
      );
    }
    const kind = stageObjectKind(entry);
    if (plan.objectKey && kind) {
      const objectKey = registryObjectKey(plan.objectKey);
      if (await storage.get(objectKey)) {
        throw new TurnStateOwnerRouteError(
          "Turn state transfer destination object already exists.",
          409,
          "turn_state_transfer_destination_conflict",
        );
      }
      await storage.put(objectKey, {
        schemaVersion: TURN_STATE_SCHEMA_VERSION,
        ownerHash: manifest.destinationOwnerHash,
        ownerGeneration: identity.toOwnerGeneration,
        workspaceHash: manifest.destinationWorkspaceHash,
        threadHash: plan.threadHash,
        operationId: plan.operationId,
        kind,
        key: plan.objectKey,
        state: "reserved",
      } satisfies RegistryObjectRecord);
    } else if (plan.objectKey || kind) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer object plan is inconsistent.",
        409,
        "turn_state_transfer_conflict",
      );
    }
    await storage.put(key, reservation);
    return reservation;
  });

const completeTransferStage = async (
  args: {
    storage: DurableObjectStorage;
    scopedOwnerId: string;
    now?: () => number;
  },
  identity: TransferRouteIdentity,
  manifest: TurnStateTransferManifest,
  reservation: TransferStageRecord,
  archive: TurnStateArchive | undefined,
  nativeCheckpoint: TurnStateNativeCheckpoint | undefined,
): Promise<{ replayed: boolean }> =>
  await withCurrentTransferLeaseTransaction(args, identity, async (storage) => {
    const key = transferStageKey(
      identity.transferOperationId,
      manifest.destinationWorkspaceHash,
      reservation.entryFingerprint,
    );
    const current = await storage.get<TransferStageRecord>(key);
    if (!current || !sameTransferStageIdentity(current, reservation)) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer stage authority changed during copy.",
        409,
        "turn_state_transfer_conflict",
      );
    }
    const expectedKind = stageObjectKind(current.entry);
    if (
      Boolean(archive) !== Boolean(current.destinationObjectKey) ||
      archive?.key !== current.destinationObjectKey ||
      archive?.kind !== expectedKind ||
      (current.entry.entryKind === "workspace" && nativeCheckpoint) ||
      (current.entry.entryKind === "thread" &&
        Boolean(nativeCheckpoint) !==
          Boolean(current.entry.candidate.nativeCheckpoint))
    ) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer copied state is inconsistent.",
        409,
        "turn_state_transfer_conflict",
      );
    }
    if (current.state === "copied") {
      if (
        !sameJson(current.archive, archive) ||
        !sameJson(current.nativeCheckpoint, nativeCheckpoint)
      ) {
        throw new TurnStateOwnerRouteError(
          "Turn state transfer copied bytes conflict with durable state.",
          409,
          "turn_state_transfer_conflict",
        );
      }
      return { replayed: true };
    }
    if (archive) {
      const objectKey = registryObjectKey(archive.key);
      const object = await storage.get<RegistryObjectRecord>(objectKey);
      const plan = await destinationTransferEntryPlan(
        identity,
        manifest,
        current.entry,
      );
      const expected = {
        schemaVersion: TURN_STATE_SCHEMA_VERSION,
        ownerHash: manifest.destinationOwnerHash,
        ownerGeneration: identity.toOwnerGeneration,
        workspaceHash: manifest.destinationWorkspaceHash,
        threadHash: plan.threadHash,
        operationId: plan.operationId,
        kind: archive.kind,
        key: archive.key,
      } satisfies Omit<RegistryObjectRecord, "state" | "descriptor">;
      if (
        !exactRegistryObjectIdentity(object, expected) ||
        object?.state !== "reserved" ||
        object.descriptor !== undefined
      ) {
        throw new TurnStateOwnerRouteError(
          "Turn state transfer object reservation changed during copy.",
          409,
          "turn_state_transfer_conflict",
        );
      }
      await storage.put(objectKey, {
        ...object,
        state: "uploaded",
        descriptor: archive,
      } satisfies RegistryObjectRecord);
    }
    await storage.put(key, {
      ...current,
      state: "copied",
      ...(archive ? { archive } : {}),
      ...(nativeCheckpoint ? { nativeCheckpoint } : {}),
    } satisfies TransferStageRecord);
    return { replayed: false };
  });

const destinationWorkspaceHead = async (
  stage: TransferStageRecord,
  manifest: TurnStateTransferManifest,
  identity: TransferRouteIdentity,
): Promise<TurnStateWorkspaceHead> => {
  if (
    stage.entry.entryKind !== "workspace" ||
    !stage.archive ||
    stage.archive.kind !== "workspace"
  ) {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer workspace stage is incomplete.",
      409,
      "turn_state_transfer_incomplete",
    );
  }
  const unsigned: Omit<TurnStateWorkspaceHead, "receipt"> = {
    schemaVersion: TURN_STATE_SCHEMA_VERSION,
    operationId: stage.destinationOperationId,
    requestFingerprint: stage.destinationRequestFingerprint,
    revision: stage.entry.head.revision,
    originThreadHash: stage.entry.head.originThreadHash,
    originHistoryCursor: stage.entry.head.originHistoryCursor,
    archive: stage.archive,
    createdAt: stage.entry.head.createdAt,
  };
  return {
    ...unsigned,
    receipt: await workspaceHeadReceipt(
      unsigned,
      manifest.destinationOwnerHash,
      identity.toOwnerGeneration,
      manifest.destinationWorkspaceHash,
    ),
  };
};

const destinationThreadCandidate = async (
  stage: TransferStageRecord,
  workspaceArchive: TurnStateArchive,
): Promise<TurnStateCandidate> => {
  if (stage.entry.entryKind !== "thread") {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer thread stage is invalid.",
      409,
      "turn_state_transfer_conflict",
    );
  }
  const source = stage.entry.candidate;
  if (
    Boolean(source.native) !== Boolean(stage.archive) ||
    (stage.archive && stage.archive.kind !== "native") ||
    Boolean(source.nativeCheckpoint) !== Boolean(stage.nativeCheckpoint)
  ) {
    throw new TurnStateOwnerRouteError(
      "Turn state transfer thread native state is incomplete.",
      409,
      "turn_state_transfer_incomplete",
    );
  }
  const unsigned: Omit<TurnStateCandidate, "receipt"> = {
    schemaVersion: TURN_STATE_SCHEMA_VERSION,
    operationId: stage.destinationOperationId,
    requestFingerprint: stage.destinationRequestFingerprint,
    historyCursor: source.historyCursor,
    workspace: workspaceArchive,
    ...(stage.archive ? { native: stage.archive } : {}),
    ...(stage.nativeCheckpoint
      ? { nativeCheckpoint: stage.nativeCheckpoint }
      : {}),
    createdAt: source.createdAt,
  };
  return {
    ...unsigned,
    receipt: await candidateReceipt(unsigned),
  };
};

const activateTransfer = async (
  args: {
    storage: DurableObjectStorage;
    scopedOwnerId: string;
    nativeIntegritySecret?: string;
    now?: () => number;
  },
  identity: TransferRouteIdentity,
  manifest: TurnStateTransferManifest,
): Promise<TurnStateTransferActivationResponse> =>
  await withCurrentTransferLeaseTransaction(args, identity, async (storage) => {
    const stages = [
      ...(
        await listAllPrefix<TransferStageRecord>(
          storage,
          transferStagePrefix(
            identity.transferOperationId,
            manifest.destinationWorkspaceHash,
          ),
        )
      ).values(),
    ].sort((left, right) =>
      bytewiseCompare(
        transferEntryKey(left.entry),
        transferEntryKey(right.entry),
      ),
    );
    if (stages.length !== manifest.count) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer manifest is not fully staged.",
        409,
        "turn_state_transfer_incomplete",
      );
    }

    const fingerprints: Array<[string, string]> = [];
    const workspaceStages: Partial<
      Record<"committed" | "published" | "candidate", TransferStageRecord>
    > = {};
    const threadGroups = new Map<
      string,
      {
        threadId: string;
        committed?: TransferStageRecord;
        candidates: Array<TransferStageRecord | undefined>;
      }
    >();

    for (const stage of stages) {
      if (
        stage.schemaVersion !== TURN_STATE_SCHEMA_VERSION ||
        stage.ownerHash !== manifest.destinationOwnerHash ||
        stage.ownerGeneration !== identity.toOwnerGeneration ||
        stage.workspaceHash !== manifest.destinationWorkspaceHash ||
        stage.transferOperationId !== identity.transferOperationId ||
        stage.manifestFingerprint !== manifest.fingerprint ||
        stage.sourceOwnerHash !== manifest.sourceOwnerHash ||
        stage.sourceOwnerGeneration !== identity.fromOwnerGeneration ||
        stage.sourceWorkspaceHash !== manifest.sourceWorkspaceHash ||
        stage.state !== "copied" ||
        stage.entryFingerprint !== stage.entry.entryFingerprint ||
        (await transferEntryFingerprint(
          (({
            schemaVersion: _schemaVersion,
            entryFingerprint: _entryFingerprint,
            ...unsigned
          }) => unsigned)(stage.entry) as UnsignedTurnStateTransferEntry,
        )) !== stage.entryFingerprint
      ) {
        throw new TurnStateOwnerRouteError(
          "Turn state transfer stage set conflicts with its manifest.",
          409,
          "turn_state_transfer_conflict",
        );
      }
      const plan = await destinationTransferEntryPlan(
        identity,
        manifest,
        stage.entry,
      );
      if (
        stage.destinationOperationId !== plan.operationId ||
        stage.destinationRequestFingerprint !== plan.requestFingerprint ||
        stage.destinationTurnHash !== plan.turnHash ||
        stage.destinationObjectKey !== plan.objectKey
      ) {
        throw new TurnStateOwnerRouteError(
          "Turn state transfer destination plan changed.",
          409,
          "turn_state_transfer_conflict",
        );
      }
      fingerprints.push([
        transferEntryKey(stage.entry),
        stage.entryFingerprint,
      ]);
      if (stage.entry.entryKind === "workspace") {
        if (workspaceStages[stage.entry.disposition]) {
          throw new TurnStateOwnerRouteError(
            "Turn state transfer workspace disposition is duplicated.",
            409,
            "turn_state_transfer_conflict",
          );
        }
        workspaceStages[stage.entry.disposition] = stage;
        continue;
      }
      await assertDestinationNativeCheckpoint(
        stage.nativeCheckpoint,
        identity,
        stage.entry.threadId,
        args.nativeIntegritySecret,
      );
      const group = threadGroups.get(stage.entry.threadHash) ?? {
        threadId: stage.entry.threadId,
        candidates: [],
      };
      if (group.threadId !== stage.entry.threadId) {
        throw new TurnStateOwnerRouteError(
          "Turn state transfer thread candidates disagree on identity.",
          409,
          "turn_state_transfer_conflict",
        );
      }
      if (stage.entry.disposition === "committed") {
        if (group.committed) {
          throw new TurnStateOwnerRouteError(
            "Turn state transfer has multiple committed candidates.",
            409,
            "turn_state_transfer_conflict",
          );
        }
        group.committed = stage;
      } else {
        const ordinal = stage.entry.candidateOrdinal!;
        if (group.candidates[ordinal]) {
          throw new TurnStateOwnerRouteError(
            "Turn state transfer candidate ordinal is duplicated.",
            409,
            "turn_state_transfer_conflict",
          );
        }
        group.candidates[ordinal] = stage;
      }
      threadGroups.set(stage.entry.threadHash, group);
    }
    for (const group of threadGroups.values()) {
      for (let index = 0; index < group.candidates.length; index += 1) {
        if (!group.candidates[index]) {
          throw new TurnStateOwnerRouteError(
            "Turn state transfer candidate ordinals are not contiguous.",
            409,
            "turn_state_transfer_conflict",
          );
        }
      }
    }
    if (workspaceStages.published && workspaceStages.candidate) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer workspace publication topology is invalid.",
        409,
        "turn_state_transfer_conflict",
      );
    }
    const unsignedManifest = { ...manifest };
    delete (unsignedManifest as Partial<TurnStateTransferManifest>).fingerprint;
    if (
      (await transferManifestFingerprint(
        unsignedManifest as Omit<TurnStateTransferManifest, "fingerprint">,
        fingerprints,
      )) !== manifest.fingerprint
    ) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer manifest fingerprint is invalid.",
        409,
        "turn_state_transfer_conflict",
      );
    }

    const committedHead = workspaceStages.committed
      ? await destinationWorkspaceHead(
          workspaceStages.committed,
          manifest,
          identity,
        )
      : undefined;
    const publishedHead = workspaceStages.published
      ? await destinationWorkspaceHead(
          workspaceStages.published,
          manifest,
          identity,
        )
      : undefined;
    const candidateHead = workspaceStages.candidate
      ? await destinationWorkspaceHead(
          workspaceStages.candidate,
          manifest,
          identity,
        )
      : undefined;
    const pendingHead = publishedHead ?? candidateHead;
    if (
      pendingHead &&
      pendingHead.revision !== (committedHead?.revision ?? 0) + 1
    ) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer workspace revision topology is invalid.",
        409,
        "turn_state_transfer_conflict",
      );
    }
    const workspaceArchive =
      publishedHead?.archive ??
      committedHead?.archive ??
      candidateHead?.archive;
    if (threadGroups.size > 0 && !workspaceArchive) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer thread state has no workspace head.",
        409,
        "turn_state_transfer_incomplete",
      );
    }
    const workspaceArchiveByOperation = new Map<string, TurnStateArchive>();
    const exactWorkspaceOriginStage = (
      workspaceStage: TransferStageRecord,
    ): TransferStageRecord => {
      if (workspaceStage.entry.entryKind !== "workspace") {
        throw new TurnStateOwnerRouteError(
          "Turn state transfer workspace origin is invalid.",
          409,
          "turn_state_transfer_conflict",
        );
      }
      const head = workspaceStage.entry.head;
      const originThreadId = workspaceStage.entry.originThreadId;
      const group = threadGroups.get(head.originThreadHash);
      const matches = [
        ...(group?.committed ? [group.committed] : []),
        ...(group?.candidates.filter((stage): stage is TransferStageRecord =>
          Boolean(stage),
        ) ?? []),
      ].filter(
        (stage) =>
          stage.entry.entryKind === "thread" &&
          stage.entry.threadId === originThreadId &&
          stage.entry.candidate.sourceOperationId === head.operationId &&
          stage.entry.candidate.requestFingerprint ===
            head.requestFingerprint &&
          stage.entry.candidate.historyCursor === head.originHistoryCursor &&
          stage.entry.candidate.createdAt === head.createdAt &&
          stage.destinationOperationId ===
            workspaceStage.destinationOperationId &&
          stage.destinationRequestFingerprint ===
            workspaceStage.destinationRequestFingerprint,
      );
      if (
        matches.length !== 1 ||
        (workspaceStage.entry.disposition === "candidate" &&
          matches[0]?.entry.entryKind === "thread" &&
          matches[0].entry.disposition !== "candidate")
      ) {
        throw new TurnStateOwnerRouteError(
          "Turn state transfer workspace origin is invalid.",
          409,
          "turn_state_transfer_conflict",
        );
      }
      return matches[0]!;
    };
    for (const workspaceStage of Object.values(workspaceStages)) {
      if (!workspaceStage?.archive) continue;
      if (
        workspaceArchiveByOperation.has(workspaceStage.destinationOperationId)
      ) {
        throw new TurnStateOwnerRouteError(
          "Turn state transfer workspace operations are duplicated.",
          409,
          "turn_state_transfer_conflict",
        );
      }
      exactWorkspaceOriginStage(workspaceStage);
      workspaceArchiveByOperation.set(
        workspaceStage.destinationOperationId,
        workspaceStage.archive,
      );
    }
    const workspaceRecord: RegistryWorkspaceRecord | undefined =
      committedHead || publishedHead || candidateHead
        ? {
            schemaVersion: TURN_STATE_SCHEMA_VERSION,
            ownerHash: manifest.destinationOwnerHash,
            ownerGeneration: identity.toOwnerGeneration,
            workspaceHash: manifest.destinationWorkspaceHash,
            ...(committedHead ? { committed: committedHead } : {}),
            ...(publishedHead ? { published: publishedHead } : {}),
            ...(candidateHead ? { candidate: candidateHead } : {}),
          }
        : undefined;
    const threadRecords = new Map<string, RegistryThreadRecord>();
    for (const [threadHash, group] of threadGroups) {
      const committed = group.committed
        ? await destinationThreadCandidate(
            group.committed,
            workspaceArchiveByOperation.get(
              group.committed.destinationOperationId,
            ) ?? workspaceArchive!,
          )
        : undefined;
      const candidates: TurnStateCandidate[] = [];
      for (const candidateStage of group.candidates) {
        candidates.push(
          await destinationThreadCandidate(
            candidateStage!,
            workspaceArchiveByOperation.get(
              candidateStage!.destinationOperationId,
            ) ?? workspaceArchive!,
          ),
        );
      }
      threadRecords.set(threadHash, {
        schemaVersion: TURN_STATE_SCHEMA_VERSION,
        ownerHash: manifest.destinationOwnerHash,
        ownerGeneration: identity.toOwnerGeneration,
        workspaceHash: manifest.destinationWorkspaceHash,
        threadHash,
        threadId: group.threadId,
        ...(committed ? { committed } : {}),
        candidates,
      });
    }
    let candidateOperation: RegistryOperationRecord | undefined;
    if (candidateHead && workspaceStages.candidate) {
      const originStage = exactWorkspaceOriginStage(workspaceStages.candidate);
      if (originStage.entry.entryKind !== "thread") {
        throw new TurnStateOwnerRouteError(
          "Turn state transfer candidate origin is invalid.",
          409,
          "turn_state_transfer_conflict",
        );
      }
      const destinationThread = threadRecords.get(
        candidateHead.originThreadHash,
      );
      const destinationCandidates = destinationThread?.candidates.filter(
        (candidate) => candidate.operationId === candidateHead.operationId,
      );
      const destinationCandidate = destinationCandidates?.[0];
      if (
        destinationCandidates?.length !== 1 ||
        !destinationCandidate ||
        destinationCandidate.historyCursor !==
          candidateHead.originHistoryCursor ||
        destinationCandidate.requestFingerprint !==
          candidateHead.requestFingerprint ||
        destinationCandidate.createdAt !== candidateHead.createdAt ||
        !sameJson(destinationCandidate.workspace, candidateHead.archive) ||
        !sameJson(
          destinationCandidate.nativeCheckpoint,
          originStage.nativeCheckpoint,
        )
      ) {
        throw new TurnStateOwnerRouteError(
          "Turn state transfer candidate operation is invalid.",
          409,
          "turn_state_transfer_conflict",
        );
      }
      candidateOperation = {
        schemaVersion: TURN_STATE_SCHEMA_VERSION,
        identity: {
          ownerId: identity.toOwnerId,
          ownerGeneration: identity.toOwnerGeneration,
          threadId: originStage.entry.threadId,
          turnId: identity.turnId,
          attemptGeneration: 1,
        },
        ownerHash: manifest.destinationOwnerHash,
        workspaceHash: manifest.destinationWorkspaceHash,
        threadHash: candidateHead.originThreadHash,
        operationId: candidateHead.operationId,
        requestFingerprint: candidateHead.requestFingerprint,
        historyCursor: candidateHead.originHistoryCursor,
        baseWorkspaceRevision: candidateHead.revision - 1,
        ...(destinationCandidate.nativeCheckpoint
          ? { nativeCheckpoint: destinationCandidate.nativeCheckpoint }
          : {}),
        objectKeys: {
          workspace: candidateHead.archive.key,
          ...(destinationCandidate.native
            ? { native: destinationCandidate.native.key }
            : {}),
        },
        state: "committed",
        receipt: destinationCandidate.receipt,
        createdAt: candidateHead.createdAt,
      };
    }

    const activationReceipt = await transferActivationReceipt(manifest);
    const activationKey = transferActivationKey(
      identity.transferOperationId,
      manifest.destinationWorkspaceHash,
    );
    const activation: TransferActivationRecord = {
      schemaVersion: TURN_STATE_SCHEMA_VERSION,
      ownerHash: manifest.destinationOwnerHash,
      ownerGeneration: identity.toOwnerGeneration,
      workspaceHash: manifest.destinationWorkspaceHash,
      transferOperationId: identity.transferOperationId,
      manifestFingerprint: manifest.fingerprint,
      sourceOwnerHash: manifest.sourceOwnerHash,
      sourceOwnerGeneration: identity.fromOwnerGeneration,
      sourceWorkspaceHash: manifest.sourceWorkspaceHash,
      count: manifest.count,
      entryFingerprints: fingerprints,
      activationReceipt,
    };
    const existingActivation =
      await storage.get<TransferActivationRecord>(activationKey);
    if (existingActivation) {
      if (!sameJson(existingActivation, activation)) {
        throw new TurnStateOwnerRouteError(
          "Turn state transfer activation conflicts with its durable replay.",
          409,
          "turn_state_transfer_conflict",
        );
      }
      const currentWorkspace = await storage.get<RegistryWorkspaceRecord>(
        registryWorkspaceKey(manifest.destinationWorkspaceHash),
      );
      if (!sameJson(currentWorkspace, workspaceRecord)) {
        throw new TurnStateOwnerRouteError(
          "Turn state transfer workspace activation replay is incomplete.",
          409,
          "turn_state_transfer_conflict",
        );
      }
      for (const [threadHash, expected] of threadRecords) {
        if (
          !sameJson(
            await storage.get<RegistryThreadRecord>(
              registryThreadKey(manifest.destinationWorkspaceHash, threadHash),
            ),
            expected,
          )
        ) {
          throw new TurnStateOwnerRouteError(
            "Turn state transfer thread activation replay is incomplete.",
            409,
            "turn_state_transfer_conflict",
          );
        }
      }
      for (const stage of stages) {
        if (!stage.archive) continue;
        const object = await storage.get<RegistryObjectRecord>(
          registryObjectKey(stage.archive.key),
        );
        if (
          object?.state !== "referenced" ||
          !sameJson(object.descriptor, stage.archive)
        ) {
          throw new TurnStateOwnerRouteError(
            "Turn state transfer object activation replay is incomplete.",
            409,
            "turn_state_transfer_conflict",
          );
        }
      }
      const activatedRecords = new Map<string, unknown>([
        [activationKey, activation],
        ...(workspaceRecord
          ? [
              [
                registryWorkspaceKey(manifest.destinationWorkspaceHash),
                workspaceRecord,
              ] as [string, unknown],
            ]
          : []),
        ...[...threadRecords].map(
          ([threadHash, record]) =>
            [
              registryThreadKey(manifest.destinationWorkspaceHash, threadHash),
              record,
            ] as [string, unknown],
        ),
        ...(candidateOperation
          ? [
              [
                `turn-state:v1:operation:${candidateOperation.operationId}`,
                candidateOperation,
              ] as [string, unknown],
            ]
          : []),
      ]);
      await assertDestinationTransferScope(storage, identity, manifest, {
        objectState: "activated",
        activatedRecords,
      });
      return {
        manifestFingerprint: manifest.fingerprint,
        activationReceipt,
        count: manifest.count,
        replayed: true,
      };
    }

    await assertDestinationTransferScope(storage, identity, manifest, {
      objectState: "staged",
    });

    const marker = await storage.get<{ ownerHash?: string }>(OWNER_MARKER_KEY);
    if (marker && marker.ownerHash !== manifest.destinationOwnerHash) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer destination owner registry conflicts.",
        409,
        "turn_state_transfer_destination_conflict",
      );
    }
    if (
      await storage.get(registryWorkspaceKey(manifest.destinationWorkspaceHash))
    ) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer destination workspace already exists.",
        409,
        "turn_state_transfer_destination_conflict",
      );
    }
    if (
      await destinationHasThreadState(
        storage,
        manifest.destinationWorkspaceHash,
      )
    ) {
      throw new TurnStateOwnerRouteError(
        "Turn state transfer destination workspace has thread state.",
        409,
        "turn_state_transfer_destination_conflict",
      );
    }
    for (const stage of stages) {
      if (!stage.archive) continue;
      const plan = await destinationTransferEntryPlan(
        identity,
        manifest,
        stage.entry,
      );
      const object = await storage.get<RegistryObjectRecord>(
        registryObjectKey(stage.archive.key),
      );
      const expected = {
        schemaVersion: TURN_STATE_SCHEMA_VERSION,
        ownerHash: manifest.destinationOwnerHash,
        ownerGeneration: identity.toOwnerGeneration,
        workspaceHash: manifest.destinationWorkspaceHash,
        threadHash: plan.threadHash,
        operationId: plan.operationId,
        kind: stage.archive.kind,
        key: stage.archive.key,
      } satisfies Omit<RegistryObjectRecord, "state" | "descriptor">;
      if (
        !exactRegistryObjectIdentity(object, expected) ||
        object?.state !== "uploaded" ||
        !sameJson(object.descriptor, stage.archive)
      ) {
        throw new TurnStateOwnerRouteError(
          "Turn state transfer destination archive is not staged.",
          409,
          "turn_state_transfer_incomplete",
        );
      }
    }

    await storage.put(OWNER_MARKER_KEY, {
      schemaVersion: TURN_STATE_SCHEMA_VERSION,
      ownerHash: manifest.destinationOwnerHash,
    });
    if (workspaceRecord) {
      await storage.put(
        registryWorkspaceKey(manifest.destinationWorkspaceHash),
        workspaceRecord,
      );
    }
    for (const [threadHash, record] of threadRecords) {
      await storage.put(
        registryThreadKey(manifest.destinationWorkspaceHash, threadHash),
        record,
      );
    }
    if (candidateOperation) {
      await storage.put(
        `turn-state:v1:operation:${candidateOperation.operationId}`,
        candidateOperation,
      );
    }
    for (const stage of stages) {
      if (!stage.archive) continue;
      const key = registryObjectKey(stage.archive.key);
      const object = (await storage.get<RegistryObjectRecord>(key))!;
      await storage.put(key, {
        ...object,
        state: "referenced",
      } satisfies RegistryObjectRecord);
    }
    await storage.put(activationKey, activation);
    return {
      manifestFingerprint: manifest.fingerprint,
      activationReceipt,
      count: manifest.count,
      replayed: false,
    };
  });
const createTransferGuardedStorage = (
  args: {
    storage: DurableObjectStorage;
    scopedOwnerId: string;
    now?: () => number;
  },
  identity: TransferRouteIdentity,
): StrongTurnStateStorage => {
  const base = createDurableObjectTurnStateStorage(args.storage);
  return {
    get: async <T = unknown>(key: string): Promise<T | undefined> =>
      await base.get<T>(key),
    list: async <T = unknown>(options = {}): Promise<Map<string, T>> =>
      await base.list<T>(options),
    put: async (key: string, value: unknown): Promise<void> =>
      await withCurrentTransferLeaseTransaction(
        args,
        identity,
        async (storage) => await storage.put(key, value),
      ),
    delete: async (key: string): Promise<boolean> =>
      await withCurrentTransferLeaseTransaction(
        args,
        identity,
        async (storage) => await storage.delete(key),
      ),
    transaction: async <T>(
      closure: (storage: StrongTurnStateStorage) => Promise<T>,
    ): Promise<T> =>
      await withCurrentTransferLeaseTransaction(
        args,
        identity,
        async (storage) => await closure(storage),
      ),
  };
};

const createTransferGuardedObjectStore = (
  args: {
    storage: DurableObjectStorage;
    scopedOwnerId: string;
    now?: () => number;
  },
  identity: TransferRouteIdentity,
  bucket: R2Bucket,
): TurnStateObjectStore => {
  const base = createR2TurnStateObjectStore(bucket);
  return {
    list: async (prefix, cursor) => await base.list(prefix, cursor),
    head: async (key) => await base.head(key),
    delete: async (key) => {
      await withCurrentTransferLeaseTransaction(
        args,
        identity,
        async () => undefined,
      );
      await base.delete(key);
    },
  };
};

const createOpenWorldLeaseGuardedStorage = (
  args: {
    storage: DurableObjectStorage;
    scopedOwnerId: string;
    now?: () => number;
  },
  lease: ReturnType<typeof parseCommonLease>,
): StrongTurnStateStorage => {
  const base = createDurableObjectTurnStateStorage(args.storage);
  return {
    get: async <T = unknown>(key: string): Promise<T | undefined> =>
      await base.get<T>(key),
    list: async <T = unknown>(options = {}): Promise<Map<string, T>> =>
      await base.list<T>(options),
    put: async (key: string, value: unknown): Promise<void> =>
      await withCurrentOpenWorldActivityLeaseTransaction(
        args,
        lease,
        async (storage) => await storage.put(key, value),
      ),
    delete: async (key: string): Promise<boolean> =>
      await withCurrentOpenWorldActivityLeaseTransaction(
        args,
        lease,
        async (storage) => await storage.delete(key),
      ),
    transaction: async <T>(
      closure: (storage: StrongTurnStateStorage) => Promise<T>,
    ): Promise<T> =>
      await withCurrentOpenWorldActivityLeaseTransaction(
        args,
        lease,
        async (storage) => await closure(storage),
      ),
  };
};

const createOpenWorldLeaseGuardedObjectStore = (
  args: {
    storage: DurableObjectStorage;
    scopedOwnerId: string;
    now?: () => number;
  },
  lease: ReturnType<typeof parseCommonLease>,
  bucket: R2Bucket,
): TurnStateObjectStore => {
  const base = createR2TurnStateObjectStore(bucket);
  return {
    list: async (prefix, cursor) => await base.list(prefix, cursor),
    head: async (key) => await base.head(key),
    delete: async (key) => {
      await withCurrentOpenWorldActivityLeaseTransaction(
        args,
        lease,
        async () => undefined,
      );
      await base.delete(key);
    },
  };
};

const COMMON_LEASE_KEYS = [
  "schemaVersion",
  "ownerId",
  "ownerGeneration",
  "generation",
  "leaseId",
  "sessionId",
  "turnId",
] as const;

const TRANSFER_IDENTITY_KEYS = [
  ...COMMON_LEASE_KEYS,
  "transferOperationId",
  "fromOwnerId",
  "fromOwnerGeneration",
  "toOwnerId",
  "toOwnerGeneration",
] as const;

const validateSchemaVersion = (row: Record<string, unknown>): void => {
  if (row.schemaVersion !== TURN_STATE_SCHEMA_VERSION) {
    throw new TurnStateOwnerRouteError(
      "Turn state schema version is invalid.",
      400,
      "invalid_request",
    );
  }
};

const routeConflict = (error: unknown): never => {
  if (error instanceof TurnStateOwnerRouteError) throw error;
  if (error instanceof Error) {
    throw new TurnStateOwnerRouteError(
      "Turn state operation conflicts with durable state.",
      409,
      "turn_state_conflict",
    );
  }
  throw error;
};

/**
 * Private route handler for the owner-fence Durable Object. It intentionally
 * performs no public authentication: its caller has already selected the
 * owner-named stub. It still treats every JSON field as untrusted and repeats
 * the exact durable owner/generation/lease checks before touching state.
 * `createdAt`, `requireNative`, and the canonical workspace are trusted Builder
 * facts, but remain strictly typed and bounded here. In particular, createdAt
 * must be persisted once by the caller so a lost prepare response replays the
 * identical registry operation instead of introducing a new timestamp.
 */
export const handleTurnStateOwnerRoute = async (args: {
  path: string;
  request: Request;
  scopedOwnerId: string;
  fence: TurnStateOwnerFence;
  storage: DurableObjectStorage;
  bucket: R2Bucket;
  /** In-process only; never accepted from request JSON or persisted. */
  nativeIntegritySecret?: string;
  now?: () => number;
}): Promise<Response | null> => {
  if (!args.path.startsWith("turn-state/")) return null;
  if (args.request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }
  try {
    const raw = await readBoundedJson(args.request);
    const storage = createDurableObjectTurnStateStorage(args.storage);
    const objectStore = createR2TurnStateObjectStore(args.bucket);

    if (args.path === "turn-state/prepare") {
      const row = exactObject(
        raw,
        [
          ...COMMON_LEASE_KEYS,
          "threadId",
          "attemptGeneration",
          "baseWorkspaceRevision",
          "requestFingerprint",
          "historyCursor",
          "createdAt",
        ],
        ["nativeCheckpoint"],
      );
      validateSchemaVersion(row);
      const lease = parseCommonLease(row);
      assertOpenLease(args.scopedOwnerId, args.fence, lease);
      const historyCursor = requiredText(row, "historyCursor", 1_024);
      const identity: TurnStateIdentity = {
        ownerId: lease.ownerId,
        ownerGeneration: lease.ownerGeneration,
        threadId: requiredText(row, "threadId"),
        turnId: lease.turnId,
        attemptGeneration: requiredSafeInteger(row, "attemptGeneration", 1),
      };
      const nativeCheckpoint = Object.hasOwn(row, "nativeCheckpoint")
        ? parseNativeCheckpoint(row.nativeCheckpoint, historyCursor)
        : undefined;
      const requestFingerprint = requiredHex(row, "requestFingerprint");
      const baseWorkspaceRevision = requiredSafeInteger(
        row,
        "baseWorkspaceRevision",
        0,
      );
      const createdAt = requiredSafeInteger(row, "createdAt", 0);
      const prepared = await withCurrentOpenLeaseTransaction(
        args,
        lease,
        async (transaction) => {
          const result = await prepareTurnStateOperation(transaction, {
            identity,
            requestFingerprint,
            historyCursor,
            baseWorkspaceRevision,
            ...(nativeCheckpoint ? { nativeCheckpoint } : {}),
            createdAt,
          });
          const authorization: RouteOperationAuthorization = {
            schemaVersion: TURN_STATE_SCHEMA_VERSION,
            scope: "turn",
            ownerHash: result.ownerHash,
            workspaceHash: result.workspaceHash,
            threadHash: result.threadHash,
            operationId: result.operationId,
            ownerId: lease.ownerId,
            ownerGeneration: lease.ownerGeneration,
            fenceGeneration: lease.generation,
            leaseId: lease.leaseId,
            sessionId: lease.sessionId,
            turnId: lease.turnId,
            threadId: identity.threadId,
            attemptGeneration: identity.attemptGeneration,
            baseWorkspaceRevision,
            requestFingerprint,
            createdAt,
            objectKeys: result.objectKeys,
          };
          await authorizePreparedOperation(transaction, authorization);
          return result;
        },
      ).catch(routeConflict);
      return json(prepared);
    }

    if (args.path === "turn-state/legacy-seed-prepare") {
      const row = exactObject(raw, [
        ...COMMON_LEASE_KEYS,
        "requestFingerprint",
        "createdAt",
      ]);
      validateSchemaVersion(row);
      const lease = parseCommonLease(row);
      assertOpenLease(args.scopedOwnerId, args.fence, lease);
      const requestFingerprint = requiredHex(row, "requestFingerprint");
      const createdAt = requiredSafeInteger(row, "createdAt", 0);
      const identity: TurnStateIdentity = {
        ownerId: lease.ownerId,
        ownerGeneration: lease.ownerGeneration,
        threadId: LEGACY_SEED_THREAD_ID,
        turnId: LEGACY_SEED_THREAD_ID,
        attemptGeneration: 1,
      };
      const prepared = await withCurrentOpenLeaseTransaction(
        args,
        lease,
        async (transaction) => {
          const [ownerHash, workspaceHash] = await Promise.all([
            sha256Hex(lease.ownerId),
            sha256Hex(WORLD_REGISTRY_SEGMENT),
          ]);
          const bindingKey = `${LEGACY_SEED_BINDING_PREFIX}${workspaceHash}`;
          const existingBinding =
            await transaction.get<LegacySeedBinding>(bindingKey);
          if (
            existingBinding &&
            (existingBinding.ownerHash !== ownerHash ||
              existingBinding.ownerGeneration !== lease.ownerGeneration ||
              existingBinding.workspaceHash !== workspaceHash ||
              existingBinding.requestFingerprint !== requestFingerprint ||
              existingBinding.createdAt !== createdAt)
          ) {
            throw new TurnStateOwnerRouteError(
              "Legacy workspace seed conflicts with its first durable source.",
              409,
              "legacy_seed_conflict",
            );
          }
          const result = await prepareTurnStateOperation(transaction, {
            identity,
            requestFingerprint,
            historyCursor: LEGACY_SEED_HISTORY_CURSOR,
            baseWorkspaceRevision: 0,
            createdAt,
          });
          const binding: LegacySeedBinding = {
            schemaVersion: TURN_STATE_SCHEMA_VERSION,
            ownerHash: result.ownerHash,
            ownerGeneration: lease.ownerGeneration,
            workspaceHash: result.workspaceHash,
            operationId: result.operationId,
            requestFingerprint,
            createdAt,
          };
          if (existingBinding && !sameJson(existingBinding, binding)) {
            throw new TurnStateOwnerRouteError(
              "Legacy workspace seed conflicts with its first durable source.",
              409,
              "legacy_seed_conflict",
            );
          }
          if (!existingBinding) await transaction.put(bindingKey, binding);
          await authorizePreparedOperation(
            transaction,
            {
              schemaVersion: TURN_STATE_SCHEMA_VERSION,
              scope: "legacy-seed",
              ownerHash: result.ownerHash,
              workspaceHash: result.workspaceHash,
              threadHash: result.threadHash,
              operationId: result.operationId,
              ownerId: lease.ownerId,
              ownerGeneration: lease.ownerGeneration,
              fenceGeneration: lease.generation,
              leaseId: lease.leaseId,
              sessionId: lease.sessionId,
              turnId: lease.turnId,
              threadId: LEGACY_SEED_THREAD_ID,
              attemptGeneration: 1,
              baseWorkspaceRevision: 0,
              requestFingerprint,
              createdAt,
              objectKeys: result.objectKeys,
            },
            { allowLegacySeedAdoption: true },
          );
          return result;
        },
      ).catch(routeConflict);
      return json({
        ...prepared,
        threadId: LEGACY_SEED_THREAD_ID,
        historyCursor: LEGACY_SEED_HISTORY_CURSOR,
      });
    }

    if (args.path === "turn-state/mark-uploaded") {
      const row = exactObject(raw, [
        ...COMMON_LEASE_KEYS,
        "operationId",
        "archive",
      ]);
      validateSchemaVersion(row);
      const lease = parseCommonLease(row);
      assertOpenLease(args.scopedOwnerId, args.fence, lease);
      const operationId = requiredHex(row, "operationId");
      const authorization = await requireOperationAuthorization(
        storage,
        operationId,
        lease,
      );
      const archive = parseArchive(row.archive);
      if (authorization.objectKeys[archive.kind] !== archive.key) {
        throw new TurnStateOwnerRouteError(
          "Turn state archive belongs to another operation.",
          409,
          "operation_scope_mismatch",
        );
      }
      await assertDurableArchiveObject(
        args.bucket,
        archive,
        archiveTarget(archive.kind),
      );
      const uploaded = await withCurrentOpenLeaseTransaction(
        args,
        lease,
        async (transaction) => {
          const currentAuthorization = await requireOperationAuthorization(
            transaction,
            operationId,
            lease,
          );
          if (currentAuthorization.objectKeys[archive.kind] !== archive.key) {
            throw new TurnStateOwnerRouteError(
              "Turn state archive belongs to another operation.",
              409,
              "operation_scope_mismatch",
            );
          }
          return await markTurnStateObjectUploaded(transaction, {
            operationId,
            archive,
          });
        },
      ).catch(routeConflict);
      return json(uploaded);
    }

    if (args.path === "turn-state/commit") {
      const row = exactObject(raw, [...COMMON_LEASE_KEYS, "operationId"]);
      validateSchemaVersion(row);
      const lease = parseCommonLease(row);
      assertOpenLease(args.scopedOwnerId, args.fence, lease);
      const operationId = requiredHex(row, "operationId");
      await requireOperationAuthorization(storage, operationId, lease);
      const committed = await withCurrentOpenLeaseTransaction(
        args,
        lease,
        async (transaction) => {
          await requireOperationAuthorization(transaction, operationId, lease);
          return await commitTurnStateOperation(transaction, { operationId });
        },
      ).catch(routeConflict);
      return json(committed);
    }

    if (args.path === "turn-state/publish-workspace") {
      const row = exactObject(raw, [
        ...COMMON_LEASE_KEYS,
        "threadId",
        "canonicalHistoryCursor",
        "operationId",
      ]);
      validateSchemaVersion(row);
      const lease = parseCommonLease(row);
      assertOpenLease(args.scopedOwnerId, args.fence, lease);
      const operationId = requiredHex(row, "operationId");
      const threadId = requiredText(row, "threadId");
      const canonicalHistoryCursor = requiredText(
        row,
        "canonicalHistoryCursor",
        1_024,
      );
      const published = await withCurrentOpenLeaseTransaction(
        args,
        lease,
        async (transaction) =>
          await publishTurnStateWorkspace(transaction, {
            identity: {
              ownerId: lease.ownerId,
              ownerGeneration: lease.ownerGeneration,
              threadId,
            },
            canonicalHistoryCursor,
            operationId,
          }),
      ).catch(routeConflict);
      return json(published);
    }

    if (args.path === "turn-state/abort-unpublished") {
      const row = exactObject(raw, [
        ...COMMON_LEASE_KEYS,
        "threadId",
        "operationId",
        "baseWorkspaceRevision",
        "candidateHistoryCursor",
        "canonicalHistoryCursor",
      ]);
      validateSchemaVersion(row);
      const lease = parseCommonLease(row);
      assertOpenLease(args.scopedOwnerId, args.fence, lease);
      const candidateHistoryCursor = requiredText(
        row,
        "candidateHistoryCursor",
        1_024,
      );
      const canonicalHistoryCursor = requiredText(
        row,
        "canonicalHistoryCursor",
        1_024,
      );
      if (candidateHistoryCursor === canonicalHistoryCursor) {
        throw new TurnStateOwnerRouteError(
          "A canonical workspace candidate cannot be aborted.",
          409,
          "turn_state_abort_conflict",
        );
      }
      const aborted = await withCurrentOpenLeaseTransaction(
        args,
        lease,
        async (transaction) =>
          await abortUnpublishedTurnState(transaction, {
            ownerId: lease.ownerId,
            ownerGeneration: lease.ownerGeneration,
            threadId: requiredText(row, "threadId"),
            operationId: requiredHex(row, "operationId"),
            baseWorkspaceRevision: requiredSafeInteger(
              row,
              "baseWorkspaceRevision",
              0,
            ),
            candidateHistoryCursor,
            canonicalHistoryCursor,
          }),
      ).catch(routeConflict);
      return json(aborted);
    }

    if (args.path === "turn-state/resolve") {
      const row = exactObject(raw, [
        ...COMMON_LEASE_KEYS,
        "threadId",
        "canonicalHistoryCursor",
        "requireNative",
      ]);
      validateSchemaVersion(row);
      const lease = parseCommonLease(row);
      assertOpenLease(args.scopedOwnerId, args.fence, lease);
      if (typeof row.requireNative !== "boolean") {
        throw new TurnStateOwnerRouteError(
          "requireNative is invalid.",
          400,
          "invalid_request",
        );
      }
      const requireNative = row.requireNative;
      const resolved = await withCurrentOpenLeaseTransaction(
        args,
        lease,
        async (transaction) =>
          await resolveTurnState(transaction, {
            identity: {
              ownerId: lease.ownerId,
              ownerGeneration: lease.ownerGeneration,
              threadId: requiredText(row, "threadId"),
            },
            canonicalHistoryCursor: requiredText(
              row,
              "canonicalHistoryCursor",
              1_024,
            ),
            requireNative,
          }),
      ).catch(routeConflict);
      return json(resolved);
    }

    if (args.path === "turn-state/confirm-restore") {
      const row = exactObject(
        raw,
        [...COMMON_LEASE_KEYS, "threadId", "canonicalHistoryCursor"],
        ["workspaceOperationId", "threadOperationId"],
      );
      validateSchemaVersion(row);
      const lease = parseCommonLease(row);
      assertOpenLease(args.scopedOwnerId, args.fence, lease);
      const workspaceOperationId = Object.hasOwn(row, "workspaceOperationId")
        ? requiredHex(row, "workspaceOperationId")
        : undefined;
      const threadOperationId = Object.hasOwn(row, "threadOperationId")
        ? requiredHex(row, "threadOperationId")
        : undefined;
      if (!workspaceOperationId && !threadOperationId) {
        throw new TurnStateOwnerRouteError(
          "At least one restore operation id is required.",
          400,
          "invalid_request",
        );
      }
      const now = args.now?.() ?? Date.now();
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new Error("Turn state route clock is invalid.");
      }
      const confirmed = await withCurrentOpenLeaseTransaction(
        args,
        lease,
        async (transaction) =>
          await confirmTurnStateRestore(transaction, {
            identity: {
              ownerId: lease.ownerId,
              ownerGeneration: lease.ownerGeneration,
              threadId: requiredText(row, "threadId"),
            },
            canonicalHistoryCursor: requiredText(
              row,
              "canonicalHistoryCursor",
              1_024,
            ),
            ...(workspaceOperationId ? { workspaceOperationId } : {}),
            ...(threadOperationId ? { threadOperationId } : {}),
            now,
          }),
      ).catch(routeConflict);
      return json(confirmed);
    }

    if (args.path === "turn-state/drain") {
      const row = exactObject(raw, [...COMMON_LEASE_KEYS], ["limit"]);
      validateSchemaVersion(row);
      const lease = parseCommonLease(row);
      assertOpenLease(args.scopedOwnerId, args.fence, lease);
      const limit = Object.hasOwn(row, "limit")
        ? requiredSafeInteger(row, "limit", 1, 128)
        : undefined;
      try {
        const result = await drainTurnStateRetirements(storage, objectStore, {
          ownerId: lease.ownerId,
          ownerGeneration: lease.ownerGeneration,
          ...(limit ? { limit } : {}),
        });
        await withCurrentOpenLeaseTransaction(
          args,
          lease,
          async (transaction) =>
            await clearRetiredRouteAuthorizations(transaction, {
              ownerId: lease.ownerId,
              ownerGeneration: lease.ownerGeneration,
            }),
        );
        return json(result, result.pending ? 202 : 200);
      } catch (error) {
        routeConflict(error);
      }
    }

    if (args.path === "turn-state/transfer-status") {
      const row = exactObject(raw, TRANSFER_IDENTITY_KEYS);
      validateSchemaVersion(row);
      const identity = parseTransferIdentity(row, "destination");
      assertTransferLease(
        args.scopedOwnerId,
        args.fence,
        identity,
        transferRouteNow(args.now),
      );
      return json(
        await withCurrentTransferLeaseTransaction(
          args,
          identity,
          async (storage) => await destinationTransferStatus(storage, identity),
        ).catch(routeConflict),
      );
    }

    if (args.path === "turn-state/transfer-export") {
      const row = exactObject(raw, TRANSFER_IDENTITY_KEYS, ["cursor", "limit"]);
      validateSchemaVersion(row);
      const identity = parseTransferIdentity(row, "source");
      assertTransferLease(
        args.scopedOwnerId,
        args.fence,
        identity,
        transferRouteNow(args.now),
      );
      const cursor = Object.hasOwn(row, "cursor")
        ? requiredSafeInteger(row, "cursor", 0, MAX_TRANSFER_ENTRIES)
        : 0;
      const limit = Object.hasOwn(row, "limit")
        ? requiredSafeInteger(row, "limit", 1, MAX_TRANSFER_PAGE_ENTRIES)
        : MAX_TRANSFER_PAGE_ENTRIES;
      const exported = await withCurrentTransferLeaseTransaction(
        args,
        identity,
        async (transaction) =>
          await collectSourceTransferEntries(
            transaction,
            identity,
            args.nativeIntegritySecret,
          ),
      ).catch(routeConflict);
      if (cursor > exported.entries.length) {
        throw new TurnStateOwnerRouteError(
          "Turn state transfer export cursor is invalid.",
          400,
          "invalid_request",
        );
      }
      const entries = exported.entries.slice(cursor, cursor + limit);
      const nextCursor = cursor + entries.length;
      return json({
        manifest: exported.manifest,
        entries,
        ...(nextCursor < exported.entries.length ? { nextCursor } : {}),
      } satisfies TurnStateTransferExportResponse);
    }

    if (args.path === "turn-state/transfer-stage") {
      const row = exactObject(raw, [
        ...TRANSFER_IDENTITY_KEYS,
        "manifest",
        "entry",
      ]);
      validateSchemaVersion(row);
      const identity = parseTransferIdentity(row, "destination");
      assertTransferLease(
        args.scopedOwnerId,
        args.fence,
        identity,
        transferRouteNow(args.now),
      );
      const manifest = parseTransferManifest(row.manifest);
      await assertManifestIdentity(manifest, identity);
      const entry = await parseTransferEntry(row.entry, manifest);
      if (entry.entryKind === "thread") {
        await assertSourceNativeCheckpoint(
          entry.candidate.nativeCheckpoint,
          identity,
          entry.threadId,
          args.nativeIntegritySecret,
        );
      }
      const destinationNativeCheckpoint =
        entry.entryKind === "thread"
          ? await remacDestinationNativeCheckpoint(
              entry.candidate.nativeCheckpoint,
              identity,
              entry.threadId,
              args.nativeIntegritySecret,
            )
          : undefined;
      const plan = await destinationTransferEntryPlan(
        identity,
        manifest,
        entry,
      );
      const reservation = await reserveTransferStage(
        args,
        identity,
        manifest,
        entry,
        plan,
      ).catch(routeConflict);
      const sourceArchive =
        entry.entryKind === "workspace"
          ? entry.head.archive
          : entry.candidate.native;
      const copied =
        sourceArchive && plan.objectKey
          ? await copyTurnStateArchive({
              bucket: args.bucket,
              source: sourceArchive,
              destinationKey: plan.objectKey,
              target: archiveTarget(sourceArchive.kind),
            }).catch(routeConflict)
          : undefined;
      const completed = await completeTransferStage(
        args,
        identity,
        manifest,
        reservation,
        copied?.archive,
        destinationNativeCheckpoint,
      ).catch(routeConflict);
      return json({
        manifestFingerprint: manifest.fingerprint,
        entryKind: entry.entryKind,
        entryFingerprint: entry.entryFingerprint,
        ...(entry.entryKind === "thread"
          ? { threadHash: entry.threadHash }
          : {}),
        replayed: completed.replayed,
      } satisfies TurnStateTransferStageResponse);
    }

    if (args.path === "turn-state/transfer-activate") {
      const row = exactObject(raw, [...TRANSFER_IDENTITY_KEYS, "manifest"]);
      validateSchemaVersion(row);
      const identity = parseTransferIdentity(row, "destination");
      assertTransferLease(
        args.scopedOwnerId,
        args.fence,
        identity,
        transferRouteNow(args.now),
      );
      const manifest = parseTransferManifest(row.manifest);
      await assertManifestIdentity(manifest, identity);
      // HEAD proof is intentionally outside the strong transaction. The
      // following activation transaction rechecks both the exact lease and
      // every staged descriptor before publishing any thread pointer.
      const staged = await withCurrentTransferLeaseTransaction(
        args,
        identity,
        async (storage) => [
          ...(
            await listAllPrefix<TransferStageRecord>(
              storage,
              transferStagePrefix(
                identity.transferOperationId,
                manifest.destinationWorkspaceHash,
              ),
            )
          ).values(),
        ],
      ).catch(routeConflict);
      for (const stage of staged) {
        if (stage.archive) {
          await assertDurableArchiveObject(
            args.bucket,
            stage.archive,
            archiveTarget(stage.archive.kind),
          );
        }
      }
      return json(
        await activateTransfer(args, identity, manifest).catch(routeConflict),
      );
    }

    if (args.path === "turn-state/transfer-retire") {
      const row = exactObject(raw, [
        ...TRANSFER_IDENTITY_KEYS,
        "manifest",
        "activationReceipt",
      ]);
      validateSchemaVersion(row);
      const identity = parseTransferIdentity(row, "source");
      assertTransferLease(
        args.scopedOwnerId,
        args.fence,
        identity,
        transferRouteNow(args.now),
      );
      const manifest = parseTransferManifest(row.manifest);
      await assertManifestIdentity(manifest, identity);
      const activationReceipt = requiredHex(row, "activationReceipt");
      if (activationReceipt !== (await transferActivationReceipt(manifest))) {
        throw new TurnStateOwnerRouteError(
          "Turn state transfer activation receipt is invalid.",
          409,
          "turn_state_transfer_conflict",
        );
      }
      await withCurrentTransferLeaseTransaction(
        args,
        identity,
        async (storage) => {
          const current = await collectSourceTransferEntries(
            storage,
            identity,
            args.nativeIntegritySecret,
          );
          if (current.manifest.fingerprint === manifest.fingerprint) return;
          // Once the exact prior retire completed, the committed source rows
          // no longer exist. Full scoped emptiness is the only replay authority
          // accepted in place of recomputing the original manifest.
          try {
            await assertFullWorldRegistryEmpty(storage, identity.fromOwnerId);
          } catch {
            throw new TurnStateOwnerRouteError(
              "Turn state transfer source changed after export.",
              409,
              "turn_state_transfer_conflict",
            );
          }
        },
      ).catch(routeConflict);
      const guardedStorage = createTransferGuardedStorage(args, identity);
      const guardedObjectStore = createTransferGuardedObjectStore(
        args,
        identity,
        args.bucket,
      );
      const retired = await purgeTurnState(guardedStorage, guardedObjectStore, {
        ownerId: identity.fromOwnerId,
        ownerPurgeFence: "blocked",
      }).catch(routeConflict);
      let emptyReceipt: string | undefined;
      if (!retired.pending) {
        await withCurrentTransferLeaseTransaction(
          args,
          identity,
          async (storage) =>
            await assertFullWorldRegistryEmpty(
              storage,
              identity.fromOwnerId,
            ),
        ).catch(routeConflict);
        const scannedEmptyReceipt = await assertTurnStateTransferSourceEmpty(
          guardedStorage,
          guardedObjectStore,
          { ownerId: identity.fromOwnerId },
        ).catch(routeConflict);
        // The full R2 scan can outlive the reservation. Recheck the exact
        // transfer lease and strong registry after it, before emitting the
        // empty receipt; any newly admitted build must first create strong
        // scoped metadata and is therefore observed here.
        await withCurrentTransferLeaseTransaction(
          args,
          identity,
          async (storage) =>
            await assertFullWorldRegistryEmpty(
              storage,
              identity.fromOwnerId,
            ),
        ).catch(routeConflict);
        emptyReceipt = scannedEmptyReceipt;
      }
      return json(
        {
          manifestFingerprint: manifest.fingerprint,
          activationReceipt,
          pending: retired.pending,
          deleted: retired.deleted,
          prefix: retired.prefix,
          ...(emptyReceipt ? { emptyReceipt } : {}),
        } satisfies TurnStateTransferRetireResponse,
        retired.pending ? 202 : 200,
      );
    }

    if (args.path === "turn-state/purge-world") {
      const row = exactObject(raw, [...COMMON_LEASE_KEYS]);
      validateSchemaVersion(row);
      const lease = parseCommonLease(row);
      assertOpenWorldActivityLease(
        args.scopedOwnerId,
        args.fence,
        lease,
        transferRouteNow(args.now),
      );
      const result = await purgeTurnState(
        createOpenWorldLeaseGuardedStorage(args, lease),
        createOpenWorldLeaseGuardedObjectStore(args, lease, args.bucket),
        { ownerId: lease.ownerId, ownerPurgeFence: "blocked" },
      );
      await withCurrentOpenWorldActivityLeaseTransaction(
        args,
        lease,
        async () => undefined,
      );
      return json(result, result.pending ? 202 : 200);
    }

    if (args.path === "turn-state/purge") {
      const row = exactObject(raw, ["schemaVersion", "ownerId", "generation"]);
      validateSchemaVersion(row);
      assertBlockedFence(args.scopedOwnerId, args.fence, row);
      const blocked = await currentBlockedFence(
        args.storage,
        args.scopedOwnerId,
        row,
      );
      const result = await purgeTurnState(storage, objectStore, {
        ownerId: blocked.ownerId,
        ownerPurgeFence: "blocked",
      });
      return json(result, result.pending ? 202 : 200);
    }

    if (args.path === "turn-state/transfer-empty") {
      const row = exactObject(raw, ["schemaVersion", "ownerId", "generation"]);
      validateSchemaVersion(row);
      assertBlockedFence(args.scopedOwnerId, args.fence, row);
      const blocked = await currentBlockedFence(
        args.storage,
        args.scopedOwnerId,
        row,
      );
      try {
        await assertFullWorldRegistryEmpty(storage, blocked.ownerId);
        return json({
          receipt: await assertTurnStateTransferSourceEmpty(
            storage,
            objectStore,
            { ownerId: blocked.ownerId },
          ),
        });
      } catch (error) {
        routeConflict(error);
      }
    }

    return json({ error: "Not found." }, 404);
  } catch (error) {
    if (error instanceof TurnStateOwnerRouteError) {
      return json({ error: error.message, code: error.code }, error.status);
    }
    return json(
      { error: "Turn state owner route failed.", code: "internal_error" },
      500,
    );
  }
};
