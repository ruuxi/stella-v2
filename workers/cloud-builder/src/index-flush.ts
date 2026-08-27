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
 * Every write is fenced on `(epoch, lastSeq)` so a retried or reordered flush
 * is dropped as stale rather than moving the row backwards. Failure is never
 * fatal: `meta.index_synced_seq` remembers how far Convex actually got, and
 * the next turn end or socket connect catches it up. An index that lags is a
 * degraded conversation list and a degraded Recall — never a failed turn.
 */

import {
  EXCERPT_FLUSH_BATCH,
  PREVIEW_MAX_CHARS,
  type ConversationLogger,
} from "./conversation-types.js";
import type { Journal } from "./journal.js";

const FLUSH_TIMEOUT_MS = 15_000;
const FLUSH_ATTEMPTS = 3;
/**
 * How many `EXCERPT_FLUSH_BATCH`-sized batches one flush will ship before it
 * yields. A cap rather than "until drained" because this runs at the end of a
 * turn and on socket connect: a conversation whose whole index was lost must
 * not turn the next turn end into a hundred sequential round trips. Whatever
 * is left keeps `lagging()` true, so the next turn end or connect continues
 * from where this stopped — the drain is resumable, not one-shot.
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

type IndexVerdict = {
  accepted: boolean;
  excerptsAccepted: boolean;
  reason?: string;
  lastSeq: number;
  epoch: number;
};

/**
 * A 2xx is delivery, not acceptance. Only the complete, typed Convex verdict
 * may advance either local projection cursor; HTML from a proxy, an empty
 * response, or a drifted deployment must fail closed and remain retryable.
 */
const readVerdict = async (
  response: Response,
): Promise<IndexVerdict | null> => {
  try {
    const payload = (await response.json()) as Partial<IndexVerdict> | null;
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof payload.accepted !== "boolean" ||
      typeof payload.excerptsAccepted !== "boolean" ||
      !Number.isSafeInteger(payload.lastSeq) ||
      !Number.isSafeInteger(payload.epoch) ||
      (payload.reason !== undefined && typeof payload.reason !== "string")
    ) {
      return null;
    }
    return payload as IndexVerdict;
  } catch {
    return null;
  }
};

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
  /** The Convex index row took this flush's `(epoch, lastSeq)`. */
  accepted: boolean;
  /** Turn excerpts still owed to Convex when this flush stopped. */
  pendingExcerpts: number;
};

/** What one POST to `/api/cloud/index` reported back. */
type BatchOutcome = {
  /** A verdict came back at all — false means transport or contract failure. */
  delivered: boolean;
  accepted: boolean;
  excerptsAccepted: boolean;
};

/**
 * How a flush learns its conversation died underneath it.
 *
 * `purged()` is the session's own fence (durable tombstone OR the in-memory
 * seal that outlives the `deleteAll()` which destroys it). It is checked before
 * every POST rather than once at the top, because a flush is a retry ladder
 * that can outlive the purge that started while it was waiting.
 *
 * `onPurged()` closes the other direction: Convex refusing a flush because the
 * conversation id is fenced is proof this object is dead, and an isolate that
 * missed the purge — because it never got the request, or because it was
 * restarted since — has no other way to find out.
 *
 * Neither is the guarantee. Both are per-isolate and best-effort; the fence
 * that actually holds is the tombstone row Convex checks in
 * `upsertConversationIndexInternal`. These just stop the DO wasting a ladder on
 * writes that are going to be refused.
 */
export type IndexDeletionFence = {
  purged: () => boolean;
  onPurged: () => void;
};

export class ConversationIndex {
  private inFlight: Promise<IndexFlushResult> | null = null;

  constructor(
    private readonly journal: Journal,
    private readonly log: ConversationLogger,
    private readonly resolveEndpoint: () => {
      base: string;
      secret: string;
      ownerGeneration: string;
    } | null,
    private readonly fence: IndexDeletionFence,
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
    const endpoint = this.resolveEndpoint();
    const meta = this.journal.meta();
    const idle = { accepted: false, pendingExcerpts: 0 };
    if (!endpoint || !meta.owner_id || !meta.conversation_id) return idle;
    if (meta.deleted_at !== null || this.fence.purged()) return idle;
    if (options.force) this.journal.markAllExcerptsUnsynced();

    const lastSeq = meta.next_seq - 1;
    const preview = this.journal.lastPreview(PREVIEW_MAX_CHARS);
    const maxBatches = Math.max(1, options.maxBatches ?? EXCERPT_MAX_BATCHES);
    const deadline = Date.now() + (options.budgetMs ?? EXCERPT_DRAIN_BUDGET_MS);
    let accepted = false;

    // One POST carries the index row plus at most EXCERPT_FLUSH_BATCH
    // excerpts, so a conversation owing more than that needs more than one.
    // Sending one and stamping `index_synced_seq` at head — which is what this
    // used to do — leaves every remaining turn out of Recall with nothing left
    // that thinks it is behind. Only the first POST can move the fence; the
    // rest are refused as stale and land their excerpts anyway, which is
    // exactly the contract `excerptsAccepted` exists to express.
    for (let batch = 0; batch < maxBatches; batch += 1) {
      // Re-read the fence every batch. `meta` was snapshotted above and a
      // purge that lands mid-drain leaves it stale — the next batch would ship
      // the excerpts of a conversation whose storage is already gone.
      if (this.fence.purged()) break;
      const excerpts = this.journal.unsyncedExcerpts(EXCERPT_FLUSH_BATCH);
      const outcome = await this.post(
        endpoint,
        {
          conversationId: meta.conversation_id,
          ownerId: meta.owner_id,
          ownerGeneration: endpoint.ownerGeneration,
          epoch: meta.epoch,
          lastSeq,
          updatedAt: options.updatedAt,
          createdAt: meta.created_at > 0 ? meta.created_at : undefined,
          title: meta.title || undefined,
          lastPreview: preview?.text,
          lastRole: preview?.role,
          activity: options.activity,
          force: batch === 0 && options.force === true ? true : undefined,
          excerpts: excerpts.map((row) => ({
            turnId: row.turn_id,
            seqStart: row.seq_start,
            seqEnd: row.seq_end,
            text: row.text,
            createdAt: row.created_at,
          })),
        },
        excerpts,
        lastSeq,
        meta.epoch,
      );
      if (batch === 0) accepted = outcome.accepted;
      // A refusal that did not store the excerpts (unknown row, owner
      // mismatch, tombstone) will refuse the next batch identically. Stop
      // rather than spend the whole budget learning the same thing 20 times.
      if (!outcome.delivered || !outcome.excerptsAccepted) break;
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

  private async post(
    endpoint: { base: string; secret: string },
    body: unknown,
    excerpts: Array<{ turn_id: string }>,
    lastSeq: number,
    epoch: number,
  ): Promise<BatchOutcome> {
    for (let attempt = 1; attempt <= FLUSH_ATTEMPTS; attempt += 1) {
      // The retry is the window. Attempt 1 can leave here with the
      // conversation live, spend 15 s on a timeout or a 502, and come back to
      // a conversation whose DO storage — and whose owner — have been deleted
      // in the meantime. Ask again on every rung, not once at the top.
      if (this.fence.purged()) {
        return { delivered: false, accepted: false, excerptsAccepted: false };
      }
      try {
        const response = await fetch(
          `${endpoint.base.replace(/\/+$/, "")}/api/cloud/index`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${endpoint.secret}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
          },
        );
        if (response.ok) {
          // Convex always answers 200 with a verdict, including for a refusal:
          // a 4xx would make a stale fence indistinguishable from a contract
          // bug. Read the verdict rather than assuming 2xx meant "stored".
          const verdict = await readVerdict(response);
          if (!verdict) {
            if (attempt === FLUSH_ATTEMPTS) {
              this.log("error", "conversation_index_invalid_verdict", {
                lastSeq,
                excerpts: excerpts.length,
              });
            }
            // Stay on the retry ladder. In particular, do not stamp
            // `index_synced_seq` or clear excerpt sync bits merely because an
            // intermediary returned 200.
            if (attempt < FLUSH_ATTEMPTS) {
              await new Promise((resolve) =>
                setTimeout(resolve, 250 * attempt),
              );
            }
            continue;
          }
          // Convex refuses a flush for a conversation id it has fenced as
          // purged. That is not a stale write to converge on — it is proof
          // this object is dead, and the isolate that is asking may never have
          // seen the purge request at all. Seal it here so the rest of this
          // drain, and every later write path, stops. Nothing is marked synced
          // and no seq is recorded: there is no longer a row to be behind.
          if (verdict.reason === "purged") {
            this.log("error", "conversation_index_purged", {
              lastSeq,
              excerpts: excerpts.length,
            });
            this.fence.onPurged();
            return {
              delivered: true,
              accepted: false,
              excerptsAccepted: false,
            };
          }
          // A rewind can commit while this request is in flight. Convex fences
          // the old epoch, but the local cursor needs the same fence: letting
          // this old response stamp `index_synced_seq` above the new, shorter
          // head would make the first message on the new branch look synced
          // and suppress its projection indefinitely.
          if (this.journal.meta().epoch !== epoch) {
            return {
              delivered: true,
              accepted: false,
              excerptsAccepted: false,
            };
          }
          // The fence may have rejected this flush as stale, in which case the
          // row is already ahead of us and `index_synced_seq` is honest as a
          // floor. It only ever gates whether we bother trying again, so the
          // row's own `lastSeq` is the better floor when it is ahead.
          this.journal.setIndexSyncedSeq(
            verdict.lastSeq > lastSeq ? verdict.lastSeq : lastSeq,
          );
          // Only clear `synced` when Convex says it wrote them. A refusal that
          // still landed the excerpts reports `excerptsAccepted: true`; one that
          // did not (unknown row, owner mismatch, tombstone) reports false, and
          // marking those synced would drop them from Recall permanently.
          const excerptsAccepted = verdict.excerptsAccepted;
          if (excerptsAccepted) {
            this.journal.markExcerptsSynced(excerpts.map((row) => row.turn_id));
          } else if (excerpts.length > 0) {
            this.log("error", "conversation_excerpts_refused", {
              reason: verdict.reason ?? "unknown",
              excerpts: excerpts.length,
            });
          }
          return {
            delivered: true,
            accepted: verdict.accepted,
            excerptsAccepted,
          };
        }
        // 4xx is a contract mismatch; retrying it is just noise.
        if (response.status < 500 && response.status !== 429) {
          this.log("error", "conversation_index_rejected", {
            status: response.status,
            lastSeq,
          });
          return { delivered: false, accepted: false, excerptsAccepted: false };
        }
      } catch (error) {
        if (attempt === FLUSH_ATTEMPTS) {
          this.log("error", "conversation_index_flush_failed", {
            lastSeq,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (attempt < FLUSH_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
    return { delivered: false, accepted: false, excerptsAccepted: false };
  }
}
