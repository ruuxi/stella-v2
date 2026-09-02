/**
 * The Convex-side list projection of a DO-resident conversation.
 *
 * Convex keeps one derived row because a per-conversation Durable Object
 * cannot list an owner's conversations. Full-text search stays inside the
 * object. Each `conversation.index` event is fenced on `(epoch, lastSeq)` so
 * reordered delivery cannot move the row backwards. Once the durable outbox
 * accepts an event, `meta.index_synced_seq` advances; a later turn boundary or
 * socket connect retries a refused enqueue.
 */

import {
  OUTBOX_EVENT_VERSION,
  type ConversationIndexEvent,
  type OutboxEvent,
} from "@stella/contracts/turn-plane/outbox";
import {
  PREVIEW_MAX_CHARS,
  type ConversationLogger,
} from "./conversation-types.js";
import type { Journal } from "./journal.js";

export type IndexFlushOptions = {
  activity: "idle" | "running";
  updatedAt: number;
};

export type IndexFlushResult = {
  /** The index row event for this flush's `(epoch, lastSeq)` was enqueued. */
  accepted: boolean;
};

/** Who the projection belongs to; null until the conversation is bound. */
export type IndexIdentity = {
  ownerId: string;
  ownerGeneration: string;
};

export type IndexFlushDeps = {
  /** Append to the outbox; throws when the queue refused. */
  enqueue: (events: OutboxEvent[]) => Promise<void>;
  /** The durable tombstone or in-memory seal that survives `deleteAll()`. */
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

  /** True when the owner-list row is behind the canonical journal head. */
  lagging(): boolean {
    const meta = this.journal.meta();
    return meta.index_synced_seq < meta.next_seq - 1;
  }

  /** Turn end and socket connect share one enqueue when they race. */
  flush(options: IndexFlushOptions): Promise<IndexFlushResult> {
    if (this.inFlight) return this.inFlight;
    const tracked = this.run(options).finally(() => {
      if (this.inFlight === tracked) this.inFlight = null;
    });
    this.inFlight = tracked;
    return tracked;
  }

  private async run(options: IndexFlushOptions): Promise<IndexFlushResult> {
    const identity = this.resolveIdentity();
    const meta = this.journal.meta();
    const idle = { accepted: false };
    if (!identity || !meta.owner_id || !meta.conversation_id) return idle;
    if (meta.deleted_at !== null || this.deps.purged()) return idle;

    const lastSeq = meta.next_seq - 1;
    const preview = this.journal.lastPreview(PREVIEW_MAX_CHARS);
    const event: ConversationIndexEvent = {
      v: OUTBOX_EVENT_VERSION,
      kind: "conversation.index",
      key: `${meta.conversation_id}:${meta.epoch}:${lastSeq}:${options.updatedAt}`,
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
    };
    try {
      await this.deps.enqueue([event]);
    } catch (error) {
      this.log("error", "conversation_index_enqueue_failed", {
        lastSeq,
        message: error instanceof Error ? error.message : String(error),
      });
      return idle;
    }

    // A rewind may commit while the send is in flight. Convex drops the stale
    // epoch, and the local cursor must not suppress the first row on the branch.
    if (this.journal.meta().epoch !== meta.epoch || this.deps.purged()) {
      return idle;
    }
    this.journal.setIndexSyncedSeq(lastSeq);
    return { accepted: true };
  }
}
