/**
 * The owner's conversation index. Each conversation's transcript lives in its
 * own `OrchestratorSession`; this table is what a client lists and selects
 * from. The orchestrator keeps it current through the turn outbox
 * (`conversation.*`, `turn.started`), which `applyConversationEvent` applies.
 *
 * Delivery is at-least-once and may reorder, so index updates are fenced on
 * `(epoch, lastSeq)` and a deleted row stays as a tombstone: nothing that
 * arrives late can move a row backwards or bring it back.
 */

import type {
  ConversationCalls,
  ConversationSummary,
} from "@stella/contracts/backend/conversations";
import {
  CONVERSATION_PREVIEW_MAX,
  CONVERSATION_TITLE_MAX,
  RECENT_CONVERSATIONS_LIMIT,
} from "@stella/contracts/backend/conversations";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import type {
  ConversationCreatedEvent,
  ConversationDeletedEvent,
  ConversationIndexEvent,
  TurnStartedEvent,
} from "@stella/contracts/turn-plane/outbox";
import { parseCloudExecutionSelection } from "../../turn-start-request.js";
import { empty, number, object, optional, string } from "../args.js";
import type { Parser } from "../args.js";
import { RpcError } from "../errors.js";
import { enforceOwnerRateLimit } from "../rate-limit.js";
import type { OwnerContext, OwnerDb, OwnerDbReader, OwnerDomain } from "../registry.js";

export type ConversationRow = {
  conversation_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  client_create_id: string | null;
  allow_empty: number;
  execution_json: string | null;
  epoch: number;
  last_seq: number;
  last_preview: string | null;
  last_role: string | null;
  activity: string | null;
};

export const CONVERSATIONS_MIGRATION = {
  id: "conversations.1-init",
  statements: [
    `CREATE TABLE conversations (
       conversation_id TEXT PRIMARY KEY,
       title TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL,
       deleted_at INTEGER,
       client_create_id TEXT,
       allow_empty INTEGER NOT NULL DEFAULT 0,
       execution_json TEXT,
       epoch INTEGER NOT NULL DEFAULT 0,
       last_seq INTEGER NOT NULL DEFAULT -1,
       last_preview TEXT,
       last_role TEXT,
       activity TEXT
     )`,
    `CREATE UNIQUE INDEX conversations_client_create
       ON conversations (client_create_id) WHERE client_create_id IS NOT NULL`,
    `CREATE INDEX conversations_recent
       ON conversations (updated_at DESC, conversation_id DESC) WHERE deleted_at IS NULL`,
  ],
};

export const CONVERSATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const CLIENT_CREATE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_PAGE = 50;

export const clip = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

const summary = (row: ConversationRow, ownerId: string): ConversationSummary => ({
  ownerId,
  conversationId: row.conversation_id,
  title: row.title,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.last_preview !== null ? { lastPreview: row.last_preview } : {}),
  ...(row.last_role !== null ? { lastRole: row.last_role } : {}),
  ...(row.activity === "idle" || row.activity === "running"
    ? { activity: row.activity }
    : {}),
});

export const readConversation = (db: OwnerDbReader, conversationId: string): ConversationRow | null =>
  db.one<ConversationRow>(
    "SELECT * FROM conversations WHERE conversation_id = ?",
    conversationId,
  );

/** A live conversation this owner has, or null. */
export const liveConversation = (
  db: OwnerDbReader,
  ownerId: string,
  conversationId: string,
): ConversationSummary | null => {
  const row = readConversation(db, conversationId);
  return row && row.deleted_at === null ? summary(row, ownerId) : null;
};

const recentConversations = (db: OwnerDbReader, ownerId: string): ConversationSummary[] =>
  db
    .all<ConversationRow>(
      `SELECT * FROM conversations WHERE deleted_at IS NULL
        ORDER BY updated_at DESC, conversation_id DESC LIMIT ?`,
      RECENT_CONVERSATIONS_LIMIT,
    )
    .map((row) => summary(row, ownerId));

const executionParser: Parser<CloudExecutionSelection> = (value, path = "") => {
  const parsed = parseCloudExecutionSelection(value);
  if (!parsed) throw new RpcError("BAD_REQUEST", `${path || "execution"} is invalid.`);
  return parsed;
};

/** A non-Stella engine needs a connected credential before a turn can use it. */
const assertExecutionAvailable = async (
  ctx: OwnerContext,
  execution: CloudExecutionSelection,
): Promise<void> => {
  if (execution.engine === "stella") return;
  const snapshot = await ctx.host.snapshot();
  if (!(snapshot.connectedEngines ?? []).includes(execution.engine)) {
    throw new RpcError(
      "CONFLICT",
      execution.engine === "anthropic"
        ? "Connect Claude before using that cloud execution route."
        : "Connect ChatGPT before using that cloud execution route.",
    );
  }
};

const ownerIdentity = async (ctx: OwnerContext) => {
  const snapshot = await ctx.host.snapshot();
  return {
    ownerId: ctx.ownerId,
    ownerGeneration: snapshot.ownerGeneration,
    isAnonymous: ctx.caller?.isAnonymous ?? snapshot.isAnonymous,
  };
};

const createConversation = async (
  ctx: OwnerContext,
  args: ConversationCalls["conversations.create"]["args"],
): Promise<ConversationSummary> => {
  if (!CLIENT_CREATE_ID_PATTERN.test(args.clientCreateId)) {
    throw new RpcError("BAD_REQUEST", "That conversation could not be created. Try again.");
  }
  if (args.requestedConversationId && !CONVERSATION_ID_PATTERN.test(args.requestedConversationId)) {
    throw new RpcError("BAD_REQUEST", "That conversation could not be created. Try again.");
  }
  const existing = ctx.db.one<ConversationRow>(
    "SELECT * FROM conversations WHERE client_create_id = ?",
    args.clientCreateId,
  );
  if (existing) {
    if (existing.deleted_at !== null) throw new RpcError("NOT_FOUND", "Conversation not found.");
    return summary(existing, ctx.ownerId);
  }
  if (args.execution) await assertExecutionAvailable(ctx, args.execution);
  // Re-read after the await: a retried create may have landed meanwhile.
  const raced = ctx.db.one<ConversationRow>(
    "SELECT * FROM conversations WHERE client_create_id = ?",
    args.clientCreateId,
  );
  if (raced) return summary(raced, ctx.ownerId);
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "conversations.create",
    { count: 30, windowMs: 10 * 60_000 },
    "Too many conversations created at once. Wait a moment and try again.",
  );
  const conversationId = args.requestedConversationId ?? crypto.randomUUID();
  if (readConversation(ctx.db, conversationId)) {
    throw new RpcError("CONFLICT", "That conversation could not be created. Try again.");
  }
  ctx.db.run(
    `INSERT INTO conversations
       (conversation_id, title, created_at, updated_at, client_create_id, allow_empty, execution_json)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
    conversationId,
    clip(args.title?.trim() ?? "", CONVERSATION_TITLE_MAX),
    ctx.now,
    ctx.now,
    args.clientCreateId,
    args.execution ? JSON.stringify(args.execution) : null,
  );
  return summary(readConversation(ctx.db, conversationId)!, ctx.ownerId);
};

const page = (
  db: OwnerDbReader,
  ownerId: string,
  args: ConversationCalls["conversations.page"]["args"],
): ConversationCalls["conversations.page"]["result"] => {
  const limit = Math.min(Math.max(args.limit ?? 25, 1), MAX_PAGE);
  const rows = args.before
    ? db.all<ConversationRow>(
        `SELECT * FROM conversations WHERE deleted_at IS NULL
           AND (updated_at < ? OR (updated_at = ? AND conversation_id < ?))
         ORDER BY updated_at DESC, conversation_id DESC LIMIT ?`,
        args.before.updatedAt,
        args.before.updatedAt,
        args.before.conversationId,
        limit + 1,
      )
    : db.all<ConversationRow>(
        `SELECT * FROM conversations WHERE deleted_at IS NULL
         ORDER BY updated_at DESC, conversation_id DESC LIMIT ?`,
        limit + 1,
      );
  return {
    conversations: rows.slice(0, limit).map((row) => summary(row, ownerId)),
    hasMore: rows.length > limit,
  };
};

// ── Outbox events from the orchestrator ───────────────────────────────────

export type ConversationEvent =
  | ConversationCreatedEvent
  | ConversationIndexEvent
  | ConversationDeletedEvent
  | TurnStartedEvent;

/** Apply one orchestrator event to the index. Safe to replay. */
export const applyConversationEvent = (db: OwnerDb, event: ConversationEvent): void => {
  const row = readConversation(db, event.conversationId);
  switch (event.kind) {
    case "conversation.created": {
      if (row) return;
      db.run(
        `INSERT INTO conversations (conversation_id, title, created_at, updated_at, execution_json)
         VALUES (?, ?, ?, ?, ?)`,
        event.conversationId,
        clip(event.title.trim(), CONVERSATION_TITLE_MAX),
        event.createdAt,
        event.createdAt,
        event.execution ? JSON.stringify(event.execution) : null,
      );
      return;
    }
    case "conversation.index": {
      if (!row) {
        // A lost row is rebuilt from what the orchestrator mirrors; without
        // its creation time the row would sort wrong forever.
        if (event.createdAt === undefined) return;
        db.run(
          `INSERT INTO conversations
             (conversation_id, title, created_at, updated_at, epoch, last_seq,
              last_preview, last_role, activity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          event.conversationId,
          clip(event.title?.trim() || "Conversation", CONVERSATION_TITLE_MAX),
          event.createdAt,
          Math.max(event.updatedAt, event.createdAt),
          event.epoch,
          event.lastSeq,
          event.lastPreview !== undefined ? clip(event.lastPreview, CONVERSATION_PREVIEW_MAX) : null,
          event.lastRole ?? null,
          event.activity ?? null,
        );
        return;
      }
      if (row.deleted_at !== null) return;
      // A rewind advances the epoch so a delayed flush from the removed
      // suffix can't land.
      if (event.epoch < row.epoch) return;
      if (event.force !== true && event.epoch === row.epoch && event.lastSeq <= row.last_seq) return;
      db.run(
        `UPDATE conversations SET
           epoch = ?, last_seq = ?, updated_at = MAX(updated_at, ?),
           allow_empty = CASE WHEN ? >= 0 THEN 0 ELSE allow_empty END,
           last_preview = COALESCE(?, last_preview),
           last_role = COALESCE(?, last_role),
           activity = COALESCE(?, activity),
           title = CASE WHEN TRIM(title) = '' AND ? <> '' THEN ? ELSE title END
         WHERE conversation_id = ?`,
        event.epoch,
        event.lastSeq,
        event.updatedAt,
        event.lastSeq,
        event.lastPreview !== undefined ? clip(event.lastPreview, CONVERSATION_PREVIEW_MAX) : null,
        event.lastRole ?? null,
        event.activity ?? null,
        event.title?.trim() ?? "",
        clip(event.title?.trim() ?? "", CONVERSATION_TITLE_MAX),
        event.conversationId,
      );
      return;
    }
    case "conversation.deleted": {
      if (!row) {
        db.run(
          `INSERT INTO conversations (conversation_id, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?)`,
          event.conversationId,
          event.deletedAt,
          event.deletedAt,
          event.deletedAt,
        );
        return;
      }
      if (row.deleted_at !== null) return;
      db.run(
        "UPDATE conversations SET deleted_at = ? WHERE conversation_id = ?",
        event.deletedAt,
        event.conversationId,
      );
      return;
    }
    case "turn.started": {
      // A fresh turn sorts its conversation to the top before the
      // orchestrator's first index flush.
      if (!row || row.deleted_at !== null) return;
      db.run(
        `UPDATE conversations SET
           updated_at = MAX(updated_at, ?), allow_empty = 0,
           execution_json = COALESCE(execution_json, ?)
         WHERE conversation_id = ?`,
        event.createdAt,
        JSON.stringify(event.execution),
        event.conversationId,
      );
      return;
    }
  }
};

const conversationIdArg = string({ pattern: CONVERSATION_ID_PATTERN, max: 64 });

export const conversationsDomain = {
  name: "conversations",
  migrations: [CONVERSATIONS_MIGRATION],
  calls: {
  "owner.identity": {
    scope: "owner",
    parse: empty(),
    handler: (ctx: OwnerContext) => ownerIdentity(ctx),
  },
  "conversations.create": {
    scope: "owner",
    parse: object({
      clientCreateId: string({ max: 128 }),
      requestedConversationId: optional(string({ max: 64 })),
      title: optional(string({ max: 2_000 })),
      execution: optional(executionParser),
    }),
    handler: createConversation,
  },
  "conversations.bootstrap": {
    scope: "owner",
    parse: object({ clientCreateId: string({ max: 128 }) }),
    handler: async (ctx: OwnerContext, args: { clientCreateId: string }) => {
      if (!CLIENT_CREATE_ID_PATTERN.test(args.clientCreateId)) {
        throw new RpcError("BAD_REQUEST", "That conversation could not be created. Try again.");
      }
      const identity = await ownerIdentity(ctx);
      const existing = ctx.db.one<ConversationRow>(
        "SELECT * FROM conversations WHERE client_create_id = ?",
        args.clientCreateId,
      );
      if (existing?.deleted_at != null) throw new RpcError("NOT_FOUND", "Conversation not found.");
      return { ...identity, conversationId: existing?.conversation_id ?? null };
    },
  },
  "conversations.page": {
    scope: "owner",
    parse: object({
      before: optional(object({ updatedAt: number({ int: true, min: 0 }), conversationId: string({ max: 64 }) })),
      limit: optional(number({ int: true, min: 1, max: MAX_PAGE })),
    }),
    handler: (ctx: OwnerContext, args: ConversationCalls["conversations.page"]["args"]) => page(ctx.db, ctx.ownerId, args),
  },
  },
  views: {
  "conversations.recent": {
    parse: empty(),
    read: (ctx: { db: OwnerDbReader; ownerId: string }) => recentConversations(ctx.db, ctx.ownerId),
  },
  "conversations.get": {
    parse: object({ conversationId: conversationIdArg }),
    read: (ctx: { db: OwnerDbReader; ownerId: string }, args: { conversationId: string }) =>
      liveConversation(ctx.db, ctx.ownerId, args.conversationId),
  },
  },
} satisfies OwnerDomain;
