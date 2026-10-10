import { sha256Hex } from "./hash.js";
import {
  TURN_STATE_ARCHIVE_CONTENT_TYPE,
  TURN_STATE_MAX_ARCHIVE_BYTES,
  turnStateArchiveMetadataMatches,
  type TurnStateArchiveTarget,
} from "./turn-state-archive.js";
import {
  TURN_STATE_OBJECT_FORMAT,
  TURN_STATE_OBJECT_PREFIX,
  TURN_STATE_SCHEMA_VERSION,
  WORLD_REGISTRY_SEGMENT,
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
} from "./turn-state-registry.js";
import { json } from "./http/response.js";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_STORAGE_KEY_BYTES = 4_096;
const MAX_CURSOR_BYTES = 4_096;
const ROUTE_OPERATION_PREFIX = "turn-state:v1:route-operation:";
const ABORT_UNPUBLISHED_PREFIX = "turn-state:v1:abort-unpublished:";
const OWNER_FENCE_KEY = "ownerPurgeFence";
type OwnerLease = {
  leaseId: string;
  sessionId: string;
  turnId: string;
  namespace: "build" | "orchestrator" | "activity";
  role: "run" | "aux" | "orchestrator" | "activity";
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
  scope: "turn";
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
  requestFingerprint: string;
  createdAt: number;
  objectKeys: { native?: string };
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

type RegistryObjectRecord = {
  schemaVersion: typeof TURN_STATE_SCHEMA_VERSION;
  ownerHash: string;
  ownerGeneration: string;
  workspaceHash: string;
  threadHash: string;
  operationId: string;
  kind: "native";
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
  manifestId?: string;
  nativeCheckpoint?: TurnStateNativeCheckpoint;
  objectKeys: { native?: string };
  state: "prepared" | "committed";
  receipt?: string;
  publicationReceipt?: string;
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
  candidateHistoryCursor: string;
  canonicalHistoryCursor: string;
  objectKeys: string[];
  abortReceipt: string;
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
      routeNow(args.now),
    );
    return await operation(createTransactionTurnStateStorage(transaction));
  });

const routeNow = (now: (() => number) | undefined): number => {
  const value = now?.() ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Turn state route clock is invalid.");
  }
  return value;
};

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
    row.kind !== "native" ||
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

const candidateReceipt = async (
  candidate: Omit<TurnStateCandidate, "receipt">,
): Promise<string> =>
  await sha256Hex(
    JSON.stringify([
      TURN_STATE_SCHEMA_VERSION,
      candidate.operationId,
      candidate.requestFingerprint,
      candidate.historyCursor,
      candidate.workspace?.manifestId ?? null,
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
      "Turn state candidate receipt is invalid.",
      409,
      "turn_state_conflict",
    );
  }
};

const registryThreadKey = (workspaceHash: string, threadHash: string): string =>
  `turn-state:v1:thread:${workspaceHash}:${threadHash}`;
const registryObjectKey = (key: string): string =>
  `turn-state:v1:object:${key}`;
const archiveTarget = (
  _kind: TurnStateArchive["kind"],
  threadHash: string,
): TurnStateArchiveTarget => ({ kind: "native", threadHash });

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

  const threadKey = registryThreadKey(workspaceHash, threadHash);
  const operationKey = `turn-state:v1:operation:${args.operationId}`;
  const [thread, operation] = await Promise.all([
    storage.get<RegistryThreadRecord>(threadKey),
    storage.get<RegistryOperationRecord>(operationKey),
  ]);
  const threadMatches = thread?.candidates.filter(
    (value) => value.operationId === args.operationId,
  );
  const threadCandidate = threadMatches?.[0];
  if (
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
    operation.state !== "committed" ||
    operation.publicationReceipt !== undefined ||
    threadCandidate.requestFingerprint !== operation.requestFingerprint ||
    threadCandidate.createdAt !== operation.createdAt ||
    !sameJson(operation.nativeCheckpoint, threadCandidate.nativeCheckpoint) ||
    operation.receipt !== threadCandidate.receipt ||
    !sameJson(operation.objectKeys, {
      ...(threadCandidate.native ? { native: threadCandidate.native.key } : {}),
    }) ||
    operation.manifestId !== threadCandidate.workspace?.manifestId
  ) {
    throw new TurnStateOwnerRouteError(
      "Turn state unpublished candidate is no longer abortable.",
      409,
      "turn_state_abort_conflict",
    );
  }
  await assertCandidateReceipt(threadCandidate);

  const descriptors = [threadCandidate.native].filter(
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
    args.candidateHistoryCursor,
    args.canonicalHistoryCursor,
    objectKeys,
  ]);
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

const authorizePreparedOperation = async (
  storage: StrongTurnStateStorage,
  authorization: RouteOperationAuthorization,
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
    if (existing && !sameJson(existing, authorization)) {
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
          "requestFingerprint",
          "historyCursor",
          "createdAt",
        ],
        ["manifestId", "nativeCheckpoint", "nativeOnly"],
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
      const createdAt = requiredSafeInteger(row, "createdAt", 0);
      if (Object.hasOwn(row, "nativeOnly") && row.nativeOnly !== true) {
        throw new TurnStateOwnerRouteError(
          "nativeOnly is invalid.",
          400,
          "invalid_request",
        );
      }
      const nativeOnly = row.nativeOnly === true;
      // A native-only operation names no world; every other one names the
      // manifest it sealed.
      if (nativeOnly === Object.hasOwn(row, "manifestId")) {
        throw new TurnStateOwnerRouteError(
          "manifestId is invalid.",
          400,
          "invalid_request",
        );
      }
      const prepared = await withCurrentOpenLeaseTransaction(
        args,
        lease,
        async (transaction) => {
          const result = await prepareTurnStateOperation(transaction, {
            identity,
            requestFingerprint,
            historyCursor,
            ...(nativeOnly
              ? { nativeOnly: true as const }
              : { manifestId: requiredHex(row, "manifestId") }),
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
        archiveTarget(archive.kind, authorization.threadHash),
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
        ["threadOperationId"],
      );
      validateSchemaVersion(row);
      const lease = parseCommonLease(row);
      assertOpenLease(args.scopedOwnerId, args.fence, lease);
      const threadOperationId = Object.hasOwn(row, "threadOperationId")
        ? requiredHex(row, "threadOperationId")
        : undefined;
      if (!threadOperationId) {
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
            threadOperationId,
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

    if (args.path === "turn-state/purge-world") {
      const row = exactObject(raw, [...COMMON_LEASE_KEYS]);
      validateSchemaVersion(row);
      const lease = parseCommonLease(row);
      assertOpenWorldActivityLease(
        args.scopedOwnerId,
        args.fence,
        lease,
        routeNow(args.now),
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
