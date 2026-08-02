import { Effect } from "effect";
import type { SqliteDatabase } from "../kernel/storage/shared.js";
import type { ConnectorFollowupDelivery } from "./connector-followup.js";
import {
  forkDelayed,
  hostRuntime,
  type HostTimerHandle,
} from "./effect-runtime.js";

export type DurableConnectorFollowupTarget = {
  requestId: string;
  backendConversationId: string;
  initialTurnCompleted: boolean;
};

export type DurableConnectorFollowupRoute = DurableConnectorFollowupTarget & {
  conversationId: string;
};

type ConnectorFollowupOutboxRow = {
  deliveryId: string;
  requestId: string;
  backendConversationId: string;
  text: string;
  attempts: number;
};

type ConnectorFollowupOutboxOptions = {
  database: SqliteDatabase;
  deliver: (entry: {
    deliveryId: string;
    requestId: string;
    backendConversationId: string;
    text: string;
  }) => Promise<void>;
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: () => number;
};

const asTarget = (
  row:
    | {
        requestId?: unknown;
        backendConversationId?: unknown;
        initialTurnCompleted?: unknown;
      }
    | undefined,
): DurableConnectorFollowupTarget | null =>
  typeof row?.requestId === "string" &&
  typeof row.backendConversationId === "string"
    ? {
        requestId: row.requestId,
        backendConversationId: row.backendConversationId,
        initialTurnCompleted: row.initialTurnCompleted === 1,
      }
    : null;

/**
 * Durable host-side admission for connector follow-ups. Convex remains the
 * delivery authority, but a row is deleted locally only after its mutation
 * ACK, so auth/network failure and process restart cannot drop terminal text.
 *
 * Structure (M5 phase 5): sqlite IS the durable queue, keyed by
 * `delivery_id` with per-row persisted attempt counts; the in-memory part is
 * a single-flight drain Effect plus one wake fiber (`forkDelayed`) armed at
 * the earliest `next_attempt_at`. The exponential backoff formula
 * (`retryBaseMs * 2^min(attempts, 8)`, capped at `retryMaxMs`) is computed
 * from the persisted attempts rather than a `Schedule` state precisely so it
 * survives process restarts with identical timing.
 */
export class ConnectorFollowupOutbox {
  private readonly database: SqliteDatabase;
  private readonly deliver: ConnectorFollowupOutboxOptions["deliver"];
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly now: () => number;
  private timer: HostTimerHandle | null = null;
  private draining = false;
  private drainPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(options: ConnectorFollowupOutboxOptions) {
    this.database = options.database;
    this.deliver = options.deliver;
    this.retryBaseMs = Math.max(10, options.retryBaseMs ?? 500);
    this.retryMaxMs = Math.max(this.retryBaseMs, options.retryMaxMs ?? 60_000);
    this.now = options.now ?? Date.now;
  }

  armTarget(args: {
    conversationId: string;
    requestId: string;
    backendConversationId: string;
  }): DurableConnectorFollowupTarget {
    const now = this.now();
    const previous = this.targetForConversation(args.conversationId);
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      if (
        previous &&
        (previous.requestId !== args.requestId ||
          previous.backendConversationId !== args.backendConversationId)
      ) {
        // Convex owns readiness, but a superseded local route must not submit
        // any terminal message that has not crossed the Convex admission
        // boundary yet.
        this.database
          .prepare(
            `DELETE FROM connector_followup_outbox
              WHERE request_id = ? AND backend_conversation_id = ?`,
          )
          .run(previous.requestId, previous.backendConversationId);
      }
      this.database
        .prepare(
          `INSERT INTO connector_followup_targets (
             conversation_id, request_id, backend_conversation_id,
             initial_turn_completed, created_at, updated_at
           ) VALUES (?, ?, ?, 0, ?, ?)
           ON CONFLICT(conversation_id) DO UPDATE SET
             request_id = excluded.request_id,
             backend_conversation_id = excluded.backend_conversation_id,
             initial_turn_completed = CASE
               WHEN connector_followup_targets.request_id = excluded.request_id
                AND connector_followup_targets.backend_conversation_id =
                    excluded.backend_conversation_id
               THEN connector_followup_targets.initial_turn_completed
               ELSE 0
             END,
             updated_at = excluded.updated_at`,
        )
        .run(
          args.conversationId,
          args.requestId,
          args.backendConversationId,
          now,
          now,
        );
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
    return (
      this.targetForConversation(args.conversationId) ?? {
        requestId: args.requestId,
        backendConversationId: args.backendConversationId,
        initialTurnCompleted: false,
      }
    );
  }

  targetForConversation(
    conversationId: string,
  ): DurableConnectorFollowupTarget | null {
    return asTarget(
      this.database
        .prepare(
          `SELECT request_id AS requestId,
                  backend_conversation_id AS backendConversationId,
                  initial_turn_completed AS initialTurnCompleted
             FROM connector_followup_targets
            WHERE conversation_id = ?`,
        )
        .get(conversationId) as
        | {
            requestId?: unknown;
            backendConversationId?: unknown;
            initialTurnCompleted?: unknown;
          }
        | undefined,
    );
  }

  routeForRequest(requestId: string): DurableConnectorFollowupRoute | null {
    const row = this.database
      .prepare(
        `SELECT conversation_id AS conversationId,
                request_id AS requestId,
                backend_conversation_id AS backendConversationId,
                initial_turn_completed AS initialTurnCompleted
           FROM connector_followup_targets
          WHERE request_id = ?
          LIMIT 1`,
      )
      .get(requestId) as
      | {
          conversationId?: unknown;
          requestId?: unknown;
          backendConversationId?: unknown;
          initialTurnCompleted?: unknown;
        }
      | undefined;
    const target = asTarget(row);
    return target && typeof row?.conversationId === "string"
      ? { conversationId: row.conversationId, ...target }
      : null;
  }

  markInitialTurnCompleted(args: {
    conversationId: string;
    requestId: string;
    backendConversationId: string;
  }): void {
    const now = this.now();
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database
        .prepare(
          `UPDATE connector_followup_targets
              SET initial_turn_completed = 1, updated_at = ?
            WHERE conversation_id = ? AND request_id = ?
              AND backend_conversation_id = ?`,
        )
        .run(
          now,
          args.conversationId,
          args.requestId,
          args.backendConversationId,
        );
      this.database
        .prepare(
          `UPDATE connector_followup_outbox
              SET eligible_at = COALESCE(eligible_at, ?),
                  next_attempt_at = MIN(next_attempt_at, ?),
                  updated_at = ?
            WHERE request_id = ? AND backend_conversation_id = ?`,
        )
        .run(now, now, now, args.requestId, args.backendConversationId);
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
    this.resume();
  }

  clearTarget(conversationId: string): void {
    const target = this.targetForConversation(conversationId);
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database
        .prepare(
          "DELETE FROM connector_followup_targets WHERE conversation_id = ?",
        )
        .run(conversationId);
      if (target) {
        this.database
          .prepare(
            `DELETE FROM connector_followup_outbox
              WHERE request_id = ? AND backend_conversation_id = ?`,
          )
          .run(target.requestId, target.backendConversationId);
      }
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  enqueue(
    target: DurableConnectorFollowupTarget,
    followup: ConnectorFollowupDelivery,
  ): { replayed: boolean } {
    const prior = this.database
      .prepare(
        `SELECT request_id AS requestId,
                backend_conversation_id AS backendConversationId,
                text
           FROM connector_followup_outbox
          WHERE delivery_id = ?`,
      )
      .get(followup.deliveryId) as
      | {
          requestId?: unknown;
          backendConversationId?: unknown;
          text?: unknown;
        }
      | undefined;
    if (prior) {
      if (
        prior.requestId !== target.requestId ||
        prior.backendConversationId !== target.backendConversationId ||
        prior.text !== followup.text
      ) {
        throw new Error(
          "Connector follow-up delivery id was reused with new payload.",
        );
      }
      return { replayed: true };
    }
    const now = this.now();
    this.database
      .prepare(
        `INSERT INTO connector_followup_outbox (
           delivery_id, request_id, backend_conversation_id, text,
           eligible_at, attempts, next_attempt_at, last_error,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)`,
      )
      .run(
        followup.deliveryId,
        target.requestId,
        target.backendConversationId,
        followup.text,
        now,
        now,
        now,
        now,
      );
    this.resume();
    return { replayed: false };
  }

  pendingCount(): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM connector_followup_outbox")
      .get() as { count?: unknown } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
  }

  resume(immediate = false): void {
    if (this.stopped) return;
    if (immediate) {
      const now = this.now();
      this.database
        .prepare(
          `UPDATE connector_followup_outbox
              SET next_attempt_at = MIN(next_attempt_at, ?), updated_at = ?
            WHERE eligible_at IS NOT NULL`,
        )
        .run(now, now);
      this.timer?.cancel();
      this.timer = null;
    }
    if (this.draining || this.timer) return;
    this.timer = forkDelayed(0, () => {
      this.timer = null;
      void this.startDrain();
    });
  }

  async drainNow(): Promise<void> {
    if (this.timer) {
      this.timer.cancel();
      this.timer = null;
    }
    await this.startDrain();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = null;
    await this.drainPromise?.catch(() => undefined);
  }

  private retryDelay(attempts: number): number {
    return Math.min(
      this.retryMaxMs,
      this.retryBaseMs * 2 ** Math.min(attempts, 8),
    );
  }

  private scheduleAt(timestamp: number): void {
    if (this.stopped || this.timer) return;
    this.timer = forkDelayed(Math.max(0, timestamp - this.now()), () => {
      this.timer = null;
      void this.startDrain();
    });
  }

  private nextReady(): ConnectorFollowupOutboxRow | null {
    const now = this.now();
    const row = this.database
      .prepare(
        `SELECT delivery_id AS deliveryId, request_id AS requestId,
                backend_conversation_id AS backendConversationId,
                text, attempts
           FROM connector_followup_outbox
          WHERE eligible_at IS NOT NULL AND next_attempt_at <= ?
          ORDER BY sequence ASC
          LIMIT 1`,
      )
      .get(now) as ConnectorFollowupOutboxRow | undefined;
    return row ?? null;
  }

  private nextRetryAt(): number | null {
    const row = this.database
      .prepare(
        `SELECT MIN(next_attempt_at) AS nextAttemptAt
           FROM connector_followup_outbox
          WHERE eligible_at IS NOT NULL`,
      )
      .get() as { nextAttemptAt?: unknown } | undefined;
    return typeof row?.nextAttemptAt === "number" ? row.nextAttemptAt : null;
  }

  private startDrain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    const work = hostRuntime.runPromise(this.drainEffect()).finally(() => {
      if (this.drainPromise === work) this.drainPromise = null;
    });
    this.drainPromise = work;
    return work;
  }

  /**
   * Single-flight drain pass: deliver ready rows in sequence order until the
   * queue is empty or a delivery fails; a failure re-arms the wake fiber at
   * the persisted `next_attempt_at` and ends the pass (identical to the old
   * promise loop's early return).
   */
  private drainEffect(): Effect.Effect<void> {
    const self = this;
    return Effect.suspend(() => {
      if (self.stopped || self.draining) return Effect.void;
      self.draining = true;
      return Effect.gen(function* () {
        while (!self.stopped) {
          const row = self.nextReady();
          if (!row) {
            const next = self.nextRetryAt();
            if (next !== null) self.scheduleAt(next);
            return;
          }
          const outcome = yield* Effect.tryPromise({
            try: () => self.deliver(row),
            catch: (error) => error,
          }).pipe(
            Effect.map(() => "delivered" as const),
            Effect.catch((error) =>
              Effect.sync(() => {
                const attempts = row.attempts + 1;
                const nextAttemptAt = self.now() + self.retryDelay(attempts);
                self.database
                  .prepare(
                    `UPDATE connector_followup_outbox
                        SET attempts = ?, next_attempt_at = ?, last_error = ?,
                            updated_at = ?
                      WHERE delivery_id = ?`,
                  )
                  .run(
                    attempts,
                    nextAttemptAt,
                    error instanceof Error
                      ? error.message.slice(0, 500)
                      : String(error).slice(0, 500),
                    self.now(),
                    row.deliveryId,
                  );
                self.scheduleAt(nextAttemptAt);
                return "failed" as const;
              }),
            ),
          );
          if (outcome === "failed") return;
          self.database
            .prepare(
              "DELETE FROM connector_followup_outbox WHERE delivery_id = ?",
            )
            .run(row.deliveryId);
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            self.draining = false;
          }),
        ),
      );
    });
  }
}
