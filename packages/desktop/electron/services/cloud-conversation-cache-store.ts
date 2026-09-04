import { Buffer } from "node:buffer";
import {
  MAX_CLOUD_CONVERSATION_CACHE_CONVERSATIONS,
  MAX_CLOUD_CONVERSATION_CACHE_RECORD_BYTES,
  MAX_CLOUD_CONVERSATION_CACHE_RECORDS,
  MAX_CLOUD_CONVERSATION_CACHE_TOTAL_BYTES,
  type CloudConversationCacheAuthority,
  type CloudConversationCacheLifecycleAuthority,
  type CloudConversationCachePurgeResult,
  type CloudConversationCacheReplaceInput,
  type CloudConversationCacheReplaceResult,
  type CloudConversationCacheSnapshot,
  type CloudConversationCacheVersion,
} from "@stella/contracts/cloud-conversation-cache";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";

const AUTHORITY_FIELD_BYTES = 512;
const TITLE_BYTES = 4 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 50_000;

// Journal text may quote credential-shaped words, but structured secret fields
// must never cross the cache boundary. Normalize separators/case so common wire
// spellings (for example `access_token`) cannot bypass the same rule enforced
// at IPC ingress and again before SQLite writes/after SQLite reads.
const SECRET_BEARING_JSON_FIELDS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "authtoken",
  "bearertoken",
  "clientsecret",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "encryptionkey",
  "idtoken",
  "jwt",
  "passphrase",
  "password",
  "privatekey",
  "providertoken",
  "proxyauthorization",
  "refreshtoken",
  "secret",
  "sessionid",
  "sessiontoken",
  "setcookie",
  "signingkey",
  "token",
]);

const isSecretBearingJsonField = (key: string): boolean =>
  SECRET_BEARING_JSON_FIELDS.has(
    key
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ""),
  );

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
};

const boundedString = (
  value: unknown,
  name: string,
  maxBytes = AUTHORITY_FIELD_BYTES,
  allowEmpty = false,
): string => {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new TypeError(`${name} must be a string without NUL bytes.`);
  }
  if ((!allowEmpty && !value) || value.trim() !== value) {
    throw new TypeError(`${name} must be a non-empty canonical string.`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new RangeError(`${name} is too large.`);
  }
  return value;
};

const safeInteger = (value: unknown, name: string, minimum: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}.`);
  }
  return value as number;
};

const assertWindowBounds = (
  headSeq: number,
  floorSeq: number,
  name: string,
): void => {
  if (
    (headSeq === -1 && floorSeq !== 0) ||
    (headSeq >= 0 && floorSeq > headSeq)
  ) {
    throw new TypeError(`${name} has inconsistent head/floor bounds.`);
  }
};

const parseVersion = (
  value: unknown,
  name = "version",
): CloudConversationCacheVersion => {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["epoch", "headSeq", "floorSeq", "revision"])
  ) {
    throw new TypeError(`${name} has an invalid shape.`);
  }
  const headSeq = safeInteger(value.headSeq, `${name}.headSeq`, -1);
  const floorSeq = safeInteger(value.floorSeq, `${name}.floorSeq`, 0);
  assertWindowBounds(headSeq, floorSeq, name);
  return {
    epoch: safeInteger(value.epoch, `${name}.epoch`, 0),
    headSeq,
    floorSeq,
    revision: safeInteger(value.revision, `${name}.revision`, 1),
  };
};

const assertStrictJsonValue = (
  value: unknown,
  name: string,
  ancestors = new Set<object>(),
  state = { nodes: 0 },
  depth = 0,
): void => {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new RangeError(`${name} is too structurally complex.`);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${name} contains a non-finite number.`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${name} contains a non-JSON value.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${name} contains a cycle.`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const key of Object.keys(value)) {
        if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
          throw new TypeError(`${name} contains a non-JSON array property.`);
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(`${name} contains a sparse array.`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor || !("value" in descriptor)) {
          throw new TypeError(`${name} contains an accessor.`);
        }
        assertStrictJsonValue(
          descriptor.value,
          `${name}[${index}]`,
          ancestors,
          state,
          depth + 1,
        );
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${name} contains a non-plain object.`);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new TypeError(`${name} contains a symbol property.`);
      }
      if (isSecretBearingJsonField(key)) {
        throw new TypeError(`${name} contains a secret-bearing field.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError(`${name} contains a non-JSON property.`);
      }
      assertStrictJsonValue(
        descriptor.value,
        `${name}.${key}`,
        ancestors,
        state,
        depth + 1,
      );
    }
  } finally {
    ancestors.delete(value);
  }
};

export const parseCloudConversationCacheLifecycleAuthority = (
  value: unknown,
): CloudConversationCacheLifecycleAuthority => {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["accountScope", "ownerGeneration"])
  ) {
    throw new TypeError(
      "Cloud conversation cache authority has an invalid shape.",
    );
  }
  return {
    accountScope: boundedString(value.accountScope, "accountScope"),
    ownerGeneration: boundedString(value.ownerGeneration, "ownerGeneration"),
  };
};

export const parseCloudConversationCacheAccountScope = (
  value: unknown,
): string => {
  if (!isObject(value) || !hasOnlyKeys(value, ["accountScope"])) {
    throw new TypeError(
      "Cloud conversation cache account has an invalid shape.",
    );
  }
  return boundedString(value.accountScope, "accountScope");
};

export const parseCloudConversationCacheAuthority = (
  value: unknown,
): CloudConversationCacheAuthority => {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["accountScope", "ownerGeneration", "conversationId"])
  ) {
    throw new TypeError("Cloud conversation cache key has an invalid shape.");
  }
  return {
    accountScope: boundedString(value.accountScope, "accountScope"),
    ownerGeneration: boundedString(value.ownerGeneration, "ownerGeneration"),
    conversationId: boundedString(value.conversationId, "conversationId"),
  };
};

const validateJournalRecord = (
  value: unknown,
  index: number,
): { seq: number; json: string; bytes: number } => {
  if (!isObject(value)) {
    throw new TypeError(`records[${index}] must be an object.`);
  }
  const kind = value.kind;
  if (
    kind !== "message" &&
    kind !== "turn" &&
    kind !== "card" &&
    kind !== "skipped"
  ) {
    throw new TypeError(`records[${index}].kind is invalid.`);
  }
  const allowed =
    kind === "message"
      ? [
          "kind",
          "seq",
          "turnId",
          "createdAtMs",
          "role",
          "hidden",
          "clientMsgId",
          "payload",
        ]
      : kind === "turn"
        ? [
            "kind",
            "seq",
            "turnId",
            "createdAtMs",
            "phase",
            "lane",
            "source",
            "notice",
            "wallClockMs",
          ]
        : kind === "card"
          ? ["kind", "seq", "turnId", "createdAtMs", "card"]
          : ["kind", "seq", "turnId", "createdAtMs", "originalKind"];
  if (!hasOnlyKeys(value, allowed)) {
    throw new TypeError(`records[${index}] has unexpected fields.`);
  }
  const seq = safeInteger(value.seq, `records[${index}].seq`, 0);
  boundedString(
    value.turnId,
    `records[${index}].turnId`,
    AUTHORITY_FIELD_BYTES,
    kind === "skipped",
  );
  safeInteger(value.createdAtMs, `records[${index}].createdAtMs`, 0);
  if (kind === "message") {
    if (
      value.role !== "user" &&
      value.role !== "assistant" &&
      value.role !== "toolResult"
    ) {
      throw new TypeError(`records[${index}].role is invalid.`);
    }
    if (typeof value.hidden !== "boolean" || !isObject(value.payload)) {
      throw new TypeError(`records[${index}] has an invalid message payload.`);
    }
    if (value.clientMsgId !== undefined) {
      boundedString(value.clientMsgId, `records[${index}].clientMsgId`);
    }
  } else if (kind === "turn") {
    if (
      value.phase !== "started" &&
      value.phase !== "completed" &&
      value.phase !== "failed" &&
      value.phase !== "canceled" &&
      value.phase !== "timeout"
    ) {
      throw new TypeError(`records[${index}].phase is invalid.`);
    }
    for (const key of ["lane", "source", "notice"] as const) {
      if (value[key] !== undefined) {
        boundedString(value[key], `records[${index}].${key}`, 4 * 1024);
      }
    }
    if (
      value.wallClockMs !== undefined &&
      (!Number.isFinite(value.wallClockMs) || (value.wallClockMs as number) < 0)
    ) {
      throw new TypeError(`records[${index}].wallClockMs is invalid.`);
    }
  } else if (kind === "card") {
    if (!isObject(value.card) || typeof value.card.type !== "string") {
      throw new TypeError(`records[${index}].card is invalid.`);
    }
  } else if (value.originalKind !== undefined) {
    boundedString(value.originalKind, `records[${index}].originalKind`);
  }

  assertStrictJsonValue(value, `records[${index}]`);

  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new TypeError(`records[${index}] is not JSON serializable.`);
  }
  if (!json) {
    throw new TypeError(`records[${index}] is not JSON serializable.`);
  }
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_CLOUD_CONVERSATION_CACHE_RECORD_BYTES) {
    throw new RangeError(`records[${index}] is too large.`);
  }
  return { seq, json, bytes };
};

export type ParsedCloudConversationCacheReplace =
  CloudConversationCacheReplaceInput & {
    serializedRecords: Array<{ seq: number; json: string; bytes: number }>;
  };

export const parseCloudConversationCacheReplaceInput = (
  value: unknown,
): ParsedCloudConversationCacheReplace => {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, [
      "accountScope",
      "ownerGeneration",
      "conversationId",
      "expected",
      "epoch",
      "headSeq",
      "floorSeq",
      "title",
      "records",
      "retainedRange",
    ])
  ) {
    throw new TypeError(
      "Cloud conversation cache replacement has an invalid shape.",
    );
  }
  const authority = parseCloudConversationCacheAuthority({
    accountScope: value.accountScope,
    ownerGeneration: value.ownerGeneration,
    conversationId: value.conversationId,
  });
  const epoch = safeInteger(value.epoch, "epoch", 0);
  const headSeq = safeInteger(value.headSeq, "headSeq", -1);
  const floorSeq = safeInteger(value.floorSeq, "floorSeq", 0);
  assertWindowBounds(headSeq, floorSeq, "replacement");
  const title = boundedString(value.title, "title", TITLE_BYTES, true);
  if (!Array.isArray(value.records)) {
    throw new TypeError("records must be an array.");
  }
  if (value.records.length > MAX_CLOUD_CONVERSATION_CACHE_RECORDS) {
    throw new RangeError("Cloud conversation cache has too many records.");
  }
  const expected =
    value.expected === null ? null : parseVersion(value.expected, "expected");
  let retainedRange: { fromSeq: number; toSeq: number } | undefined;
  if (value.retainedRange !== undefined) {
    if (
      !isObject(value.retainedRange) ||
      !hasOnlyKeys(value.retainedRange, ["fromSeq", "toSeq"])
    ) {
      throw new TypeError("Invalid retained cache range.");
    }
    const fromSeq = safeInteger(
      value.retainedRange.fromSeq,
      "retainedRange.fromSeq",
      0,
    );
    const toSeq = safeInteger(
      value.retainedRange.toSeq,
      "retainedRange.toSeq",
      fromSeq,
    );
    if (
      !expected ||
      expected.epoch !== epoch ||
      fromSeq < floorSeq ||
      toSeq > expected.headSeq
    ) {
      throw new TypeError(
        "Retained cache range must belong to the expected epoch/window.",
      );
    }
    retainedRange = { fromSeq, toSeq };
  }
  const retainedCount = retainedRange
    ? retainedRange.toSeq - retainedRange.fromSeq + 1
    : 0;
  if (
    value.records.length + retainedCount >
    MAX_CLOUD_CONVERSATION_CACHE_RECORDS
  ) {
    throw new RangeError("Cloud conversation cache has too many records.");
  }
  const serializedRecords = value.records.map(validateJournalRecord);
  let totalBytes = Buffer.byteLength(title, "utf8");
  const first = Math.min(
    serializedRecords[0]?.seq ?? Infinity,
    retainedRange?.fromSeq ?? Infinity,
  );
  let nextSeq = first;
  for (const record of serializedRecords) {
    if (retainedRange && nextSeq === retainedRange.fromSeq)
      nextSeq = retainedRange.toSeq + 1;
    if (record.seq !== nextSeq)
      throw new TypeError("Cloud conversation cache records must be gapless.");
    nextSeq += 1;
    totalBytes += record.bytes;
  }
  if (retainedRange && nextSeq === retainedRange.fromSeq)
    nextSeq = retainedRange.toSeq + 1;
  if (totalBytes > MAX_CLOUD_CONVERSATION_CACHE_TOTAL_BYTES) {
    throw new RangeError("Cloud conversation cache window is too large.");
  }
  if (serializedRecords.length + retainedCount === 0) {
    if (headSeq !== -1)
      throw new TypeError("A non-empty cloud journal head requires records.");
  } else if (first < floorSeq || nextSeq - 1 !== headSeq) {
    throw new TypeError(
      "Cloud conversation cache records must be a canonical suffix ending at headSeq.",
    );
  }
  return {
    ...authority,
    expected,
    ...(retainedRange ? { retainedRange } : {}),
    epoch,
    headSeq,
    floorSeq,
    title,
    records: value.records,
    serializedRecords,
  };
};

type CacheMetaRow = {
  account_scope: string;
  owner_generation: string;
  conversation_id: string;
  epoch: number;
  head_seq: number;
  floor_seq: number;
  revision: number;
  title: string;
  cached_at_ms: number;
  record_count: number;
};

const parseMetaRow = (
  value: unknown,
  expectedAuthority: CloudConversationCacheAuthority,
): CacheMetaRow => {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, [
      "account_scope",
      "owner_generation",
      "conversation_id",
      "epoch",
      "head_seq",
      "floor_seq",
      "revision",
      "title",
      "cached_at_ms",
      "record_count",
    ])
  ) {
    throw new TypeError("Stored cloud cache metadata has an invalid shape.");
  }
  const authority = parseCloudConversationCacheAuthority({
    accountScope: value.account_scope,
    ownerGeneration: value.owner_generation,
    conversationId: value.conversation_id,
  });
  if (
    authority.accountScope !== expectedAuthority.accountScope ||
    authority.ownerGeneration !== expectedAuthority.ownerGeneration ||
    authority.conversationId !== expectedAuthority.conversationId
  ) {
    throw new TypeError(
      "Stored cloud cache metadata crossed its authority fence.",
    );
  }
  const epoch = safeInteger(value.epoch, "stored epoch", 0);
  const headSeq = safeInteger(value.head_seq, "stored headSeq", -1);
  const floorSeq = safeInteger(value.floor_seq, "stored floorSeq", 0);
  assertWindowBounds(headSeq, floorSeq, "stored metadata");
  const recordCount = safeInteger(value.record_count, "stored recordCount", 0);
  if (
    recordCount > MAX_CLOUD_CONVERSATION_CACHE_RECORDS ||
    (recordCount === 0) !== (headSeq === -1) ||
    (recordCount > 0 && floorSeq > headSeq)
  ) {
    throw new TypeError(
      "Stored cloud cache metadata is internally inconsistent.",
    );
  }
  return {
    account_scope: authority.accountScope,
    owner_generation: authority.ownerGeneration,
    conversation_id: authority.conversationId,
    epoch,
    head_seq: headSeq,
    floor_seq: floorSeq,
    revision: safeInteger(value.revision, "stored revision", 1),
    title: boundedString(value.title, "stored title", TITLE_BYTES, true),
    cached_at_ms: safeInteger(value.cached_at_ms, "stored cachedAtMs", 0),
    record_count: recordCount,
  };
};

const versionOf = (row: CacheMetaRow): CloudConversationCacheVersion => ({
  epoch: row.epoch,
  headSeq: row.head_seq,
  floorSeq: row.floor_seq,
  revision: row.revision,
});

const versionsEqual = (
  left: CloudConversationCacheVersion | null,
  right: CloudConversationCacheVersion | null,
): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.epoch === right.epoch &&
    left.headSeq === right.headSeq &&
    left.floorSeq === right.floorSeq &&
    left.revision === right.revision);

/**
 * Separate, bounded SQLite cache for raw canonical cloud-journal records.
 * Nothing in the runtime imports this class; it is reachable only through the
 * privileged desktop IPC bridge.
 */
export class CloudConversationCacheStore {
  private activeAccountScope: string | null = null;
  private activeOwnerGeneration: string | null = null;

  constructor(private readonly db: SqliteDatabase) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cloud_conversation_cache_meta (
        account_scope TEXT NOT NULL,
        owner_generation TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        head_seq INTEGER NOT NULL,
        floor_seq INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        title TEXT NOT NULL,
        cached_at_ms INTEGER NOT NULL,
        record_count INTEGER NOT NULL,
        PRIMARY KEY (account_scope, owner_generation, conversation_id)
      );
      CREATE TABLE IF NOT EXISTS cloud_conversation_cache_records (
        account_scope TEXT NOT NULL,
        owner_generation TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        record_bytes INTEGER NOT NULL,
        PRIMARY KEY (account_scope, owner_generation, conversation_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_conversation_cache_recency
        ON cloud_conversation_cache_meta(cached_at_ms DESC);
    `);
  }

  retainAccountScope(value: unknown): CloudConversationCachePurgeResult {
    const accountScope = parseCloudConversationCacheAccountScope(value);
    const purgedConversations = this.withImmediateTransaction(() => {
      const count = this.countMetaWhere("account_scope != ?", [accountScope]);
      this.deleteWhere("account_scope != ?", [accountScope]);
      return count;
    });
    this.activeAccountScope = accountScope;
    this.activeOwnerGeneration = null;
    return { purgedConversations };
  }

  activateAuthority(value: unknown): CloudConversationCachePurgeResult {
    const authority = parseCloudConversationCacheLifecycleAuthority(value);
    const purgedConversations = this.withImmediateTransaction(() => {
      const predicate = "account_scope != ? OR owner_generation != ?";
      const params = [authority.accountScope, authority.ownerGeneration];
      const count = this.countMetaWhere(predicate, params);
      this.deleteWhere(predicate, params);
      return count;
    });
    this.activeAccountScope = authority.accountScope;
    this.activeOwnerGeneration = authority.ownerGeneration;
    return { purgedConversations };
  }

  getActiveAuthority(): CloudConversationCacheLifecycleAuthority | null {
    return this.activeAccountScope && this.activeOwnerGeneration
      ? {
          accountScope: this.activeAccountScope,
          ownerGeneration: this.activeOwnerGeneration,
        }
      : null;
  }

  read(value: unknown): CloudConversationCacheSnapshot | null {
    const authority = parseCloudConversationCacheAuthority(value);
    if (!this.isActive(authority)) return null;
    try {
      const row = this.readMeta(authority);
      if (!row) return null;
      const recordRows = this.db
        .prepare(
          `SELECT seq, record_json, record_bytes
           FROM cloud_conversation_cache_records
           WHERE account_scope = ?
             AND owner_generation = ?
             AND conversation_id = ?
             AND epoch = ?
           ORDER BY seq ASC`,
        )
        .all(
          authority.accountScope,
          authority.ownerGeneration,
          authority.conversationId,
          row.epoch,
        ) as Array<{
        seq?: unknown;
        record_json?: unknown;
        record_bytes?: unknown;
      }>;
      const records = recordRows.map((record, index) => {
        if (typeof record.record_json !== "string") {
          throw new TypeError(`Stored record ${index} is not text.`);
        }
        const storedSeq = safeInteger(
          record.seq,
          `stored record ${index} seq`,
          0,
        );
        const storedBytes = safeInteger(
          record.record_bytes,
          `stored record ${index} bytes`,
          0,
        );
        if (Buffer.byteLength(record.record_json, "utf8") !== storedBytes) {
          throw new TypeError(`Stored record ${index} byte count is invalid.`);
        }
        const decoded = JSON.parse(record.record_json) as unknown;
        if (!isObject(decoded) || decoded.seq !== storedSeq) {
          throw new TypeError(`Stored record ${index} sequence is invalid.`);
        }
        return decoded;
      });
      if (records.length !== row.record_count) {
        throw new TypeError(
          "Stored cloud cache record count does not match metadata.",
        );
      }
      const validated = parseCloudConversationCacheReplaceInput({
        ...authority,
        expected: null,
        epoch: row.epoch,
        headSeq: row.head_seq,
        floorSeq: row.floor_seq,
        title: row.title,
        records,
      });
      return {
        ...authority,
        ...versionOf(row),
        title: validated.title,
        cachedAtMs: row.cached_at_ms,
        records: validated.records,
      };
    } catch {
      // A partial/corrupt derived cache is disposable. Delete it and let the
      // canonical DO rebuild the view instead of surfacing a silent hole.
      this.withImmediateTransaction(() => this.deleteExact(authority));
      return null;
    }
  }

  replace(value: unknown): CloudConversationCacheReplaceResult {
    // Validate at the storage boundary, including direct service/test callers.
    // Worker dispatch keeps this traversal and all SQLite work off main.
    const input = parseCloudConversationCacheReplaceInput(value);
    if (!this.isActive(input)) return { status: "inactive", current: null };
    return this.withImmediateTransaction(() => {
      let currentRow: CacheMetaRow | null;
      try {
        currentRow = this.readMeta(input);
      } catch {
        // Corrupt derived state is equivalent to cache loss. Delete the exact
        // authority window and force callers through the normal null-CAS path.
        this.deleteExact(input);
        currentRow = null;
      }
      const current = currentRow ? versionOf(currentRow) : null;
      if (!versionsEqual(current, input.expected)) {
        return { status: "conflict", current } as const;
      }
      if (
        current &&
        current.epoch === input.epoch &&
        (input.headSeq < current.headSeq || input.floorSeq < current.floorSeq)
      ) {
        return { status: "conflict", current } as const;
      }

      const revision = (current?.revision ?? 0) + 1;
      let retainedCount = 0;
      if (input.retainedRange) {
        const { fromSeq, toSeq } = input.retainedRange;
        const retained = this.db
          .prepare(
            `SELECT COUNT(*) AS count, COALESCE(SUM(record_bytes), 0) AS bytes,
            MIN(record_bytes) AS minBytes, MAX(record_bytes) AS maxBytes
          FROM cloud_conversation_cache_records
          WHERE account_scope = ? AND owner_generation = ? AND conversation_id = ?
            AND epoch = ? AND seq BETWEEN ? AND ?`,
          )
          .get(
            input.accountScope,
            input.ownerGeneration,
            input.conversationId,
            input.epoch,
            fromSeq,
            toSeq,
          ) as {
          count: number;
          bytes: number;
          minBytes: number;
          maxBytes: number;
        };
        retainedCount = toSeq - fromSeq + 1;
        if (
          retained.count !== retainedCount ||
          retained.minBytes < 0 ||
          retained.maxBytes > MAX_CLOUD_CONVERSATION_CACHE_RECORD_BYTES
        ) {
          this.deleteExact(input);
          return { status: "conflict", current: null } as const;
        }
        const totalBytes =
          retained.bytes +
          Buffer.byteLength(input.title, "utf8") +
          input.serializedRecords.reduce(
            (sum, record) => sum + record.bytes,
            0,
          );
        if (
          !Number.isSafeInteger(totalBytes) ||
          totalBytes > MAX_CLOUD_CONVERSATION_CACHE_TOTAL_BYTES
        ) {
          throw new RangeError("Cloud conversation cache window is too large.");
        }
        this.db
          .prepare(
            `DELETE FROM cloud_conversation_cache_records
          WHERE account_scope = ? AND owner_generation = ? AND conversation_id = ?
            AND (epoch != ? OR seq < ? OR seq > ?)`,
          )
          .run(
            input.accountScope,
            input.ownerGeneration,
            input.conversationId,
            input.epoch,
            fromSeq,
            toSeq,
          );
      } else {
        this.deleteExact(input);
      }
      const insert = this.db.prepare(
        `INSERT INTO cloud_conversation_cache_records (
           account_scope, owner_generation, conversation_id, epoch,
           seq, record_json, record_bytes
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const record of input.serializedRecords) {
        insert.run(
          input.accountScope,
          input.ownerGeneration,
          input.conversationId,
          input.epoch,
          record.seq,
          record.json,
          record.bytes,
        );
      }
      this.db
        .prepare(
          `INSERT INTO cloud_conversation_cache_meta (
             account_scope, owner_generation, conversation_id, epoch,
             head_seq, floor_seq, revision, title, cached_at_ms, record_count
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_scope, owner_generation, conversation_id) DO UPDATE SET
             epoch = excluded.epoch, head_seq = excluded.head_seq, floor_seq = excluded.floor_seq,
             revision = excluded.revision, title = excluded.title, cached_at_ms = excluded.cached_at_ms,
             record_count = excluded.record_count`,
        )
        .run(
          input.accountScope,
          input.ownerGeneration,
          input.conversationId,
          input.epoch,
          input.headSeq,
          input.floorSeq,
          revision,
          input.title,
          Date.now(),
          input.serializedRecords.length + retainedCount,
        );
      this.pruneLeastRecent();
      return {
        status: "applied",
        version: {
          epoch: input.epoch,
          headSeq: input.headSeq,
          floorSeq: input.floorSeq,
          revision,
        },
      } as const;
    });
  }

  purgeConversation(value: unknown): CloudConversationCachePurgeResult {
    const authority = parseCloudConversationCacheAuthority(value);
    if (!this.isActive(authority)) return { purgedConversations: 0 };
    const purgedConversations = this.withImmediateTransaction(() => {
      const present = this.countMetaWhere(
        "account_scope = ? AND owner_generation = ? AND conversation_id = ?",
        [
          authority.accountScope,
          authority.ownerGeneration,
          authority.conversationId,
        ],
      );
      this.deleteExact(authority);
      return present;
    });
    return { purgedConversations };
  }

  private isActive(
    authority: CloudConversationCacheLifecycleAuthority,
  ): boolean {
    return (
      authority.accountScope === this.activeAccountScope &&
      authority.ownerGeneration === this.activeOwnerGeneration
    );
  }

  private readMeta(
    authority: CloudConversationCacheAuthority,
  ): CacheMetaRow | null {
    const row = this.db
      .prepare(
        `SELECT account_scope, owner_generation, conversation_id, epoch,
                head_seq, floor_seq, revision, title, cached_at_ms, record_count
         FROM cloud_conversation_cache_meta
         WHERE account_scope = ?
           AND owner_generation = ?
           AND conversation_id = ?`,
      )
      .get(
        authority.accountScope,
        authority.ownerGeneration,
        authority.conversationId,
      );
    return row === undefined ? null : parseMetaRow(row, authority);
  }

  private deleteExact(authority: CloudConversationCacheAuthority): void {
    const params = [
      authority.accountScope,
      authority.ownerGeneration,
      authority.conversationId,
    ];
    this.db
      .prepare(
        `DELETE FROM cloud_conversation_cache_records
         WHERE account_scope = ? AND owner_generation = ? AND conversation_id = ?`,
      )
      .run(...params);
    this.db
      .prepare(
        `DELETE FROM cloud_conversation_cache_meta
         WHERE account_scope = ? AND owner_generation = ? AND conversation_id = ?`,
      )
      .run(...params);
  }

  private countMetaWhere(predicate: string, params: unknown[]): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM cloud_conversation_cache_meta WHERE ${predicate}`,
      )
      .get(...params) as { count?: unknown } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
  }

  private deleteWhere(predicate: string, params: unknown[]): void {
    this.db
      .prepare(
        `DELETE FROM cloud_conversation_cache_records WHERE ${predicate}`,
      )
      .run(...params);
    this.db
      .prepare(`DELETE FROM cloud_conversation_cache_meta WHERE ${predicate}`)
      .run(...params);
  }

  private pruneLeastRecent(): void {
    const stale = this.db
      .prepare(
        `SELECT account_scope, owner_generation, conversation_id
         FROM cloud_conversation_cache_meta
         ORDER BY cached_at_ms DESC, conversation_id DESC
         LIMIT -1 OFFSET ?`,
      )
      .all(MAX_CLOUD_CONVERSATION_CACHE_CONVERSATIONS) as Array<
      Pick<
        CacheMetaRow,
        "account_scope" | "owner_generation" | "conversation_id"
      >
    >;
    for (const row of stale) {
      this.deleteExact({
        accountScope: row.account_scope,
        ownerGeneration: row.owner_generation,
        conversationId: row.conversation_id,
      });
    }
  }

  private withImmediateTransaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = work();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // BEGIN/connection failure: preserve the original error.
      }
      throw error;
    }
  }
}
