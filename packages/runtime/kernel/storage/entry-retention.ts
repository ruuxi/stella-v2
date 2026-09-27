/**
 * Retention for rows in the chat `entry` table that nothing reads.
 *
 * `run_event` rows were written once per run lifecycle event (and, until
 * 2026-08-29, once per streamed text chunk) by the old
 * `ChatLog.recordRunEvent`. Every event API excludes them (`NON_EVENT_TYPES`
 * in chat-log.ts), they carry no `search_text` (so no FTS rows) and no
 * `entry_ref` rows, and the in-flight resume buffer lives in
 * `stella-runs.sqlite` (run-event-log.ts). The writer is gone; this module
 * drains the rows existing stores still hold.
 *
 * The drain is bounded: each batch deletes at most `batchSize` rows in its
 * own immediate transaction, the loop pauses between batches, and it stops
 * as soon as the caller reports the worker busy or interrupts it. A store
 * with ~1.5 M legacy rows drains over many short transactions instead of
 * one long write that would block a turn. Re-running resumes where the last
 * pass stopped, because the only state is the rows themselves.
 */

import { Cause, Effect, Exit } from "effect";
import { storageRuntime } from "./effect-runtime.js";
import type { SqliteDatabase } from "./shared.js";

export const LEGACY_RUN_EVENT_ENTRY_TYPE = "run_event";
export const LEGACY_RUN_EVENT_SWEEP_BATCH = 5_000;
export const LEGACY_RUN_EVENT_SWEEP_PAUSE_MS = 50;

type Transaction = <T>(work: () => T) => T;

export type LegacyRunEventBatchResult = {
  deleted: number;
  /**
   * Conversation the next batch should start from, or null when no
   * `run_event` rows remain at or after the batch's starting conversation.
   */
  resumeFrom: string | null;
};

export type LegacyRunEventSweepOptions = {
  /** Upper bound on rows deleted per transaction. */
  batchSize?: number;
  /** Pause between batches, so other writers and readers interleave. */
  pauseMs?: number;
  /**
   * Checked before every batch; returning false ends the pass with outcome
   * "busy" so the caller can reschedule it for the next idle window.
   */
  isIdle?: () => boolean;
  /**
   * Wrap each batch in the owner's transaction helper (for example
   * `SessionStore.withImmediateTransaction`) so nesting rules match the
   * rest of the store. Defaults to BEGIN IMMEDIATE / COMMIT.
   */
  transaction?: Transaction;
};

export type LegacyRunEventSweepResult = {
  deleted: number;
  batches: number;
  outcome: "complete" | "busy" | "aborted";
};

const immediateTransaction =
  (db: SqliteDatabase): Transaction =>
  (work) => {
    db.exec("BEGIN IMMEDIATE;");
    try {
      const result = work();
      db.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        /* the transaction may already be gone */
      }
      throw error;
    }
  };

/**
 * Delete up to `batchSize` legacy `run_event` rows in one transaction,
 * walking conversations in id order from `fromConversationId`. Each lookup
 * is a seek on `idx_entry_conv_type_seq (conversation_id, type, seq)`, so
 * a batch never scans the table.
 */
export const deleteLegacyRunEventBatch = (
  db: SqliteDatabase,
  options: {
    batchSize?: number;
    fromConversationId?: string | null;
    transaction?: Transaction;
  } = {},
): LegacyRunEventBatchResult => {
  const batchSize = Math.max(
    1,
    Math.floor(options.batchSize ?? LEGACY_RUN_EVENT_SWEEP_BATCH),
  );
  const transaction = options.transaction ?? immediateTransaction(db);
  return transaction(() => {
    const firstConversation = db.prepare(
      `SELECT conversation_id AS conversationId FROM entry
       ORDER BY conversation_id ASC LIMIT 1`,
    );
    const nextConversation = db.prepare(
      `SELECT conversation_id AS conversationId FROM entry
       WHERE conversation_id > ?
       ORDER BY conversation_id ASC LIMIT 1`,
    );
    const selectRows = db.prepare(
      `SELECT rowid AS id FROM entry
       WHERE conversation_id = ? AND type = ?
       LIMIT ?`,
    );
    const readConversation = (row: unknown): string | null => {
      const value = (row as { conversationId?: unknown } | undefined)
        ?.conversationId;
      return typeof value === "string" ? value : null;
    };

    let conversationId =
      typeof options.fromConversationId === "string"
        ? options.fromConversationId
        : readConversation(firstConversation.get());
    const rowIds: number[] = [];
    while (conversationId !== null) {
      const remaining = batchSize - rowIds.length;
      const rows = selectRows.all(
        conversationId,
        LEGACY_RUN_EVENT_ENTRY_TYPE,
        remaining,
      ) as Array<{ id: number }>;
      for (const row of rows) rowIds.push(row.id);
      // A full page may leave more rows in this conversation: resume here.
      if (rows.length === remaining) break;
      conversationId = readConversation(nextConversation.get(conversationId));
    }
    if (rowIds.length > 0) {
      db.prepare(
        "DELETE FROM entry WHERE rowid IN (SELECT value FROM json_each(?))",
      ).run(JSON.stringify(rowIds));
    }
    return { deleted: rowIds.length, resumeFrom: conversationId };
  });
};

/**
 * One bounded retention pass as an Effect. Interrupting the fiber stops the
 * pass between batches (each batch is a single synchronous transaction, so
 * it either commits whole or never starts). `progress` is updated after each
 * batch so an interrupted caller can still report what was deleted.
 */
export const sweepLegacyRunEventEntriesEffect = (
  db: SqliteDatabase,
  options: LegacyRunEventSweepOptions = {},
  progress: { deleted: number; batches: number } = { deleted: 0, batches: 0 },
): Effect.Effect<LegacyRunEventSweepResult> =>
  Effect.gen(function* () {
    const pauseMs = Math.max(
      0,
      options.pauseMs ?? LEGACY_RUN_EVENT_SWEEP_PAUSE_MS,
    );
    let resumeFrom: string | null = null;
    for (;;) {
      if (options.isIdle && !options.isIdle()) {
        return { ...progress, outcome: "busy" as const };
      }
      const batch = deleteLegacyRunEventBatch(db, {
        batchSize: options.batchSize,
        fromConversationId: resumeFrom,
        transaction: options.transaction,
      });
      if (batch.deleted > 0) {
        progress.deleted += batch.deleted;
        progress.batches += 1;
      }
      if (batch.resumeFrom === null) {
        return { ...progress, outcome: "complete" as const };
      }
      resumeFrom = batch.resumeFrom;
      yield* Effect.sleep(pauseMs);
    }
  });

/**
 * Entry point for the maintenance scheduler: drain legacy `run_event` rows
 * in bounded batches while `isIdle()` holds. Aborting `signal` stops the
 * pass between batches and resolves with outcome "aborted"; rows deleted so
 * far stay deleted and the next pass picks up the rest.
 */
export const sweepLegacyRunEventEntries = async (
  db: SqliteDatabase,
  options: LegacyRunEventSweepOptions & { signal?: AbortSignal } = {},
): Promise<LegacyRunEventSweepResult> => {
  const { signal, ...sweepOptions } = options;
  const progress = { deleted: 0, batches: 0 };
  if (signal?.aborted) return { ...progress, outcome: "aborted" };
  const exit = await storageRuntime.runPromiseExit(
    sweepLegacyRunEventEntriesEffect(db, sweepOptions, progress),
    signal ? { signal } : undefined,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return { ...progress, outcome: "aborted" };
  }
  throw Cause.squash(exit.cause);
};
