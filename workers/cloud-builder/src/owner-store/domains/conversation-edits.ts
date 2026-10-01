/**
 * Fork and rewind. The transcript copy or cut happens inside the
 * conversations' `OrchestratorSession` objects, in bounded resumable passes
 * (`conversation-edit-runner.ts`); this domain owns the durable reservation
 * around them and publishes the result to the conversation index.
 *
 * A reservation is keyed by the client's `requestId`, so a retried edit
 * resumes the same operation (and the same fork target) instead of starting
 * another, and a finished one replays its result.
 */

import type { ConversationCalls } from "@stella/contracts/backend/conversations";
import {
  CONVERSATION_PREVIEW_MAX,
  CONVERSATION_TITLE_MAX,
} from "@stella/contracts/backend/conversations";
import type {
  ConversationEditRequest,
  ConversationEditResult,
  ForkConversationEditResult,
  RewindConversationEditResult,
} from "../../conversation-edit-protocol.js";
import { literal, number, object, string } from "../args.js";
import { RpcError } from "../errors.js";
import { enforceOwnerRateLimit } from "../rate-limit.js";
import type { OwnerContext, OwnerDb, OwnerDomain } from "../registry.js";
import {
  CLIENT_CREATE_ID_PATTERN,
  CONVERSATION_ID_PATTERN,
  clip,
  readConversation,
  type ConversationRow,
} from "./conversations.js";

type ForkArgs = ConversationCalls["conversations.fork"]["args"];
type ForkResult = ConversationCalls["conversations.fork"]["result"];
type RewindArgs = ConversationCalls["conversations.rewind"]["args"];
type RewindResult = ConversationCalls["conversations.rewind"]["result"];

type EditRow = {
  operation_id: string;
  request_id: string;
  fingerprint: string;
  owner_generation: string;
  kind: string;
  state: string;
  source_conversation_id: string;
  target_conversation_id: string | null;
  through_seq: number;
  expected_epoch: number;
  expected_last_seq: number;
  active_turn_policy: string | null;
  title: string | null;
  source_created_at: number | null;
  target_created_at: number | null;
  execution_json: string | null;
  result_json: string | null;
  created_at: number;
  updated_at: number;
};

export const CONVERSATION_EDITS_MIGRATION = {
  id: "conversation-edits.1-init",
  statements: [
    `CREATE TABLE conversation_edits (
       operation_id TEXT PRIMARY KEY,
       request_id TEXT NOT NULL UNIQUE,
       fingerprint TEXT NOT NULL,
       owner_generation TEXT NOT NULL,
       kind TEXT NOT NULL,
       state TEXT NOT NULL,
       source_conversation_id TEXT NOT NULL,
       target_conversation_id TEXT,
       through_seq INTEGER NOT NULL,
       expected_epoch INTEGER NOT NULL,
       expected_last_seq INTEGER NOT NULL,
       active_turn_policy TEXT,
       title TEXT,
       source_created_at INTEGER,
       target_created_at INTEGER,
       execution_json TEXT,
       result_json TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
  ],
};

/** Passes before the client is told to retry; each pass copies 64 pages. */
const MAX_EDIT_PASSES = 32;

const notFound = (): never => {
  throw new RpcError("NOT_FOUND", "Conversation not found.");
};

const conflict = (message: string): never => {
  throw new RpcError("CONFLICT", message);
};

const validateBoundary = (args: {
  throughSeq: number;
  expectedEpoch: number;
  expectedLastSeq: number;
  requestId: string;
}): void => {
  if (args.throughSeq > args.expectedLastSeq) {
    throw new RpcError("BAD_REQUEST", "Invalid conversation edit boundary.");
  }
  if (!CLIENT_CREATE_ID_PATTERN.test(args.requestId)) {
    throw new RpcError("BAD_REQUEST", "requestId must be an opaque 8-128 character id.");
  }
};

const liveRow = (db: OwnerDb, conversationId: string): ConversationRow => {
  const row = readConversation(db, conversationId);
  return row && row.deleted_at === null ? row : notFound();
};

const readEdit = (db: OwnerDb, column: "request_id" | "operation_id", value: string) =>
  db.one<EditRow>(`SELECT * FROM conversation_edits WHERE ${column} = ?`, value);

const ensureReplayMatches = (row: EditRow, ownerGeneration: string, fingerprint: string): void => {
  if (row.owner_generation !== ownerGeneration) {
    conflict("This edit belongs to an earlier account-data generation.");
  }
  if (row.fingerprint !== fingerprint) {
    conflict("requestId was already used for a different conversation edit.");
  }
};

const editRequest = (ownerId: string, row: EditRow): ConversationEditRequest =>
  row.kind === "fork"
    ? {
        v: 1,
        kind: "fork",
        operationId: row.operation_id,
        ownerId,
        ownerGeneration: row.owner_generation,
        sourceConversationId: row.source_conversation_id,
        targetConversationId: row.target_conversation_id!,
        throughSeq: row.through_seq,
        expectedEpoch: row.expected_epoch,
        expectedLastSeq: row.expected_last_seq,
        title: row.title!,
        sourceCreatedAt: row.source_created_at!,
        targetCreatedAt: row.target_created_at!,
      }
    : {
        v: 1,
        kind: "rewind",
        operationId: row.operation_id,
        ownerId,
        ownerGeneration: row.owner_generation,
        conversationId: row.source_conversation_id,
        throughSeq: row.through_seq,
        expectedEpoch: row.expected_epoch,
        expectedLastSeq: row.expected_last_seq,
        activeTurnPolicy: row.active_turn_policy === "cancel" ? "cancel" : "conflict",
      };

/**
 * Drive the orchestrator passes until the edit completes. Before each pass the
 * source must still exist under the generation the edit was reserved in, so a
 * delete or reset stops the copy.
 */
const runToCompletion = async (ctx: OwnerContext, row: EditRow): Promise<ConversationEditResult> => {
  for (let pass = 0; pass < MAX_EDIT_PASSES; pass += 1) {
    const { ownerGeneration } = await ctx.host.snapshot();
    if (ownerGeneration !== row.owner_generation) {
      conflict("This edit belongs to an earlier account-data generation.");
    }
    liveRow(ctx.db, row.source_conversation_id);
    const result = await ctx.host.runConversationEdit(editRequest(ctx.ownerId, row));
    if (result.kind !== row.kind) conflict("Cloud worker returned the wrong edit kind.");
    if (result.complete) return result;
  }
  throw new RpcError("UNAVAILABLE", "The conversation edit is still copying. Retry the same requestId.");
};

const markComplete = (db: OwnerDb, operationId: string, result: object, now: number): void => {
  db.run(
    `UPDATE conversation_edits SET state = 'complete', result_json = ?, updated_at = ?
      WHERE operation_id = ?`,
    JSON.stringify(result),
    now,
    operationId,
  );
};

const preview = (value: string | undefined): string | null =>
  value !== undefined ? clip(value, CONVERSATION_PREVIEW_MAX) : null;

// ── Fork ──────────────────────────────────────────────────────────────────

const forkConversation = async (ctx: OwnerContext, args: ForkArgs): Promise<ForkResult> => {
  validateBoundary(args);
  const { ownerGeneration } = await ctx.host.snapshot();
  const fingerprint = JSON.stringify([
    "fork",
    args.sourceConversationId,
    args.throughSeq,
    args.expectedEpoch,
    args.expectedLastSeq,
  ]);
  let row = readEdit(ctx.db, "request_id", args.requestId);
  if (row) {
    ensureReplayMatches(row, ownerGeneration, fingerprint);
  } else {
    const source = liveRow(ctx.db, args.sourceConversationId);
    enforceOwnerRateLimit(
      ctx.db,
      ctx.now,
      "conversations.fork",
      { count: 30, windowMs: 10 * 60_000 },
      "Too many forks at once. Wait a moment and try again.",
    );
    const operationId = crypto.randomUUID();
    ctx.db.run(
      `INSERT INTO conversation_edits
         (operation_id, request_id, fingerprint, owner_generation, kind, state,
          source_conversation_id, target_conversation_id, through_seq,
          expected_epoch, expected_last_seq, title, source_created_at,
          target_created_at, execution_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'fork', 'preparing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      operationId,
      args.requestId,
      fingerprint,
      ownerGeneration,
      args.sourceConversationId,
      crypto.randomUUID(),
      args.throughSeq,
      args.expectedEpoch,
      args.expectedLastSeq,
      (source.title.trim() || "Conversation").slice(0, 256),
      source.created_at,
      ctx.now,
      source.execution_json,
      ctx.now,
      ctx.now,
    );
    row = readEdit(ctx.db, "operation_id", operationId)!;
  }
  if (row.state === "complete") return { ...(JSON.parse(row.result_json!) as ForkResult), replayed: true };

  const result = (await runToCompletion(ctx, row)) as ForkConversationEditResult;
  // Re-read after the passes: a concurrent retry may have published already.
  const current = readEdit(ctx.db, "operation_id", row.operation_id)!;
  if (current.state === "complete") {
    return { ...(JSON.parse(current.result_json!) as ForkResult), replayed: true };
  }
  const targetId = current.target_conversation_id!;
  if (
    result.targetConversationId !== targetId ||
    result.sourceEpoch !== current.expected_epoch ||
    result.throughSeq !== current.through_seq ||
    result.targetEpoch !== 1 ||
    result.lastSeq !== current.through_seq
  ) {
    conflict("Fork completion does not match its durable reservation.");
  }
  liveRow(ctx.db, current.source_conversation_id);
  const now = Date.now();
  const target = readConversation(ctx.db, targetId);
  if (target?.deleted_at != null) conflict("Fork target identity is already in use.");
  if (target) {
    ctx.db.run(
      `UPDATE conversations SET
         epoch = ?, last_seq = ?, updated_at = MAX(updated_at, ?), activity = 'idle',
         last_preview = ?, last_role = ?
       WHERE conversation_id = ? AND (epoch < ? OR (epoch = ? AND last_seq < ?))`,
      result.targetEpoch,
      result.lastSeq,
      now,
      preview(result.lastPreview),
      result.lastRole ?? null,
      targetId,
      result.targetEpoch,
      result.targetEpoch,
      result.lastSeq,
    );
  } else {
    ctx.db.run(
      `INSERT INTO conversations
         (conversation_id, title, created_at, updated_at, allow_empty, execution_json,
          epoch, last_seq, last_preview, last_role, activity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle')`,
      targetId,
      clip(current.title ?? "Conversation", CONVERSATION_TITLE_MAX),
      current.target_created_at ?? current.created_at,
      now,
      result.lastSeq < 0 ? 1 : 0,
      current.execution_json,
      result.targetEpoch,
      result.lastSeq,
      preview(result.lastPreview),
      result.lastRole ?? null,
    );
  }
  const published: ForkResult = {
    conversationId: targetId,
    sourceEpoch: result.sourceEpoch,
    throughSeq: current.through_seq,
    targetEpoch: result.targetEpoch,
    lastSeq: result.lastSeq,
    replayed: false,
  };
  markComplete(ctx.db, current.operation_id, published, now);
  return published;
};

// ── Rewind ────────────────────────────────────────────────────────────────

const rewindConversation = async (ctx: OwnerContext, args: RewindArgs): Promise<RewindResult> => {
  validateBoundary(args);
  const { ownerGeneration } = await ctx.host.snapshot();
  const fingerprint = JSON.stringify([
    "rewind",
    args.conversationId,
    args.throughSeq,
    args.expectedEpoch,
    args.expectedLastSeq,
    args.activeTurnPolicy,
  ]);
  let row = readEdit(ctx.db, "request_id", args.requestId);
  if (row) {
    ensureReplayMatches(row, ownerGeneration, fingerprint);
  } else {
    liveRow(ctx.db, args.conversationId);
    const operationId = crypto.randomUUID();
    ctx.db.run(
      `INSERT INTO conversation_edits
         (operation_id, request_id, fingerprint, owner_generation, kind, state,
          source_conversation_id, through_seq, expected_epoch, expected_last_seq,
          active_turn_policy, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'rewind', 'preparing', ?, ?, ?, ?, ?, ?, ?)`,
      operationId,
      args.requestId,
      fingerprint,
      ownerGeneration,
      args.conversationId,
      args.throughSeq,
      args.expectedEpoch,
      args.expectedLastSeq,
      args.activeTurnPolicy,
      ctx.now,
      ctx.now,
    );
    row = readEdit(ctx.db, "operation_id", operationId)!;
  }
  if (row.state === "complete") return { ...(JSON.parse(row.result_json!) as RewindResult), replayed: true };

  const result = (await runToCompletion(ctx, row)) as RewindConversationEditResult;
  const current = readEdit(ctx.db, "operation_id", row.operation_id)!;
  if (current.state === "complete") {
    return { ...(JSON.parse(current.result_json!) as RewindResult), replayed: true };
  }
  if (
    result.conversationId !== current.source_conversation_id ||
    result.previousEpoch !== current.expected_epoch ||
    result.lastSeq !== current.through_seq ||
    result.nextEpoch !== current.expected_epoch + 1
  ) {
    conflict("Rewind completion does not match its durable reservation.");
  }
  liveRow(ctx.db, current.source_conversation_id);
  const now = Date.now();
  // The orchestrator's own index flush for the new epoch may have landed
  // first; it is at least as new, so leave it.
  ctx.db.run(
    `UPDATE conversations SET
       epoch = ?, last_seq = ?, updated_at = MAX(updated_at, ?), activity = 'idle',
       last_preview = ?, last_role = ?,
       allow_empty = CASE WHEN ? < 0 THEN 1 ELSE allow_empty END
     WHERE conversation_id = ? AND epoch < ?`,
    result.nextEpoch,
    result.lastSeq,
    now,
    preview(result.lastPreview),
    result.lastRole ?? null,
    result.lastSeq,
    current.source_conversation_id,
    result.nextEpoch,
  );
  const published: RewindResult = {
    conversationId: current.source_conversation_id,
    previousEpoch: result.previousEpoch,
    nextEpoch: result.nextEpoch,
    lastSeq: result.lastSeq,
    replayed: false,
  };
  markComplete(ctx.db, current.operation_id, published, now);
  return published;
};

const conversationIdArg = string({ pattern: CONVERSATION_ID_PATTERN, max: 64 });
const boundaryArgs = {
  throughSeq: number({ int: true, min: -1 }),
  expectedEpoch: number({ int: true, min: 1 }),
  expectedLastSeq: number({ int: true, min: -1 }),
  requestId: string({ max: 128 }),
};

export const conversationEditsDomain = {
  name: "conversation-edits",
  migrations: [CONVERSATION_EDITS_MIGRATION],
  calls: {
    "conversations.fork": {
      scope: "owner",
      parse: object({ sourceConversationId: conversationIdArg, ...boundaryArgs }),
      handler: forkConversation,
    },
    "conversations.rewind": {
      scope: "owner",
      parse: object({
        conversationId: conversationIdArg,
        ...boundaryArgs,
        activeTurnPolicy: literal("conflict", "cancel"),
      }),
      handler: rewindConversation,
    },
  },
} satisfies OwnerDomain;
