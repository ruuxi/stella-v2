/**
 * The Convex-side projection of a DO-resident conversation.
 *
 * Two slices stay relational because a per-conversation Durable Object cannot
 * answer either question: "list my conversations" (the index row) and "search
 * everything I have ever said" (the per-turn excerpt, full-text indexed).
 * Both are DERIVED. Nothing in Convex may read a DO-owned field and act on it
 * as truth, and both are regenerable from this object — the excerpt mirror in
 * `turn_excerpts` exists precisely so a reindex never has to read R2.
 *
 * The projection travels as `conversation.index` outbox events. Every event
 * is fenced on `(epoch, lastSeq)` on the Convex side so a reordered delivery
 * is dropped as stale rather than moving the row backwards, and every event
 * carries the excerpts it ships so a delivery that loses the fence still
 * lands them. Enqueueing is the delivery: the queue is durable, so once
 * `sendBatch` returns the local cursors advance. Failure is never fatal:
 * `meta.index_synced_seq` remembers how far the outbox got, and the next turn
 * end or socket connect catches it up. An index that lags is a degraded
 * conversation list and a degraded Recall — never a failed turn.
 */

import {
  OUTBOX_EVENT_VERSION,
  type ConversationIndexEvent,
  type OutboxEvent,
} from "@stella/contracts/turn-plane/outbox";
import {
  EXCERPT_FLUSH_BATCH,
  PREVIEW_MAX_CHARS,
  type ConversationLogger,
} from "./conversation-types.js";
import type { Journal } from "./journal.js";

/**
 * How many `EXCERPT_FLUSH_BATCH`-sized batches one flush will ship before it
 * yields. A cap rather than "until drained" because this runs at the end of a
 * turn and on socket connect: a conversation whose whole index was lost must
 * not turn the next turn end into a hundred sequential sends. Whatever is
 * left keeps `lagging()` true, so the next turn end or connect continues from
 * where this stopped — the drain is resumable, not one-shot.
 */
const EXCERPT_MAX_BATCHES = 20;
/** Wall-clock ceiling on that drain, for the same reason. */
const EXCERPT_DRAIN_BUDGET_MS = 20_000;
/**
 * What `/reindex` gets instead. It is an operator call on a conversation whose
 * search projection is known to be gone, it holds nothing else up, and its
 * whole job is to finish — so it may spend far more than a turn end.
 */
export const REINDEX_MAX_BATCHES = 200;
export const REINDEX_BUDGET_MS = 45_000;

export type IndexFlushOptions = {
  activity: "idle" | "running";
  updatedAt: number;
  /** Replays every excerpt regardless of `synced`, and overrides the fence. */
  force?: boolean;
  /** Excerpt batches this flush may ship. Defaults to the turn-end budget. */
  maxBatches?: number;
  /** Wall-clock ceiling on the excerpt drain. Defaults to the turn-end budget. */
  budgetMs?: number;
};

export type IndexFlushResult = {
  /** The index row event for this flush's `(epoch, lastSeq)` was enqueued. */
  accepted: boolean;
  /** Turn excerpts still owed to Convex when this flush stopped. */
  pendingExcerpts: number;
};

/** Who the projection belongs to; null until the conversation is bound. */
export type IndexIdentity = {
  ownerId: string;
  ownerGeneration: string;
};

export type IndexFlushDeps = {
  /** Append to the outbox; throws when the queue refused. */
  enqueue: (events: OutboxEvent[]) => Promise<void>;
  /**
   * The session's own deletion fence (durable tombstone OR the in-memory seal
   * that outlives the `deleteAll()` which destroys it). Checked before every
   * send rather than once at the top, because a drain yields between batches
   * and can outlive the purge that started while it was waiting.
   */
  purged: () => boolean;
};

export class ConversationIndex {
  private inFlight: Promise<IndexFlushResult> | null = null;

  constructor(
    private readonly journal: Journal,
    private readonly log: ConversationLogger,
    private readonly resolveIdentity: () => IndexIdentity | null,
    private readonly deps: IndexFlushDeps,
  ) {}

  /**
   * True when Convex is behind the journal and a flush would do something.
   *
   * Both halves matter. `index_synced_seq` covers the sidebar row; the
   * unsynced excerpt count covers Recall, and it is the only thing that keeps
   * a multi-batch backlog draining — a flush that ships one batch and stamps
   * the row at head is caught up on the row and still missing every turn it
   * had no room for.
   */
  lagging(): boolean {
    const meta = this.journal.meta();
    if (meta.index_synced_seq < meta.next_seq - 1) return true;
    return this.journal.unsyncedExcerptCount() > 0;
  }

  /**
   * Single-flighted: turn end and a socket connect can both ask at once, and
   * two concurrent flushes would race the fence for no benefit.
   *
   * A forced flush is the one call that cannot be answered by a flush already
   * running. `force` means "replay every excerpt", and a flush that started
   * without it never will — so handing back its promise reported `/reindex` as
   * complete having replayed nothing, on a conversation whose whole search
   * projection was known to be missing. Those callers queue behind the running
   * flush and then do their own work instead.
   */
  flush(options: IndexFlushOptions): Promise<IndexFlushResult> {
    const running = this.inFlight;
    if (running && !options.force) return running;
    // The rejection is the running flush's to report, not this one's: `run`
    // resolves with a result either way, and a queued caller must not inherit a
    // failure it had no part in.
    const queued = running
      ? running.then(
          () => this.run(options),
          () => this.run(options),
        )
      : this.run(options);
    const tracked = queued.finally(() => {
      if (this.inFlight === tracked) this.inFlight = null;
    });
    this.inFlight = tracked;
    return tracked;
  }

  private async run(options: IndexFlushOptions): Promise<IndexFlushResult> {
    const identity = this.resolveIdentity();
    const meta = this.journal.meta();
    const idle = { accepted: false, pendingExcerpts: 0 };
    if (!identity || !meta.owner_id || !meta.conversation_id) return idle;
    if (meta.deleted_at !== null || this.deps.purged()) return idle;
    if (options.force) this.journal.markAllExcerptsUnsynced();

    const lastSeq = meta.next_seq - 1;
    const preview = this.journal.lastPreview(PREVIEW_MAX_CHARS);
    const maxBatches = Math.max(1, options.maxBatches ?? EXCERPT_MAX_BATCHES);
    const deadline = Date.now() + (options.budgetMs ?? EXCERPT_DRAIN_BUDGET_MS);
    let accepted = false;

    // One event carries the index row plus at most EXCERPT_FLUSH_BATCH
    // excerpts, so a conversation owing more than that needs more than one.
    // Sending one and stamping `index_synced_seq` at head — which is what this
    // used to do — leaves every remaining turn out of Recall with nothing left
    // that thinks it is behind. Every event repeats the same `(epoch,
    // lastSeq)`; Convex takes the row from whichever lands first and the
    // excerpts from all of them.
    for (let batch = 0; batch < maxBatches; batch += 1) {
      // Re-read the fence every batch. `meta` was snapshotted above and a
      // purge that lands mid-drain leaves it stale — the next batch would ship
      // the excerpts of a conversation whose storage is already gone.
      if (this.deps.purged()) break;
      const excerpts = this.journal.unsyncedExcerpts(EXCERPT_FLUSH_BATCH);
      const event: ConversationIndexEvent = {
        v: OUTBOX_EVENT_VERSION,
        kind: "conversation.index",
        // Unique per flush and batch: two flushes at the same head (a title
        // set, activity flipping, a forced reindex) must both reach Convex,
        // and the (epoch, lastSeq) fence there decides which one moves the row.
        key: `${meta.conversation_id}:${meta.epoch}:${lastSeq}:${options.updatedAt}:${batch}`,
        ownerId: identity.ownerId,
        ownerGeneration: identity.ownerGeneration,
        emittedAt: Date.now(),
        conversationId: meta.conversation_id,
        epoch: meta.epoch,
        lastSeq,
        updatedAt: options.updatedAt,
        ...(meta.created_at > 0 ? { createdAt: meta.created_at } : {}),
        ...(meta.title ? { title: meta.title } : {}),
        ...(preview ? { lastPreview: preview.text, lastRole: preview.role } : {}),
        activity: options.activity,
        excerpts: excerpts.map((row) => ({
          turnId: row.turn_id,
          seqStart: row.seq_start,
          seqEnd: row.seq_end,
          text: row.text,
          createdAt: row.created_at,
        })),
        ...(batch === 0 && options.force === true ? { force: true } : {}),
      };
      try {
        await this.deps.enqueue([event]);
      } catch (error) {
        this.log("error", "conversation_index_enqueue_failed", {
          lastSeq,
          excerpts: excerpts.length,
          message: error instanceof Error ? error.message : String(error),
        });
        break;
      }
      // A rewind can commit while the send is in flight. Convex fences the old
      // epoch, but the local cursor needs the same fence: letting this old
      // flush stamp `index_synced_seq` above the new, shorter head would make
      // the first message on the new branch look synced and suppress its
      // projection indefinitely.
      if (this.journal.meta().epoch !== meta.epoch) break;
      if (batch === 0) {
        accepted = true;
        this.journal.setIndexSyncedSeq(lastSeq);
      }
      this.journal.markExcerptsSynced(excerpts.map((row) => row.turn_id));
      if (excerpts.length < EXCERPT_FLUSH_BATCH) break;
      if (Date.now() >= deadline) break;
    }

    const pendingExcerpts = this.journal.unsyncedExcerptCount();
    if (pendingExcerpts > 0) {
      this.log("info", "conversation_excerpts_pending", {
        conversationId: meta.conversation_id,
        pendingExcerpts,
      });
    }
    return { accepted, pendingExcerpts };
  }
}
