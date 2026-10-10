import { randomUUID } from "node:crypto";
import type {
  DispatchSummary,
  ExecutionKind,
} from "@stella/contracts/turn-plane/placement";
import type { SqliteDatabase } from "../kernel/storage/shared.js";

type PlacementOutcome = "completed" | "failed" | "canceled";

type LocalInboxState =
  | "claimed"
  | "accepted"
  | "running"
  | "terminal_pending"
  | "terminal"
  | "orphaned";

type SessionRow = {
  owner_id: string;
  owner_generation: string;
  presence_session_id: string;
};

export type ExecutionPlacementInboxRow = {
  dispatchId: string;
  ownerId: string;
  ownerGeneration: string;
  presenceSessionId: string;
  kind: ExecutionKind;
  conversationId: string;
  /** The claim request id this device used; names the exact handoff. */
  claimToken: string;
  payloadHash: string;
  payloadJson: string;
  dispatchJson: string;
  state: LocalInboxState;
  terminalOutcome?: PlacementOutcome;
  resultJson?: string;
  errorCode?: string;
  errorMessage?: string;
  cancelRpcPending: boolean;
  cancelOrphanOnAck: boolean;
  persistedAt: number;
  startedAt?: number;
  updatedAt: number;
};

type InboxDbRow = {
  dispatch_id: string;
  owner_id: string;
  owner_generation: string;
  presence_session_id: string;
  kind: ExecutionKind;
  conversation_id: string;
  claim_token: string;
  payload_hash: string;
  payload_json: string;
  dispatch_json: string;
  state: LocalInboxState;
  terminal_outcome: PlacementOutcome | null;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  cancel_rpc_pending: number;
  cancel_orphan_on_ack: number;
  persisted_at: number;
  started_at: number | null;
  updated_at: number;
};

type ClaimedExecution = {
  dispatch: DispatchSummary;
  payloadJson: string;
  payloadHash: string;
  claimExpiresAt: number;
};

const fromInboxRow = (row: InboxDbRow): ExecutionPlacementInboxRow => ({
  dispatchId: row.dispatch_id,
  ownerId: row.owner_id,
  ownerGeneration: row.owner_generation,
  presenceSessionId: row.presence_session_id,
  kind: row.kind,
  conversationId: row.conversation_id,
  claimToken: row.claim_token,
  payloadHash: row.payload_hash,
  payloadJson: row.payload_json,
  dispatchJson: row.dispatch_json,
  state: row.state,
  ...(row.terminal_outcome ? { terminalOutcome: row.terminal_outcome } : {}),
  ...(row.result_json !== null ? { resultJson: row.result_json } : {}),
  ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
  ...(row.error_message !== null ? { errorMessage: row.error_message } : {}),
  cancelRpcPending: row.cancel_rpc_pending === 1,
  cancelOrphanOnAck: row.cancel_orphan_on_ack === 1,
  persistedAt: row.persisted_at,
  ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
  updatedAt: row.updated_at,
});

/**
 * Durable ownership boundary. An owner-gate claim is acknowledged only after
 * the exact payload the offer carried is committed here in one SQLite
 * transaction: from `ack` on, this row is the only copy of the prompt.
 */
export class ExecutionPlacementInbox {
  constructor(private readonly database: SqliteDatabase) {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS execution_placement_runtime_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        owner_id TEXT NOT NULL,
        owner_generation TEXT NOT NULL,
        presence_session_id TEXT NOT NULL,
        proof_seq INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS execution_placement_inbox (
        dispatch_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        owner_generation TEXT NOT NULL,
        presence_session_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('chat', 'agent')),
        conversation_id TEXT NOT NULL,
        claim_token TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        dispatch_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN (
            'claimed', 'accepted', 'running', 'terminal_pending',
            'terminal', 'orphaned'
          )
        ),
        terminal_outcome TEXT,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        cancel_rpc_pending INTEGER NOT NULL DEFAULT 0,
        cancel_orphan_on_ack INTEGER NOT NULL DEFAULT 0,
        persisted_at INTEGER NOT NULL,
        started_at INTEGER,
        updated_at INTEGER NOT NULL
      );
    `);
    const inboxColumns = new Set(
      (
        this.database
          .prepare("PRAGMA table_info(execution_placement_inbox)")
          .all() as Array<{ name: string }>
      ).map((column) => column.name),
    );
    if (!inboxColumns.has("cancel_rpc_pending")) {
      this.database.exec(
        "ALTER TABLE execution_placement_inbox ADD COLUMN cancel_rpc_pending INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!inboxColumns.has("cancel_orphan_on_ack")) {
      this.database.exec(
        "ALTER TABLE execution_placement_inbox ADD COLUMN cancel_orphan_on_ack INTEGER NOT NULL DEFAULT 0",
      );
    }
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS idx_execution_placement_inbox_recovery
      ON execution_placement_inbox(
        owner_id, owner_generation, presence_session_id, state, updated_at
      );
    `);
  }

  openSession(args: {
    ownerId: string;
    ownerGeneration: string;
    now: number;
  }): { presenceSessionId: string; reused: boolean } {
    const current = this.database
      .prepare(
        `SELECT owner_id, owner_generation, presence_session_id
         FROM execution_placement_runtime_state WHERE id = 1`,
      )
      .get() as SessionRow | undefined;
    if (
      current?.owner_id === args.ownerId &&
      current.owner_generation === args.ownerGeneration
    ) {
      return { presenceSessionId: current.presence_session_id, reused: true };
    }
    const presenceSessionId = `presence:${randomUUID()}`;
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      // A generation/session rotation can strand a worker effect that was
      // started by the previous process. Persist the exact local cancellation
      // obligation before changing ownership. openSession deliberately keeps
      // these rows non-terminal until the cancellation RPC is acknowledged.
      this.database
        .prepare(
          `UPDATE execution_placement_inbox
           SET cancel_rpc_pending = 1, cancel_orphan_on_ack = 1,
               terminal_outcome = 'canceled', result_json = NULL,
               error_code = 'LOCAL_EXECUTION_OWNER_CHANGED',
               error_message =
                 'The local execution owner changed before completion.',
               updated_at = ?
           WHERE state IN ('claimed', 'accepted', 'running')`,
        )
        .run(args.now);
      this.database
        .prepare(
          `UPDATE execution_placement_inbox
           SET state = 'orphaned', updated_at = ?
           WHERE state NOT IN ('terminal', 'orphaned')
             AND cancel_rpc_pending = 0`,
        )
        .run(args.now);
      this.database
        .prepare(
          `INSERT INTO execution_placement_runtime_state (
             id, owner_id, owner_generation, presence_session_id,
             proof_seq, updated_at
           ) VALUES (1, ?, ?, ?, 0, ?)
           ON CONFLICT(id) DO UPDATE SET
             owner_id = excluded.owner_id,
             owner_generation = excluded.owner_generation,
             presence_session_id = excluded.presence_session_id,
             proof_seq = 0,
             updated_at = excluded.updated_at`,
        )
        .run(args.ownerId, args.ownerGeneration, presenceSessionId, args.now);
      this.database.exec("COMMIT;");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK;");
      } catch {
        // BEGIN itself failed.
      }
      throw error;
    }
    return { presenceSessionId, reused: false };
  }

  persistClaim(args: {
    ownerId: string;
    ownerGeneration: string;
    presenceSessionId: string;
    claimToken: string;
    claimed: ClaimedExecution;
    now: number;
  }): { replayed: boolean } {
    const existing = this.get(args.claimed.dispatch.dispatchId);
    if (existing) {
      const same =
        existing.ownerId === args.ownerId &&
        existing.ownerGeneration === args.ownerGeneration &&
        existing.presenceSessionId === args.presenceSessionId &&
        existing.claimToken === args.claimToken &&
        existing.payloadHash === args.claimed.payloadHash &&
        existing.payloadJson === args.claimed.payloadJson;
      if (!same) {
        throw new Error(
          "A local execution dispatch was replayed with different claim bytes.",
        );
      }
      return { replayed: true };
    }
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database
        .prepare(
          `INSERT INTO execution_placement_inbox (
             dispatch_id, owner_id, owner_generation, presence_session_id,
             kind, conversation_id, claim_token, payload_hash, payload_json,
             dispatch_json, state, persisted_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?)`,
        )
        .run(
          args.claimed.dispatch.dispatchId,
          args.ownerId,
          args.ownerGeneration,
          args.presenceSessionId,
          args.claimed.dispatch.kind,
          args.claimed.dispatch.conversationId,
          args.claimToken,
          args.claimed.payloadHash,
          args.claimed.payloadJson,
          JSON.stringify(args.claimed.dispatch),
          args.now,
          args.now,
        );
      this.database.exec("COMMIT;");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK;");
      } catch {
        // BEGIN itself failed.
      }
      throw error;
    }
    return { replayed: false };
  }

  get(dispatchId: string): ExecutionPlacementInboxRow | null {
    const row = this.database
      .prepare(`SELECT * FROM execution_placement_inbox WHERE dispatch_id = ?`)
      .get(dispatchId) as InboxDbRow | undefined;
    return row ? fromInboxRow(row) : null;
  }

  listUnfinished(args: {
    ownerId: string;
    ownerGeneration: string;
    presenceSessionId: string;
  }): ExecutionPlacementInboxRow[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM execution_placement_inbox
           WHERE owner_id = ? AND owner_generation = ?
             AND presence_session_id = ?
             AND state IN (
               'claimed', 'accepted', 'running', 'terminal_pending'
             )
           ORDER BY persisted_at ASC`,
        )
        .all(
          args.ownerId,
          args.ownerGeneration,
          args.presenceSessionId,
        ) as InboxDbRow[]
    ).map(fromInboxRow);
  }

  listAllUnfinished(): ExecutionPlacementInboxRow[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM execution_placement_inbox
           WHERE state IN (
             'claimed', 'accepted', 'running', 'terminal_pending'
           )
           ORDER BY persisted_at ASC`,
        )
        .all() as InboxDbRow[]
    ).map(fromInboxRow);
  }

  listCancellationPending(): ExecutionPlacementInboxRow[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM execution_placement_inbox
           WHERE cancel_rpc_pending = 1
           ORDER BY persisted_at ASC`,
        )
        .all() as InboxDbRow[]
    ).map(fromInboxRow);
  }

  stageCancellation(
    dispatchId: string,
    args: {
      outcome: PlacementOutcome;
      errorCode?: string;
      errorMessage?: string;
      orphanOnAck?: boolean;
      now: number;
    },
  ) {
    this.database
      .prepare(
        `UPDATE execution_placement_inbox
         SET cancel_rpc_pending = 1,
             cancel_orphan_on_ack = CASE
               WHEN cancel_orphan_on_ack = 1 OR ? = 1 THEN 1
               ELSE 0
             END,
             terminal_outcome = ?, result_json = NULL,
             error_code = ?, error_message = ?, updated_at = ?
         WHERE dispatch_id = ?
           AND state IN (
             'claimed', 'accepted', 'running', 'terminal_pending'
           )`,
      )
      .run(
        args.orphanOnAck ? 1 : 0,
        args.outcome,
        args.errorCode ?? null,
        args.errorMessage ?? null,
        args.now,
        dispatchId,
      );
  }

  acknowledgeCancellation(dispatchId: string, now: number) {
    this.database
      .prepare(
        `UPDATE execution_placement_inbox
         SET state = CASE
               WHEN cancel_orphan_on_ack = 1 THEN 'orphaned'
               ELSE 'terminal_pending'
             END,
             cancel_rpc_pending = 0,
             cancel_orphan_on_ack = 0,
             updated_at = ?
         WHERE dispatch_id = ? AND cancel_rpc_pending = 1`,
      )
      .run(now, dispatchId);
  }

  acknowledgeClaimRelease(dispatchId: string, now: number) {
    this.database
      .prepare(
        `UPDATE execution_placement_inbox
         SET state = 'orphaned', cancel_rpc_pending = 0,
             cancel_orphan_on_ack = 0, updated_at = ?
         WHERE dispatch_id = ? AND state = 'claimed'`,
      )
      .run(now, dispatchId);
  }

  markAccepted(dispatchId: string, dispatch: DispatchSummary, now: number) {
    this.database
      .prepare(
        `UPDATE execution_placement_inbox
         SET state = 'accepted', dispatch_json = ?, updated_at = ?
         WHERE dispatch_id = ? AND cancel_rpc_pending = 0
           AND state IN ('claimed', 'accepted')`,
      )
      .run(JSON.stringify(dispatch), now, dispatchId);
  }

  markRunning(dispatchId: string, now: number) {
    this.database
      .prepare(
        `UPDATE execution_placement_inbox
         SET state = 'running', started_at = COALESCE(started_at, ?),
             updated_at = ?
         WHERE dispatch_id = ? AND cancel_rpc_pending = 0
           AND state IN ('accepted', 'running')`,
      )
      .run(now, now, dispatchId);
  }

  markTerminalPending(
    dispatchId: string,
    args: {
      outcome: PlacementOutcome;
      resultJson?: string;
      errorCode?: string;
      errorMessage?: string;
      now: number;
    },
  ) {
    this.database
      .prepare(
        `UPDATE execution_placement_inbox
         SET state = 'terminal_pending', terminal_outcome = ?,
             result_json = ?, error_code = ?, error_message = ?,
             cancel_rpc_pending = 0, cancel_orphan_on_ack = 0,
             updated_at = ?
         WHERE dispatch_id = ?
           AND cancel_rpc_pending = 0
           AND state IN ('claimed', 'accepted', 'running', 'terminal_pending')`,
      )
      .run(
        args.outcome,
        args.resultJson ?? null,
        args.errorCode ?? null,
        args.errorMessage ?? null,
        args.now,
        dispatchId,
      );
  }

  markTerminal(dispatchId: string, dispatch: DispatchSummary, now: number) {
    this.database
      .prepare(
        `UPDATE execution_placement_inbox
         SET state = 'terminal', dispatch_json = ?, cancel_rpc_pending = 0,
             cancel_orphan_on_ack = 0, updated_at = ?
         WHERE dispatch_id = ? AND cancel_rpc_pending = 0`,
      )
      .run(JSON.stringify(dispatch), now, dispatchId);
  }

  markOrphaned(dispatchId: string, now: number) {
    this.database
      .prepare(
        `UPDATE execution_placement_inbox
         SET state = 'orphaned', cancel_rpc_pending = 0,
             cancel_orphan_on_ack = 0, updated_at = ?
         WHERE dispatch_id = ? AND cancel_rpc_pending = 0`,
      )
      .run(now, dispatchId);
  }

  pruneTerminal(before: number) {
    this.database
      .prepare(
        `DELETE FROM execution_placement_inbox
         WHERE state IN ('terminal', 'orphaned') AND updated_at < ?`,
      )
      .run(before);
  }
}
