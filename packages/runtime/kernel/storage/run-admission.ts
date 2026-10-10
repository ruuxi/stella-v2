/**
 * Durable run admission for desktop chat sends (`run_admission`, schema v4).
 *
 * A user send carries a stable request identity from the client
 * (`userMessageEventId`, minted once per send by the renderer or mobile, or
 * the caller's stable `requestId`). The worker claims that key here before it
 * appends the user message or asks the runner for a run, so a retry of the
 * same send — the host re-sending after a worker reconnect, a restarted
 * worker, a mobile resend — finds the existing admission and gets the
 * original run back instead of starting a second one (Pi durable's
 * `requestId` submission idempotency, `admitSubmission`).
 *
 * The status column tracks the send: `queued` → `placed` (with `run_id`) →
 * `done` | `unanswered`. A start that fails before any run owns the send
 * releases the key (no row), so the client can retry it from scratch.
 *
 * All statements are single-row and synchronous on the worker's database
 * thread; each runs in autocommit, so a claim is atomic without an explicit
 * transaction.
 */

import {
  cachedStatements,
  type CachedStatements,
  type SqliteDatabase,
} from "./shared.js";

export type RunAdmissionStatus = "queued" | "placed" | "done" | "unanswered";

export type RunAdmissionRecord = {
  conversationId: string;
  requestId: string;
  runId: string | null;
  status: RunAdmissionStatus;
  createdAt: number;
  updatedAt: number;
};

export type RunAdmissionClaim =
  | { admitted: true }
  | { admitted: false; existing: RunAdmissionRecord };

/** Admission rows older than this are deleted by idle maintenance. */
export const RUN_ADMISSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type RunAdmissionRow = {
  conversationId: string;
  requestId: string;
  runId: string | null;
  status: RunAdmissionStatus;
  createdAt: number;
  updatedAt: number;
};

const changesOf = (result: unknown): number => {
  const changes = (result as { changes?: unknown } | undefined)?.changes;
  return typeof changes === "number" ? changes : 0;
};

export class RunAdmissionStore {
  private readonly cached: CachedStatements;

  constructor(db: SqliteDatabase) {
    this.cached = cachedStatements(db);
  }

  /**
   * Claim `(conversationId, requestId)` as `queued`. Returns the existing
   * admission instead when the key was already claimed.
   */
  claim(args: {
    conversationId: string;
    requestId: string;
    now?: number;
  }): RunAdmissionClaim {
    const now = args.now ?? Date.now();
    const inserted = changesOf(
      this.cached
        .prepare(
          `INSERT INTO run_admission (
             conversation_id, request_id, run_id, status, created_at, updated_at
           ) VALUES (?, ?, NULL, 'queued', ?, ?)
           ON CONFLICT(conversation_id, request_id) DO NOTHING`,
        )
        .run(args.conversationId, args.requestId, now, now),
    );
    if (inserted > 0) return { admitted: true };
    const existing = this.get(args.conversationId, args.requestId);
    // Unreachable on one synchronous connection (the conflict means the row
    // exists); a missing row would mean the key is free, so admit.
    if (!existing) return { admitted: true };
    return { admitted: false, existing };
  }

  /**
   * Re-open an admission no run ever owned (`run_id IS NULL`): its claimant
   * exited before placing it — the in-memory turn queue does not survive a
   * worker restart yet — so a retry must be able to admit the send again.
   * Returns false when the admission already has a run.
   */
  reopenUnplaced(args: {
    conversationId: string;
    requestId: string;
    now?: number;
  }): boolean {
    const now = args.now ?? Date.now();
    return (
      changesOf(
        this.cached
          .prepare(
            `UPDATE run_admission SET status = 'queued', updated_at = ?
             WHERE conversation_id = ? AND request_id = ? AND run_id IS NULL`,
          )
          .run(now, args.conversationId, args.requestId),
      ) > 0
    );
  }

  get(conversationId: string, requestId: string): RunAdmissionRecord | null {
    const row = this.cached
      .prepare(
        `SELECT conversation_id AS conversationId, request_id AS requestId,
                run_id AS runId, status, created_at AS createdAt,
                updated_at AS updatedAt
         FROM run_admission WHERE conversation_id = ? AND request_id = ?`,
      )
      .get(conversationId, requestId) as RunAdmissionRow | undefined;
    return row ? { ...row } : null;
  }

  /** The runner accepted the send onto `runId` (a new run or a live steer). */
  markPlaced(args: {
    conversationId: string;
    requestId: string;
    runId: string;
    now?: number;
  }): void {
    this.cached
      .prepare(
        `UPDATE run_admission SET run_id = ?, status = 'placed', updated_at = ?
         WHERE conversation_id = ? AND request_id = ? AND status = 'queued'`,
      )
      .run(
        args.runId,
        args.now ?? Date.now(),
        args.conversationId,
        args.requestId,
      );
  }

  /**
   * Settle every still-open admission placed on `runId`: `done` when the run
   * ended normally, `unanswered` when it was canceled or failed. Returns the
   * number of admissions settled.
   */
  settleRun(args: {
    conversationId: string;
    runId: string;
    status: "done" | "unanswered";
    now?: number;
  }): number {
    return changesOf(
      this.cached
        .prepare(
          `UPDATE run_admission SET status = ?, updated_at = ?
           WHERE conversation_id = ? AND run_id = ?
             AND status IN ('queued', 'placed')`,
        )
        .run(
          args.status,
          args.now ?? Date.now(),
          args.conversationId,
          args.runId,
        ),
    );
  }

  /**
   * At boot: settle every admission the previous process left open
   * (`queued` or `placed`) as `unanswered`. An unplaced claim stays
   * re-openable (`reopenUnplaced` keys on `run_id IS NULL`). Returns the
   * number of admissions settled.
   */
  settleStale(args: {
    /** Only rows last touched before this process started. */
    updatedBefore: number;
    now?: number;
  }): number {
    return changesOf(
      this.cached
        .prepare(
          `UPDATE run_admission SET status = 'unanswered', updated_at = ?
           WHERE status IN ('queued', 'placed') AND updated_at < ?`,
        )
        .run(args.now ?? Date.now(), args.updatedBefore),
    );
  }

  /** Drop a claim no run ever owned, so a retry can admit the send again. */
  release(conversationId: string, requestId: string): void {
    this.cached
      .prepare(
        `DELETE FROM run_admission
         WHERE conversation_id = ? AND request_id = ? AND status = 'queued'`,
      )
      .run(conversationId, requestId);
  }
}

/**
 * Retention: delete admissions created before `now - retentionMs`. Uses
 * `idx_run_admission_created`; the table holds one row per send, so a pass
 * is a few hundred rows at most. Returns the number of rows deleted.
 */
export const pruneRunAdmissions = (
  db: SqliteDatabase,
  options: { now?: number; retentionMs?: number } = {},
): number => {
  const cutoff =
    (options.now ?? Date.now()) -
    (options.retentionMs ?? RUN_ADMISSION_RETENTION_MS);
  return changesOf(
    db.prepare("DELETE FROM run_admission WHERE created_at < ?").run(cutoff),
  );
};
