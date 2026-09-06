import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ChatMessage, MobileTask } from "../types";
import type { ToolStep } from "./tool-activity";
import {
  desktopChatOutboxStorageKeys,
  waitForDesktopChatOutboxWrites,
} from "./desktop-chat-outbox";
import {
  finalizeAccountChatCleanup,
  loadAccountChatCleanupIntent,
  loadAccountChatCleanupProgress,
  markAccountCanonicalChatCleared,
  markAccountChatIndexCleared,
} from "./chat-account-cleanup-state";
import {
  accountChatMetadataReadsBlocked,
  beginAccountChatMetadataCleanup,
  finishAccountChatMetadataCleanup,
  waitForAccountChatMetadataWrites,
} from "./chat-account-metadata-queue";
import { parseChatArtifacts } from "./mobile-artifacts";
import {
  diffTranscriptSnapshot,
  type TranscriptSnapshotRow,
} from "./transcript-snapshot";
import {
  clearAsyncTranscriptRows,
  findAsyncTranscriptCursor,
  loadNewerAsyncTranscriptRows,
  loadOldestAsyncTranscriptRows,
  loadOlderAsyncTranscriptRows,
  loadRecentAsyncTranscriptRows,
  saveAsyncTranscriptRows,
  synchronizeAsyncTranscriptRows,
  type AsyncTranscriptPage,
} from "./async-transcript-fallback";

/**
 * The local stores behind the one cloud conversation. Both threads read and
 * write the SAME conversation; they are separate only so the two surfaces that
 * can be mounted at once never drain one another's queue. `cloud` is the chat
 * surface (and keeps its original key, from when it was the cloud-only store).
 * `carplay` is the hands-free voice loop driven from a head unit.
 */
export type ChatThreadId = "cloud" | "carplay";
const CHAT_THREAD_IDS: ChatThreadId[] = ["cloud", "carplay"];

const MESSAGES_KEY: Record<ChatThreadId, string> = {
  cloud: "stella-mobile-offline-chat-v1",
  carplay: "stella-mobile-carplay-chat-v1",
};
const SYNC_STATE_KEY: Record<ChatThreadId, string> = {
  cloud: "stella-mobile-chat-sync-state-v1",
  carplay: "stella-mobile-carplay-sync-state-v1",
};

const TRANSCRIPT_DB_NAME = "stella-mobile-transcripts.db";
const TRANSCRIPT_CLEANUP_REQUIRED_KEY =
  "stella-mobile-transcript-cleanup-required-v1";
const TRANSCRIPT_SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS mobile_chat_messages (
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  order_key INTEGER NOT NULL,
  canonical_id TEXT,
  canonical_created_at INTEGER,
  sequence INTEGER,
  payload_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, message_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS mobile_chat_messages_order
  ON mobile_chat_messages(thread_id, order_key, message_id);
CREATE INDEX IF NOT EXISTS mobile_chat_messages_canonical
  ON mobile_chat_messages(thread_id, canonical_id);
CREATE INDEX IF NOT EXISTS mobile_chat_messages_sequence
  ON mobile_chat_messages(thread_id, sequence);

CREATE TABLE IF NOT EXISTS mobile_chat_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
`;

/**
 * Initial hydration is deliberately small. Durable history lives in SQLite;
 * React/Hermes owns only a sliding window and asks for adjacent pages as the
 * user scrolls.
 */
export const CHAT_TRANSCRIPT_INITIAL_LIMIT = 160;
export const CHAT_TRANSCRIPT_PAGE_LIMIT = 80;
export const CHAT_TRANSCRIPT_MAX_LOADED = 480;
const ORDER_STRIDE = 1_000_000;

export type ChatTranscriptCursor = {
  orderKey: number;
  id: string;
};

export type ChatTranscriptPage = {
  messages: ChatMessage[];
  oldestCursor: ChatTranscriptCursor | null;
  newestCursor: ChatTranscriptCursor | null;
  hasOlder: boolean;
  hasNewer: boolean;
};

type SQLiteResult = { changes: number; lastInsertRowId: number };
type SQLiteDatabase = {
  execAsync: (sql: string) => Promise<void>;
  runAsync: (sql: string, ...params: unknown[]) => Promise<SQLiteResult>;
  getFirstAsync: <T>(sql: string, ...params: unknown[]) => Promise<T | null>;
  getAllAsync: <T>(sql: string, ...params: unknown[]) => Promise<T[]>;
  withTransactionAsync: (task: () => Promise<void>) => Promise<void>;
};

type StoredMessageRow = {
  message_id: string;
  order_key: number;
  payload_json: string;
};

let transcriptDbPromise: Promise<SQLiteDatabase | null> | null = null;
let transcriptWriteQueue: Promise<unknown> = Promise.resolve();
const orderKeysByThread = new Map<ChatThreadId, Map<string, number>>();
const serializedByThread = new Map<ChatThreadId, Map<string, string>>();
const transcriptGenerationByThread = new Map<ChatThreadId, number>();
const canonicalSnapshotByThread = new Map<
  ChatThreadId,
  TranscriptSnapshotRow[]
>();
const canonicalSnapshotRevisionByThread = new Map<ChatThreadId, number>();
const invalidateCanonicalSnapshot = (thread: ChatThreadId): void => {
  canonicalSnapshotByThread.delete(thread);
  canonicalSnapshotRevisionByThread.set(
    thread,
    (canonicalSnapshotRevisionByThread.get(thread) ?? 0) + 1,
  );
};
let transcriptCleanupInProgress = false;
let transcriptCleanupRecoveryRequired = false;
let transcriptCleanupMarkerCheck: Promise<boolean> | null = null;
let transcriptCleanupRecovery: Promise<void> | null = null;
const transcriptCleanupListeners = new Set<() => void>();

/** Notify mounted transcript owners before account data is wiped. */
export function subscribeChatStorageCleanup(listener: () => void): () => void {
  transcriptCleanupListeners.add(listener);
  return () => transcriptCleanupListeners.delete(listener);
}

/** Synchronously detach mounted producers once durable account intent exists. */
export function invalidateChatStorageForAccountCleanup(): void {
  beginAccountChatMetadataCleanup();
  for (const listener of transcriptCleanupListeners) {
    try {
      listener();
    } catch {
      // Every mounted surface is independent; one bad listener must not leave
      // another surface writing the departing account back into storage.
    }
  }
  for (const thread of CHAT_THREAD_IDS) invalidateTranscriptWrites(thread);
  orderKeysByThread.clear();
  serializedByThread.clear();
  fallbackMigrations.clear();
}
const TRANSCRIPT_CACHE_MAX_ROWS = CHAT_TRANSCRIPT_MAX_LOADED * 2;

const transcriptGeneration = (thread: ChatThreadId): number =>
  transcriptGenerationByThread.get(thread) ?? 0;

const invalidateTranscriptWrites = (thread: ChatThreadId): void => {
  invalidateCanonicalSnapshot(thread);
  transcriptGenerationByThread.set(thread, transcriptGeneration(thread) + 1);
};

const touchCacheValue = <T>(
  map: Map<string, T>,
  id: string,
  value: T,
): void => {
  map.delete(id);
  map.set(id, value);
};

const trimCache = <T>(map: Map<string, T>): void => {
  while (map.size > TRANSCRIPT_CACHE_MAX_ROWS) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
};

const trimThreadCaches = (thread: ChatThreadId): void => {
  const orderKeys = orderKeysByThread.get(thread);
  const serialized = serializedByThread.get(thread);
  if (orderKeys) trimCache(orderKeys);
  if (serialized) trimCache(serialized);
};

const emptyPage = (): ChatTranscriptPage => ({
  messages: [],
  oldestCursor: null,
  newestCursor: null,
  hasOlder: false,
  hasNewer: false,
});

const enqueueTranscriptWrite = <T>(work: () => Promise<T>): Promise<T> => {
  const run = transcriptWriteQueue.then(work, work);
  transcriptWriteQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

const allAccountChatStorageKeys = (): string[] => [
  ...Object.values(MESSAGES_KEY),
  ...Object.values(SYNC_STATE_KEY),
  ...desktopChatOutboxStorageKeys(),
];

async function cleanupRequired(): Promise<boolean> {
  if (transcriptCleanupRecoveryRequired) return true;
  transcriptCleanupMarkerCheck ??= AsyncStorage.getItem(
    TRANSCRIPT_CLEANUP_REQUIRED_KEY,
  )
    .then((value) => value === "1")
    .catch((error) => {
      // A storage read failure cannot be interpreted as "no cleanup intent":
      // doing so could expose the prior account's rows. Leave the check
      // retryable and fail closed until AsyncStorage is readable again.
      transcriptCleanupMarkerCheck = null;
      throw error;
    });
  return transcriptCleanupMarkerCheck;
}

async function recoverInterruptedCleanup(
  db: SQLiteDatabase | null,
): Promise<void> {
  if (!(await cleanupRequired())) return;
  if (transcriptCleanupRecovery) return transcriptCleanupRecovery;
  transcriptCleanupRecovery = (async () => {
    await waitForDesktopChatOutboxWrites().catch(() => {});
    if (db) {
      await enqueueTranscriptWrite(() =>
        db.withTransactionAsync(async () => {
          await db.execAsync(
            "DELETE FROM mobile_chat_messages; DELETE FROM mobile_chat_meta;",
          );
        }),
      );
    } else {
      await enqueueTranscriptWrite(async () => {});
    }
    await Promise.all(
      CHAT_THREAD_IDS.map((thread) => clearAsyncTranscriptRows(thread)),
    );
    await AsyncStorage.multiRemove(allAccountChatStorageKeys());
    await AsyncStorage.removeItem(TRANSCRIPT_CLEANUP_REQUIRED_KEY);
    orderKeysByThread.clear();
    serializedByThread.clear();
    transcriptCleanupRecoveryRequired = false;
    transcriptCleanupMarkerCheck = Promise.resolve(false);
  })();
  try {
    await transcriptCleanupRecovery;
  } finally {
    transcriptCleanupRecovery = null;
  }
}

let accountCleanupRecovery: Promise<void> | null = null;

async function recoverInterruptedAccountCleanup(): Promise<void> {
  const token = await loadAccountChatCleanupIntent();
  if (!token) return;
  if (accountCleanupRecovery) return accountCleanupRecovery;
  accountCleanupRecovery = (async () => {
    const progress = await loadAccountChatCleanupProgress(token);
    const messageIndex = await import("./chat-message-index");
    if (!progress.canonicalCleared) {
      invalidateChatStorageForAccountCleanup();
      // Account intent may have been the final write before a process kill.
      // Establish the independent index block before canonical deletion so a
      // stale FTS database can never become the only surviving account copy.
      await messageIndex.ensureMessageIndexRebuildIntent();
      // `clearAllChatStorage` raises its own canonical marker before deleting
      // anything. Its in-progress latch prevents this recovery call from
      // recursively entering through getTranscriptDb().
      await clearAllChatStorage();
      await markAccountCanonicalChatCleared(token);
    }
    const latestProgress = await loadAccountChatCleanupProgress(token);
    if (!latestProgress.indexCleared) {
      // Recovery may begin at the transcript entry point before the recall
      // subsystem mounts. Finish the independently durable index deletion here
      // rather than leaving the account-wide owner pending indefinitely.
      await messageIndex.clearMessageIndex();
      await markAccountChatIndexCleared(token);
    }
    if (!(await finalizeAccountChatCleanup(token))) {
      // A concurrent index recovery may already have finalized this token.
      if ((await loadAccountChatCleanupIntent()) === token) {
        throw new Error("Local chat account cleanup did not finalize");
      }
    }
  })();
  try {
    await accountCleanupRecovery;
  } finally {
    accountCleanupRecovery = null;
  }
}

async function openTranscriptDb(): Promise<SQLiteDatabase | null> {
  let SQLite: typeof import("expo-sqlite");
  try {
    // Dynamic import keeps Bun's non-native unit-test runtime on the explicit
    // AsyncStorage fallback while native iOS/Android builds use expo-sqlite.
    SQLite = await import("expo-sqlite");
  } catch {
    return null;
  }
  try {
    const db = (await SQLite.openDatabaseAsync(
      TRANSCRIPT_DB_NAME,
    )) as unknown as SQLiteDatabase;
    await db.execAsync(TRANSCRIPT_SCHEMA);
    return db;
  } catch (error) {
    if ("Bun" in globalThis) return null;
    throw error;
  }
}

const getTranscriptDb = async () => {
  // Cross-store ownership must be recovered before any canonical store is
  // opened or served. Recovery's own clearAllChatStorage() call raises the
  // in-progress latch before recursively opening the DB, so this does not
  // recurse.
  if (!transcriptCleanupInProgress) {
    await recoverInterruptedAccountCleanup();
  }
  if (!transcriptDbPromise) {
    transcriptDbPromise = openTranscriptDb().catch((error) => {
      transcriptDbPromise = null;
      throw error;
    });
  }
  const db = await transcriptDbPromise;
  if (!transcriptCleanupInProgress) {
    await recoverInterruptedCleanup(db);
  }
  return db;
};

export type ChatSyncState = {
  conversationId: string | null;
  cursor: string | null;
};

const TASK_STATUSES = new Set(["running", "completed", "error", "canceled"]);

/**
 * A persisted `running` snapshot older than this loads as settled, mirroring
 * the desktop projection's stale-settle (`AGENT_WORK_STALE_MS`) so a task
 * that finished while the app was closed can't shimmer the pill forever.
 */
const STORED_RUNNING_TASK_STALE_MS = 5 * 60_000;

function parseStoredToolSteps(value: unknown): ToolStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ToolStep[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.toolName !== "string" ||
      (record.status !== "running" &&
        record.status !== "completed" &&
        record.status !== "error" &&
        record.status !== "canceled")
    ) {
      return [];
    }
    const args =
      record.args && typeof record.args === "object"
        ? Object.fromEntries(
            Object.entries(record.args as Record<string, unknown>).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          )
        : undefined;
    return [
      {
        id: record.id,
        toolName: record.toolName,
        status: record.status,
        ...(args && Object.keys(args).length > 0 ? { args } : {}),
        ...(typeof record.textOffset === "number" &&
        Number.isFinite(record.textOffset)
          ? { textOffset: record.textOffset }
          : {}),
      },
    ];
  });
}

/**
 * Round-trip the background-task snapshots riding a persisted row. Tasks feed
 * the activity pill/tray via `collectConversationTasks`; dropping them on load
 * (the pre-fix behavior) killed the pill on every app relaunch — the sync
 * cursor is already past the spawning rows, so a cursor delta only re-delivers
 * them when the agent happens to emit another lifecycle event.
 */
function parseStoredTasks(value: unknown): MobileTask[] {
  if (!Array.isArray(value)) return [];
  const tasks: MobileTask[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const status = record.status;
    if (
      !id ||
      !title ||
      typeof status !== "string" ||
      !TASK_STATUSES.has(status)
    ) {
      continue;
    }
    const statusText =
      typeof record.statusText === "string" ? record.statusText.trim() : "";
    const agentType =
      typeof record.agentType === "string" ? record.agentType.trim() : "";
    const parentAgentId =
      typeof record.parentAgentId === "string"
        ? record.parentAgentId.trim()
        : "";
    const reasoningSummaries = Array.isArray(record.reasoningSummaries)
      ? record.reasoningSummaries.filter(
          (summary): summary is string =>
            typeof summary === "string" && summary.trim().length > 0,
        )
      : [];
    const createdAt =
      typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
        ? record.createdAt
        : 0;
    const completedAt =
      typeof record.completedAt === "number" &&
      Number.isFinite(record.completedAt)
        ? record.completedAt
        : undefined;
    const updatedAt =
      typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
        ? record.updatedAt
        : undefined;
    const resultText =
      typeof record.resultText === "string" ? record.resultText.trim() : "";
    const errorMessage =
      typeof record.errorMessage === "string" ? record.errorMessage.trim() : "";
    const settledStale =
      status === "running" &&
      Date.now() - createdAt > STORED_RUNNING_TASK_STALE_MS;
    tasks.push({
      id,
      title,
      ...(agentType ? { agentType } : {}),
      ...(parentAgentId ? { parentAgentId } : {}),
      status: settledStale ? "completed" : (status as MobileTask["status"]),
      ...(statusText && !settledStale ? { statusText } : {}),
      ...(reasoningSummaries.length > 0 ? { reasoningSummaries } : {}),
      createdAt,
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(resultText ? { resultText } : {}),
      ...(errorMessage ? { errorMessage } : {}),
      ...(completedAt !== undefined ? { completedAt } : {}),
    });
  }
  return tasks;
}

function parseRow(row: unknown): ChatMessage | null {
  if (!row || typeof row !== "object") {
    return null;
  }
  const o = row as Record<string, unknown>;
  if (typeof o.id !== "string") {
    return null;
  }
  if (o.role !== "user" && o.role !== "assistant") {
    return null;
  }
  if (typeof o.text !== "string") {
    return null;
  }
  const thumbnailUris = Array.isArray(o.thumbnailUris)
    ? o.thumbnailUris.filter((v): v is string => typeof v === "string")
    : [];
  const documentNames = Array.isArray(o.documentNames)
    ? o.documentNames.filter((v): v is string => typeof v === "string")
    : [];
  const conversationId =
    typeof o.conversationId === "string" ? o.conversationId : "";
  const artifacts = parseChatArtifacts(o.artifacts, conversationId);
  const tasks = parseStoredTasks(o.tasks);
  const toolSteps = parseStoredToolSteps(o.toolSteps);
  return {
    id: o.id,
    ...(typeof o.canonicalId === "string" && o.canonicalId.trim()
      ? { canonicalId: o.canonicalId.trim() }
      : {}),
    // The turn `requestId` links a phone-sent reply to its canonical desktop
    // row (see `mergeMessagesById`). Dropping it on reload let a restart's
    // catch-up sync re-append the already-stored reply as a duplicate when the
    // row carried a `requestId` but hadn't been stamped with a `canonicalId`
    // yet (killed before the background reconcile landed).
    ...(typeof o.requestId === "string" && o.requestId.trim()
      ? { requestId: o.requestId.trim() }
      : {}),
    ...(typeof o.createdAt === "number" && Number.isFinite(o.createdAt)
      ? { createdAt: o.createdAt }
      : {}),
    ...(typeof o.canonicalCreatedAt === "number" &&
    Number.isFinite(o.canonicalCreatedAt)
      ? { canonicalCreatedAt: o.canonicalCreatedAt }
      : {}),
    ...(typeof o.sourceMessageId === "string" && o.sourceMessageId.trim()
      ? { sourceMessageId: o.sourceMessageId.trim() }
      : {}),
    ...(typeof o.sourceTimestamp === "number" &&
    Number.isFinite(o.sourceTimestamp)
      ? { sourceTimestamp: o.sourceTimestamp }
      : {}),
    ...(typeof o.sequence === "number" && Number.isFinite(o.sequence)
      ? { sequence: o.sequence }
      : {}),
    role: o.role,
    text: o.text,
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(toolSteps.length > 0 ? { toolSteps } : {}),
    ...(tasks.length > 0 ? { tasks } : {}),
    ...(o.hasImage === true ? { hasImage: true } : {}),
    ...(thumbnailUris.length > 0 ? { thumbnailUris } : {}),
    ...(Array.isArray(o.attachmentPaths)
      ? { attachmentPaths: o.attachmentPaths.filter((path): path is string => typeof path === "string" && path.length > 0 && path.length <= 400) }
      : {}),
    ...(Array.isArray(o.attachmentPreviews) ? {
      attachmentPreviews: o.attachmentPreviews.flatMap(value => {
        if (!value || typeof value !== "object" || typeof value.path !== "string" || typeof value.name !== "string") return [];
        return [{ path: value.path, name: value.name, ...(typeof value.imageUri === "string" ? { imageUri: value.imageUri } : {}) }];
      }),
    } : {}),
    ...(documentNames.length > 0 ? { documentNames } : {}),
    ...(typeof o.quotedText === "string" && o.quotedText.trim()
      ? { quotedText: o.quotedText }
      : {}),
    ...(o.cloudFallback === true ? { cloudFallback: true } : {}),
    // A queued-but-unsent bubble must reload as queued, never as a delivered
    // message. The hook re-enqueues these on hydration so a restart actually
    // sends them (see `useChatThread`).
    ...(o.queued === true ? { queued: true } : {}),
    ...(o.stopped === true ? { stopped: true } : {}),
  };
}

function parseStoredMessages(raw: string | null): ChatMessage[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: ChatMessage[] = [];
    for (const item of parsed) {
      // Hydration must be corruption-tolerant per ROW: parseRow is defensive,
      // but if a row written by a different code version still manages to
      // throw, only that row is dropped — never the whole transcript, and
      // never the boot (this runs during initial mount).
      let row: ChatMessage | null = null;
      try {
        row = parseRow(item);
      } catch {
        row = null;
      }
      if (row) {
        out.push(row);
      }
    }
    return out;
  } catch {
    return [];
  }
}

const migrationKey = (thread: ChatThreadId) => `legacy-migration-v1:${thread}`;

/**
 * Copy the old whole-array AsyncStorage value into SQLite exactly once. The
 * marker and rows commit in one transaction; deleting the source happens only
 * after that commit. A kill at any boundary therefore retries harmlessly:
 * primary-key INSERT OR IGNORE prevents duplicates and the source remains
 * available until the durable commit is known to have succeeded.
 */
async function migrateLegacyTranscript(
  db: SQLiteDatabase,
  thread: ChatThreadId,
): Promise<void> {
  if (transcriptCleanupInProgress) return;
  const generation = transcriptGeneration(thread);
  const key = migrationKey(thread);
  const marker = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM mobile_chat_meta WHERE key = ?",
    key,
  );
  if (marker?.value === "done") return;

  const legacyRaw = await AsyncStorage.getItem(MESSAGES_KEY[thread]);
  const legacy = parseStoredMessages(legacyRaw);
  const committed = await enqueueTranscriptWrite(async () => {
    if (
      transcriptCleanupInProgress ||
      generation !== transcriptGeneration(thread)
    ) {
      return false;
    }
    invalidateCanonicalSnapshot(thread);
    await db.withTransactionAsync(async () => {
      for (let index = 0; index < legacy.length; index += 1) {
        const message = legacy[index];
        if (!message) continue;
        const serialized = JSON.stringify(message);
        await db.runAsync(
          `INSERT OR IGNORE INTO mobile_chat_messages(
             thread_id, message_id, order_key, canonical_id,
             canonical_created_at, sequence, payload_json, updated_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
          thread,
          message.id,
          index * ORDER_STRIDE,
          message.canonicalId ?? null,
          message.canonicalCreatedAt ?? null,
          message.sequence ?? null,
          serialized,
          Date.now(),
        );
      }
      await db.runAsync(
        `INSERT INTO mobile_chat_meta(key, value) VALUES(?, 'done')
         ON CONFLICT(key) DO UPDATE SET value = 'done'`,
        key,
      );
    });
    return true;
  });
  if (!committed) return;
  // If this removal fails, the completed SQLite marker wins next launch. The
  // legacy value is merely redundant; it can never overwrite canonical rows.
  await AsyncStorage.removeItem(MESSAGES_KEY[thread]).catch(() => {});
}

/** Narrow test seam for deterministic crash/retry coverage without a native runtime. */
export const __migrateLegacyTranscriptForTests = (
  db: unknown,
  thread: ChatThreadId,
): Promise<void> => migrateLegacyTranscript(db as SQLiteDatabase, thread);

/** Install a real in-memory SQLite adapter for repository contract tests. */
export async function __setTranscriptDatabaseForTests(
  database: unknown,
): Promise<void> {
  for (const thread of CHAT_THREAD_IDS) invalidateTranscriptWrites(thread);
  await transcriptWriteQueue.catch(() => {});
  const db = database as SQLiteDatabase | null;
  if (db) await db.execAsync(TRANSCRIPT_SCHEMA);
  transcriptDbPromise = Promise.resolve(db);
  transcriptWriteQueue = Promise.resolve();
  orderKeysByThread.clear();
  serializedByThread.clear();
  fallbackMigrations.clear();
}

export function __getTranscriptCacheSizesForTests(thread: ChatThreadId): {
  orderKeys: number;
  serialized: number;
} {
  return {
    orderKeys: orderKeysByThread.get(thread)?.size ?? 0,
    serialized: serializedByThread.get(thread)?.size ?? 0,
  };
}

const cursorForRow = (row: StoredMessageRow): ChatTranscriptCursor => ({
  orderKey: row.order_key,
  id: row.message_id,
});

function messagesFromStoredRows(
  thread: ChatThreadId,
  rows: StoredMessageRow[],
): ChatMessage[] {
  const orderKeys = orderKeysByThread.get(thread) ?? new Map<string, number>();
  const serialized =
    serializedByThread.get(thread) ?? new Map<string, string>();
  orderKeysByThread.set(thread, orderKeys);
  serializedByThread.set(thread, serialized);
  const messages: ChatMessage[] = [];
  for (const row of rows) {
    let parsed: ChatMessage | null = null;
    try {
      parsed = parseRow(JSON.parse(row.payload_json) as unknown);
    } catch {
      parsed = null;
    }
    if (!parsed) continue;
    touchCacheValue(orderKeys, parsed.id, row.order_key);
    touchCacheValue(serialized, parsed.id, row.payload_json);
    messages.push(parsed);
  }
  trimThreadCaches(thread);
  return messages;
}

function pageFromRows(args: {
  thread: ChatThreadId;
  rows: StoredMessageRow[];
  hasOlder: boolean;
  hasNewer: boolean;
}): ChatTranscriptPage {
  const messages = messagesFromStoredRows(args.thread, args.rows);
  if (args.rows.length === 0) return emptyPage();
  return {
    messages,
    oldestCursor: cursorForRow(args.rows[0]!),
    newestCursor: cursorForRow(args.rows[args.rows.length - 1]!),
    hasOlder: args.hasOlder,
    hasNewer: args.hasNewer,
  };
}

const fallbackMigrations = new Map<ChatThreadId, Promise<void>>();

async function ensureIncrementalFallback(thread: ChatThreadId): Promise<void> {
  const existing = fallbackMigrations.get(thread);
  if (existing) return existing;
  const migration = (async () => {
    const raw = await AsyncStorage.getItem(MESSAGES_KEY[thread]);
    if (!raw) return;
    const messages = parseStoredMessages(raw);
    if (messages.length > 0) {
      await saveAsyncTranscriptRows(
        thread,
        messages.map((message) => ({
          id: message.id,
          messageJson: JSON.stringify(message),
          ...(message.canonicalId ? { canonicalId: message.canonicalId } : {}),
        })),
      );
    }
    await AsyncStorage.removeItem(MESSAGES_KEY[thread]);
  })().catch((error) => {
    fallbackMigrations.delete(thread);
    throw error;
  });
  fallbackMigrations.set(thread, migration);
  return migration;
}

function pageFromAsyncRows(
  thread: ChatThreadId,
  page: AsyncTranscriptPage,
): ChatTranscriptPage {
  return pageFromRows({
    thread,
    rows: page.rows.map((row) => ({
      message_id: row.id,
      order_key: row.orderKey,
      payload_json: row.messageJson,
    })),
    hasOlder: page.hasOlder,
    hasNewer: page.hasNewer,
  });
}

async function saveFallbackMessages(
  thread: ChatThreadId,
  incoming: ChatMessage[],
): Promise<void> {
  await ensureIncrementalFallback(thread);
  const serialized =
    serializedByThread.get(thread) ?? new Map<string, string>();
  serializedByThread.set(thread, serialized);
  const candidates = incoming.map((message) => ({
    message,
    messageJson: JSON.stringify(message),
  }));
  if (
    candidates.every(
      ({ message, messageJson }) => serialized.get(message.id) === messageJson,
    )
  ) {
    return;
  }
  // Keep unchanged neighbors in the bounded write. They are ordering anchors
  // for historical prefixes and middle insertions; filtering them before the
  // fallback allocates keys would misclassify an adjacent page as a
  // disconnected newer delta.
  const saved = await saveAsyncTranscriptRows(
    thread,
    candidates.map(({ message, messageJson }) => ({
      id: message.id,
      messageJson,
      ...(message.canonicalId ? { canonicalId: message.canonicalId } : {}),
    })),
  );
  const orderKeys = orderKeysByThread.get(thread) ?? new Map<string, number>();
  orderKeysByThread.set(thread, orderKeys);
  for (let index = 0; index < candidates.length; index += 1) {
    const { message, messageJson } = candidates[index]!;
    if (message.canonicalId && message.canonicalId !== message.id) {
      orderKeys.delete(message.canonicalId);
      serialized.delete(message.canonicalId);
    }
    touchCacheValue(orderKeys, message.id, saved[index]!.orderKey);
    touchCacheValue(serialized, message.id, messageJson);
  }
  trimThreadCaches(thread);
}

export async function loadRecentChatMessages(
  thread: ChatThreadId,
  limit = CHAT_TRANSCRIPT_INITIAL_LIMIT,
): Promise<ChatTranscriptPage> {
  const boundedLimit = Math.max(1, Math.floor(limit));
  const db = await getTranscriptDb();
  if (!db) {
    await ensureIncrementalFallback(thread);
    return pageFromAsyncRows(
      thread,
      await loadRecentAsyncTranscriptRows(thread, boundedLimit),
    );
  }
  await migrateLegacyTranscript(db, thread);
  const descending = await db.getAllAsync<StoredMessageRow>(
    `SELECT message_id, order_key, payload_json
       FROM mobile_chat_messages
      WHERE thread_id = ?
      ORDER BY order_key DESC, message_id DESC
      LIMIT ?`,
    thread,
    boundedLimit + 1,
  );
  const hasOlder = descending.length > boundedLimit;
  const rows = descending.slice(0, boundedLimit).reverse();
  return pageFromRows({ thread, rows, hasOlder, hasNewer: false });
}

/** Start an oldest-to-newest bounded scan (used to seed a missing checkpoint). */
export async function loadOldestChatMessages(
  thread: ChatThreadId,
  limit = CHAT_TRANSCRIPT_INITIAL_LIMIT,
): Promise<ChatTranscriptPage> {
  const boundedLimit = Math.max(1, Math.floor(limit));
  const db = await getTranscriptDb();
  if (!db) {
    await ensureIncrementalFallback(thread);
    return pageFromAsyncRows(
      thread,
      await loadOldestAsyncTranscriptRows(thread, boundedLimit),
    );
  }
  await migrateLegacyTranscript(db, thread);
  const ascending = await db.getAllAsync<StoredMessageRow>(
    `SELECT message_id, order_key, payload_json
       FROM mobile_chat_messages
      WHERE thread_id = ?
      ORDER BY order_key ASC, message_id ASC
      LIMIT ?`,
    thread,
    boundedLimit + 1,
  );
  const hasNewer = ascending.length > boundedLimit;
  return pageFromRows({
    thread,
    rows: ascending.slice(0, boundedLimit),
    hasOlder: false,
    hasNewer,
  });
}

export async function loadOlderChatMessages(
  thread: ChatThreadId,
  before: ChatTranscriptCursor,
  limit = CHAT_TRANSCRIPT_PAGE_LIMIT,
): Promise<ChatTranscriptPage> {
  const boundedLimit = Math.max(1, Math.floor(limit));
  const db = await getTranscriptDb();
  if (!db) {
    await ensureIncrementalFallback(thread);
    return pageFromAsyncRows(
      thread,
      await loadOlderAsyncTranscriptRows(thread, before, boundedLimit),
    );
  }
  await migrateLegacyTranscript(db, thread);
  const resolvedBefore = await db.getFirstAsync<{
    order_key: number;
    message_id: string;
  }>(
    `SELECT order_key, message_id FROM mobile_chat_messages
      WHERE thread_id = ? AND message_id = ?
      LIMIT 1`,
    thread,
    before.id,
  );
  const currentBefore = resolvedBefore
    ? { orderKey: resolvedBefore.order_key, id: resolvedBefore.message_id }
    : before;
  const descending = await db.getAllAsync<StoredMessageRow>(
    `SELECT message_id, order_key, payload_json
       FROM mobile_chat_messages
      WHERE thread_id = ?
        AND (order_key < ? OR (order_key = ? AND message_id < ?))
      ORDER BY order_key DESC, message_id DESC
      LIMIT ?`,
    thread,
    currentBefore.orderKey,
    currentBefore.orderKey,
    currentBefore.id,
    boundedLimit + 1,
  );
  const hasOlder = descending.length > boundedLimit;
  const rows = descending.slice(0, boundedLimit).reverse();
  const newest = rows[rows.length - 1];
  const newer = newest
    ? await db.getFirstAsync<{ present: number }>(
        `SELECT 1 AS present FROM mobile_chat_messages
          WHERE thread_id = ?
            AND (order_key > ? OR (order_key = ? AND message_id > ?))
          LIMIT 1`,
        thread,
        newest.order_key,
        newest.order_key,
        newest.message_id,
      )
    : null;
  return pageFromRows({ thread, rows, hasOlder, hasNewer: Boolean(newer) });
}

export async function loadNewerChatMessages(
  thread: ChatThreadId,
  after: ChatTranscriptCursor,
  limit = CHAT_TRANSCRIPT_PAGE_LIMIT,
): Promise<ChatTranscriptPage> {
  const boundedLimit = Math.max(1, Math.floor(limit));
  const db = await getTranscriptDb();
  if (!db) {
    await ensureIncrementalFallback(thread);
    return pageFromAsyncRows(
      thread,
      await loadNewerAsyncTranscriptRows(thread, after, boundedLimit),
    );
  }
  await migrateLegacyTranscript(db, thread);
  const resolvedAfter = await db.getFirstAsync<{
    order_key: number;
    message_id: string;
  }>(
    `SELECT order_key, message_id FROM mobile_chat_messages
      WHERE thread_id = ? AND message_id = ?
      LIMIT 1`,
    thread,
    after.id,
  );
  const currentAfter = resolvedAfter
    ? { orderKey: resolvedAfter.order_key, id: resolvedAfter.message_id }
    : after;
  const ascending = await db.getAllAsync<StoredMessageRow>(
    `SELECT message_id, order_key, payload_json
       FROM mobile_chat_messages
      WHERE thread_id = ?
        AND (order_key > ? OR (order_key = ? AND message_id > ?))
      ORDER BY order_key ASC, message_id ASC
      LIMIT ?`,
    thread,
    currentAfter.orderKey,
    currentAfter.orderKey,
    currentAfter.id,
    boundedLimit + 1,
  );
  const hasNewer = ascending.length > boundedLimit;
  const rows = ascending.slice(0, boundedLimit);
  const oldest = rows[0];
  const older = oldest
    ? await db.getFirstAsync<{ present: number }>(
        `SELECT 1 AS present FROM mobile_chat_messages
          WHERE thread_id = ?
            AND (order_key < ? OR (order_key = ? AND message_id < ?))
          LIMIT 1`,
        thread,
        oldest.order_key,
        oldest.order_key,
        oldest.message_id,
      )
    : null;
  return pageFromRows({ thread, rows, hasOlder: Boolean(older), hasNewer });
}

/** Resolve a canonical transcript row to the keyset cursor used by paging. */
export async function findChatMessageCursor(
  thread: ChatThreadId,
  messageId: string,
): Promise<ChatTranscriptCursor | null> {
  const id = messageId.trim();
  if (!id) return null;
  const db = await getTranscriptDb();
  if (!db) {
    await ensureIncrementalFallback(thread);
    return findAsyncTranscriptCursor(thread, id);
  }
  await migrateLegacyTranscript(db, thread);
  const row = await db.getFirstAsync<{
    message_id: string;
    order_key: number;
  }>(
    `SELECT message_id, order_key
       FROM mobile_chat_messages
      WHERE thread_id = ? AND message_id = ?
      LIMIT 1`,
    thread,
    id,
  );
  return row ? { orderKey: row.order_key, id: row.message_id } : null;
}

/** Compatibility helper for call sites that only need the bounded recent tail. */
export async function loadChatMessages(
  thread: ChatThreadId,
): Promise<ChatMessage[]> {
  return (await loadRecentChatMessages(thread)).messages;
}

async function assignOrderKeys(
  db: SQLiteDatabase,
  thread: ChatThreadId,
  messages: ChatMessage[],
  allowRebalance = true,
): Promise<Map<string, number>> {
  const known = orderKeysByThread.get(thread) ?? new Map<string, number>();
  orderKeysByThread.set(thread, known);
  for (const message of messages) {
    if (known.has(message.id)) continue;
    const canonicalId = message.canonicalId?.trim();
    if (canonicalId && known.has(canonicalId)) {
      known.set(message.id, known.get(canonicalId)!);
      continue;
    }
    const stored = await db.getFirstAsync<{ order_key: number }>(
      `SELECT order_key FROM mobile_chat_messages
        WHERE thread_id = ? AND message_id IN (?, ?)
        ORDER BY CASE WHEN message_id = ? THEN 0 ELSE 1 END
        LIMIT 1`,
      thread,
      message.id,
      canonicalId ?? message.id,
      message.id,
    );
    if (stored) known.set(message.id, stored.order_key);
  }

  const bounds = await db.getFirstAsync<{
    min_key: number | null;
    max_key: number | null;
  }>(
    `SELECT MIN(order_key) AS min_key, MAX(order_key) AS max_key
       FROM mobile_chat_messages WHERE thread_id = ?`,
    thread,
  );
  let globalMin = bounds?.min_key ?? 0;
  let globalMax = bounds?.max_key ?? -ORDER_STRIDE;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (known.has(message.id)) continue;
    let runEnd = index + 1;
    while (runEnd < messages.length && !known.has(messages[runEnd]!.id)) {
      runEnd += 1;
    }
    const previous = index > 0 ? known.get(messages[index - 1]!.id) : undefined;
    const next =
      runEnd < messages.length ? known.get(messages[runEnd]!.id) : undefined;
    const count = runEnd - index;
    if (previous !== undefined && next !== undefined) {
      const step = (next - previous) / (count + 1);
      let priorCandidate = previous;
      let precisionExhausted = next > previous && !Number.isFinite(step);
      if (next > previous) {
        for (let offset = 0; offset < count; offset += 1) {
          const candidate = previous + step * (offset + 1);
          if (!(candidate > priorCandidate && candidate < next)) {
            precisionExhausted = true;
            break;
          }
          priorCandidate = candidate;
        }
      }
      if (precisionExhausted) {
        if (!allowRebalance) {
          throw new Error("Could not allocate stable transcript order keys");
        }
        const cachedIds = new Set(known.keys());
        for (const candidate of messages) {
          cachedIds.add(candidate.id);
          if (candidate.canonicalId) cachedIds.add(candidate.canonicalId);
        }
        const durable = await db.getAllAsync<{ message_id: string }>(
          `SELECT message_id FROM mobile_chat_messages
            WHERE thread_id = ?
            ORDER BY order_key ASC, message_id ASC`,
          thread,
        );
        await db.withTransactionAsync(async () => {
          for (
            let durableIndex = 0;
            durableIndex < durable.length;
            durableIndex += 1
          ) {
            await db.runAsync(
              `UPDATE mobile_chat_messages SET order_key = ?
                WHERE thread_id = ? AND message_id = ?`,
              durableIndex * ORDER_STRIDE,
              thread,
              durable[durableIndex]!.message_id,
            );
          }
        });
        known.clear();
        for (
          let durableIndex = 0;
          durableIndex < durable.length;
          durableIndex += 1
        ) {
          const id = durable[durableIndex]!.message_id;
          if (cachedIds.has(id)) known.set(id, durableIndex * ORDER_STRIDE);
        }
        return assignOrderKeys(db, thread, messages, false);
      }
      for (let offset = 0; offset < count; offset += 1) {
        known.set(messages[index + offset]!.id, previous + step * (offset + 1));
      }
    } else if (previous !== undefined) {
      for (let offset = 0; offset < count; offset += 1) {
        globalMax = Math.max(globalMax, previous) + ORDER_STRIDE;
        known.set(messages[index + offset]!.id, globalMax);
      }
    } else if (next !== undefined) {
      const first = Math.min(globalMin, next) - ORDER_STRIDE * count;
      for (let offset = 0; offset < count; offset += 1) {
        known.set(messages[index + offset]!.id, first + ORDER_STRIDE * offset);
      }
      globalMin = first;
    } else {
      // A disconnected batch is empty only during first persistence. A cursor
      // delta can legitimately have no overlap with a stale local window; in
      // that case it is newer and must append after the durable maximum rather
      // than reusing order key zero (which violates the unique order index).
      const emptyTranscript =
        bounds?.min_key == null && bounds?.max_key == null;
      for (let offset = 0; offset < count; offset += 1) {
        const orderKey = emptyTranscript
          ? offset * ORDER_STRIDE
          : globalMax + ORDER_STRIDE;
        known.set(messages[index + offset]!.id, orderKey);
        globalMax = orderKey;
      }
      if (emptyTranscript) globalMin = 0;
    }
    index = runEnd - 1;
  }
  return known;
}

export async function saveChatMessages(
  thread: ChatThreadId,
  messages: ChatMessage[],
): Promise<void> {
  if (transcriptCleanupInProgress) return;
  invalidateCanonicalSnapshot(thread);
  const generation = transcriptGeneration(thread);
  const db = await getTranscriptDb();
  if (!db) {
    // Non-native tests/web do not have expo-sqlite. Keep an explicit uncapped,
    // incremental compatibility store; native builds never take this branch.
    await enqueueTranscriptWrite(() =>
      generation === transcriptGeneration(thread)
        ? saveFallbackMessages(thread, messages)
        : Promise.resolve(),
    );
    return;
  }
  await migrateLegacyTranscript(db, thread);
  await enqueueTranscriptWrite(async () => {
    if (generation !== transcriptGeneration(thread)) return;
    invalidateCanonicalSnapshot(thread);
    const orderKeys = await assignOrderKeys(db, thread, messages);
    const priorSerialized =
      serializedByThread.get(thread) ?? new Map<string, string>();
    serializedByThread.set(thread, priorSerialized);
    const changed = messages.flatMap((message) => {
      const payload = JSON.stringify(message);
      return priorSerialized.get(message.id) === payload
        ? []
        : [{ message, payload }];
    });
    if (changed.length === 0) {
      trimThreadCaches(thread);
      return;
    }
    await db.withTransactionAsync(async () => {
      for (const { message, payload } of changed) {
        if (message.canonicalId && message.canonicalId !== message.id) {
          // A crash between a canonical pull and optimistic-row reconciliation
          // can leave both identities on disk. Once the stable local row links
          // to the desktop id it owns that canonical row; remove the raw twin
          // in the same transaction so hydration cannot render both.
          await db.runAsync(
            `DELETE FROM mobile_chat_messages
              WHERE thread_id = ? AND message_id = ?`,
            thread,
            message.canonicalId,
          );
        }
        await db.runAsync(
          `INSERT INTO mobile_chat_messages(
             thread_id, message_id, order_key, canonical_id,
             canonical_created_at, sequence, payload_json, updated_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(thread_id, message_id) DO UPDATE SET
             canonical_id = excluded.canonical_id,
             canonical_created_at = excluded.canonical_created_at,
             sequence = excluded.sequence,
             payload_json = excluded.payload_json,
             updated_at = excluded.updated_at
           WHERE mobile_chat_messages.payload_json <> excluded.payload_json`,
          thread,
          message.id,
          orderKeys.get(message.id) ?? 0,
          message.canonicalId ?? null,
          message.canonicalCreatedAt ?? null,
          message.sequence ?? null,
          payload,
          Date.now(),
        );
      }
    });
    for (const { message, payload } of changed) {
      if (message.canonicalId && message.canonicalId !== message.id) {
        orderKeys.delete(message.canonicalId);
        priorSerialized.delete(message.canonicalId);
      }
      touchCacheValue(priorSerialized, message.id, payload);
    }
    trimThreadCaches(thread);
  });
}

/**
 * Reconcile a complete canonical window. The caller invalidates cache metadata
 * first and publishes it only after this operation succeeds. SQLite changes
 * commit together; interrupted fallback writes remain behind that same fence.
 */
export async function synchronizeChatMessages(
  thread: ChatThreadId,
  messages: ChatMessage[],
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (transcriptCleanupInProgress) return;
  const previousSnapshot = canonicalSnapshotByThread.get(thread);
  // A complete authoritative window supersedes pending legacy/delta writers,
  // just as the previous clear-and-rebuild path did.
  invalidateTranscriptWrites(thread);
  const revision = canonicalSnapshotRevisionByThread.get(thread);
  const generation = transcriptGeneration(thread);
  const db = await getTranscriptDb();
  const current = () =>
    isCurrent() &&
    !transcriptCleanupInProgress &&
    generation === transcriptGeneration(thread);
  await enqueueTranscriptWrite(async () => {
    if (!current()) return;
    const incoming = messages.map((message) => ({
      id: message.id,
      messageJson: JSON.stringify(message),
    }));
    if (!db) {
      await synchronizeAsyncTranscriptRows(thread, incoming, current);
    } else {
      // Reuse only a successfully committed, bounded snapshot. Other write
      // APIs advance the revision even when queued, so no captured cache can
      // hide changes made while this reconciliation waited for its turn.
      const existing =
        previousSnapshot &&
        revision === canonicalSnapshotRevisionByThread.get(thread)
          ? previousSnapshot
          : (
              await db.getAllAsync<StoredMessageRow>(
                "SELECT message_id, order_key, payload_json FROM mobile_chat_messages WHERE thread_id = ?",
                thread,
              )
            ).map((row) => ({
              id: row.message_id,
              orderKey: row.order_key,
              messageJson: row.payload_json,
            }));
      const { changed, removed } = diffTranscriptSnapshot(existing, incoming);
      if (!current()) return;
      const stale = new Error("Canonical snapshot superseded");
      try {
        if (changed.length || removed.length)
          await db.withTransactionAsync(async () => {
            for (const row of removed) {
              if (!current()) throw stale;
              await db.runAsync(
                "DELETE FROM mobile_chat_messages WHERE thread_id = ? AND message_id = ?",
                thread,
                row.id,
              );
            }
            const byId = new Map(
              messages.map((message) => [message.id, message]),
            );
            for (const row of changed) {
              if (!current()) throw stale;
              const message = byId.get(row.id)!;
              await db.runAsync(
                `INSERT INTO mobile_chat_messages(thread_id, message_id, order_key, canonical_id, canonical_created_at, sequence, payload_json, updated_at)
               VALUES(?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(thread_id, message_id) DO UPDATE SET order_key = excluded.order_key,
                 canonical_id = excluded.canonical_id, canonical_created_at = excluded.canonical_created_at,
                 sequence = excluded.sequence, payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
                thread,
                row.id,
                row.orderKey,
                message.canonicalId ?? null,
                message.canonicalCreatedAt ?? null,
                message.sequence ?? null,
                row.messageJson,
                Date.now(),
              );
            }
            if (!current()) throw stale;
          });
      } catch (error) {
        if (error === stale) return;
        throw error;
      }
      // At most 3,000 rows and roughly 16 MiB of UTF-16 payload. Oversized
      // snapshots remain correct and simply use the durable comparison path.
      if (
        current() &&
        revision === canonicalSnapshotRevisionByThread.get(thread) &&
        incoming.length <= 3_000 &&
        incoming.reduce((sum, row) => sum + row.messageJson.length, 0) <=
          8 * 1024 * 1024
      ) {
        const next = new Map(existing.map((row) => [row.id, row]));
        for (const row of removed) next.delete(row.id);
        for (const row of changed) next.set(row.id, row);
        canonicalSnapshotByThread.set(thread, [...next.values()]);
      }
    }
    if (!current()) return;
    await AsyncStorage.removeItem(MESSAGES_KEY[thread]);
    fallbackMigrations.delete(thread);
    // The ordinary append writer's bounded caches must not retain deleted or
    // reordered identities. This path compares against durable rows directly.
    orderKeysByThread.delete(thread);
    serializedByThread.delete(thread);
  });
}

/** Replace one thread's canonical transcript without touching account metadata. */
export async function clearChatMessages(thread: ChatThreadId): Promise<void> {
  invalidateTranscriptWrites(thread);
  const db = await getTranscriptDb();
  await recoverInterruptedCleanup(db);
  await fallbackMigrations.get(thread)?.catch(() => {});
  await enqueueTranscriptWrite(async () => {
    if (db) {
      await db.runAsync(
        "DELETE FROM mobile_chat_messages WHERE thread_id = ?",
        thread,
      );
    }
    await clearAsyncTranscriptRows(thread);
    await AsyncStorage.removeItem(MESSAGES_KEY[thread]);
    orderKeysByThread.delete(thread);
    serializedByThread.delete(thread);
    fallbackMigrations.delete(thread);
  });
}

const normalizeSyncState = (value: unknown): ChatSyncState => {
  if (!value || typeof value !== "object") {
    return { conversationId: null, cursor: null };
  }
  const record = value as Record<string, unknown>;
  const conversationId =
    typeof record.conversationId === "string"
      ? record.conversationId.trim()
      : "";
  const cursor = typeof record.cursor === "string" ? record.cursor.trim() : "";
  return {
    conversationId: conversationId || null,
    cursor: cursor || null,
  };
};

export async function loadChatSyncState(
  thread: ChatThreadId,
): Promise<ChatSyncState> {
  const empty = { conversationId: null, cursor: null };
  try {
    if (await accountChatMetadataReadsBlocked()) return empty;
    const raw = await AsyncStorage.getItem(SYNC_STATE_KEY[thread]);
    if (await accountChatMetadataReadsBlocked()) return empty;
    if (raw) {
      return normalizeSyncState(JSON.parse(raw) as unknown);
    }
    return empty;
  } catch {
    return empty;
  }
}

export async function saveChatSyncState(
  thread: ChatThreadId,
  state: ChatSyncState,
): Promise<void> {
  if (
    transcriptCleanupInProgress ||
    (await accountChatMetadataReadsBlocked())
  ) {
    return;
  }
  const generation = transcriptGeneration(thread);
  const next = normalizeSyncState(state);
  await enqueueTranscriptWrite(async () => {
    if (
      transcriptCleanupInProgress ||
      generation !== transcriptGeneration(thread) ||
      (await accountChatMetadataReadsBlocked())
    ) {
      return;
    }
    if (!next.conversationId && !next.cursor) {
      await AsyncStorage.removeItem(SYNC_STATE_KEY[thread]);
      return;
    }
    await AsyncStorage.setItem(SYNC_STATE_KEY[thread], JSON.stringify(next));
  });
}

/**
 * Wipe every thread's transcript and sync cursor. The stores are keyed
 * globally (not per account), so sign-out and account deletion must clear
 * them or the next signed-in user inherits — and re-sends as history — the
 * previous user's messages.
 */
export async function clearAllChatStorage(): Promise<void> {
  transcriptCleanupInProgress = true;
  transcriptCleanupRecoveryRequired = true;
  transcriptCleanupMarkerCheck = Promise.resolve(true);
  invalidateChatStorageForAccountCleanup();
  // Do not let an enqueue already committing in the background recreate the
  // old account's outbox after sign-out has removed its storage keys. Cleanup
  // remains independent: a SQLite failure must not skip AsyncStorage removal.
  let databaseCleared = false;
  let fallbackCleared = false;
  let asyncStorageCleared = false;
  try {
    // Do not begin a partly durable account wipe. If intent persistence fails,
    // the caller gets an error and canonical data remains intact for a retry;
    // the process-local latch still prevents this process from serving it.
    await AsyncStorage.setItem(TRANSCRIPT_CLEANUP_REQUIRED_KEY, "1");
    await waitForAccountChatMetadataWrites();
    await waitForDesktopChatOutboxWrites().catch(() => {});
    let databaseOpenFailed = false;
    const db = await getTranscriptDb().catch(() => {
      databaseOpenFailed = true;
      return null;
    });
    if (db) {
      databaseCleared = await enqueueTranscriptWrite(() =>
        db
          .withTransactionAsync(async () => {
            await db.execAsync(
              "DELETE FROM mobile_chat_messages; DELETE FROM mobile_chat_meta;",
            );
          })
          .then(() => true),
      ).catch(() => false);
    } else {
      await enqueueTranscriptWrite(async () => {}).catch(() => {});
      databaseCleared = !databaseOpenFailed;
    }
    fallbackCleared = await Promise.all(
      CHAT_THREAD_IDS.map((thread) => clearAsyncTranscriptRows(thread)),
    )
      .then(() => true)
      .catch(() => false);
    asyncStorageCleared = await AsyncStorage.multiRemove(
      allAccountChatStorageKeys(),
    )
      .then(() => true)
      .catch(() => false);
    if (databaseCleared && fallbackCleared && asyncStorageCleared) {
      const markerRemoved = await AsyncStorage.removeItem(
        TRANSCRIPT_CLEANUP_REQUIRED_KEY,
      )
        .then(() => true)
        .catch(() => false);
      if (markerRemoved) {
        transcriptCleanupRecoveryRequired = false;
        transcriptCleanupMarkerCheck = Promise.resolve(false);
      }
    }
    if (!databaseCleared || !fallbackCleared || !asyncStorageCleared) {
      throw new Error("Local chat account cleanup did not complete");
    }
  } finally {
    for (const thread of CHAT_THREAD_IDS) invalidateTranscriptWrites(thread);
    orderKeysByThread.clear();
    serializedByThread.clear();
    fallbackMigrations.clear();
    transcriptCleanupInProgress = false;
    finishAccountChatMetadataCleanup();
  }
}
