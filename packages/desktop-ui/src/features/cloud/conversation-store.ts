/**
 * The rendered state of one cloud conversation, reduced from the socket's
 * ordered record stream.
 *
 * Nothing here is authoritative. The Durable Object owns the transcript; this
 * is a view of it that lives in renderer memory and is discarded on quit. In
 * particular, desktop's local SQLite is never written from here — a writable
 * second copy would be a second authority.
 *
 * Two stores, on purpose:
 *  - `conversationStore(id, accountScope)` is per owner + conversation and
 *    owns its socket.
 *  - `pendingPrompts` is account-scoped global state, because the very first
 *    prompt of a session is sent before any conversation exists to file it
 *    under.
 */

import { getConvexToken } from "@/global/auth/services/auth-token";
import {
  BACKFILL_BATCH_RECORDS,
  LIVE_PARTIAL_MAX_CHARS,
  MAX_CLIENT_RECORDS,
  type JournalRecord,
} from "./conversation-protocol";
import {
  ConversationSocket,
  type ConversationSocketEvent,
  type SocketStatus,
} from "./conversation-socket";
import type { CloudAttachment } from "./cloud-composer-store";

export type PendingCloudTurnSubmission = {
  /** Exact model-visible prompt; retries must not redecorate it. */
  prompt: string;
  /** Exact image paths sent with the idempotent mutation. */
  imagePaths: readonly string[];
  /** Immutable composer snapshot used for guarded post-success clearing. */
  attachments: readonly CloudAttachment[];
};

export type PendingPrompt = {
  /** Immutable auth subject scope that owns this optimistic row. */
  accountScope: string;
  clientMsgId: string;
  text: string;
  createdAtMs: number;
  /** Null until the mutation answers; the first prompt creates its own. */
  conversationId: string | null;
  /** Null until the mutation answers. Second resolution key, see below. */
  turnId: string | null;
  /** Set when the send failed; the row stays visible with a readable reason. */
  error: string | null;
  /** Frozen wire payload reused byte-for-byte by Retry. */
  submission: PendingCloudTurnSubmission;
};

export type LiveStream = {
  turnId: string;
  streamId: string;
  text: string;
  /** The tool currently running, for the working label. */
  toolName: string | null;
  toolLabel: string | null;
  /** True once the server stopped sending deltas for this turn. */
  dropped: boolean;
};

export type ConversationState = {
  conversationId: string;
  status: SocketStatus;
  statusMessage: string | null;
  statusRetryable: boolean;
  /** Durable journal generation reported by the DO; null before `ready`. */
  epoch: number | null;
  /** DO head observed by the socket, including opaque/skipped records. */
  headSeq: number;
  /** Ascending by `seq`, contiguous. */
  records: readonly JournalRecord[];
  live: LiveStream | null;
  title: string;
  /** Lowest seq that still exists. Nothing below it is ever fetchable. */
  floorSeq: number;
  /** True while records exist below the oldest one loaded. */
  hasOlder: boolean;
  loadingOlder: boolean;
  /** Why scrollback stopped, when it stopped for a reason worth saying. */
  olderNotice: string | null;
};

const EMPTY_RECORDS: readonly JournalRecord[] = [];

const initialState = (conversationId: string): ConversationState => ({
  conversationId,
  status: "idle",
  statusMessage: null,
  statusRetryable: true,
  epoch: null,
  headSeq: -1,
  records: EMPTY_RECORDS,
  live: null,
  title: "",
  floorSeq: 0,
  hasOlder: false,
  loadingOlder: false,
  olderNotice: null,
});

// ---------------------------------------------------------------- pending

const pendingListeners = new Set<() => void>();
let pending: readonly PendingPrompt[] = [];
const EMPTY_PENDING: readonly PendingPrompt[] = [];

const emitPending = (next: readonly PendingPrompt[]): void => {
  pending = next;
  for (const listener of pendingListeners) listener();
};

/**
 * Optimistic prompts. A prompt is echoed the instant the user sends it and
 * replaced by the canonical journal row when it arrives — resolved on either
 * `clientMsgId` (the key the mutation threads to the DO) or `turnId` (which
 * the mutation returns directly). Two keys because either one alone leaves a
 * ghost bubble if a link in the chain drops its field.
 */
export const pendingPrompts = {
  subscribe(listener: () => void): () => void {
    pendingListeners.add(listener);
    return () => pendingListeners.delete(listener);
  },
  getSnapshot(): readonly PendingPrompt[] {
    return pending;
  },
  add(
    accountScope: string,
    clientMsgId: string,
    text: string,
    conversationId: string | null,
    submission: PendingCloudTurnSubmission,
  ): void {
    emitPending([
      ...pending,
      {
        accountScope,
        clientMsgId,
        text,
        createdAtMs: Date.now(),
        conversationId,
        turnId: null,
        error: null,
        submission,
      },
    ]);
  },
  /** The mutation answered: we now know where the prompt landed. */
  bind(
    accountScope: string,
    clientMsgId: string,
    conversationId: string,
    turnId: string,
  ): void {
    emitPending(
      pending.map((entry) =>
        entry.accountScope === accountScope && entry.clientMsgId === clientMsgId
          ? { ...entry, conversationId, turnId }
          : entry,
      ),
    );
  },
  fail(accountScope: string, clientMsgId: string, message: string): void {
    emitPending(
      pending.map((entry) =>
        entry.accountScope === accountScope && entry.clientMsgId === clientMsgId
          ? { ...entry, error: message }
          : entry,
      ),
    );
  },
  drop(accountScope: string, clientMsgId: string): void {
    const next = pending.filter(
      (entry) =>
        entry.accountScope !== accountScope ||
        entry.clientMsgId !== clientMsgId,
    );
    if (next.length !== pending.length) emitPending(next);
  },
  /** Re-arms a failed echo for another attempt. */
  clearError(accountScope: string, clientMsgId: string): void {
    emitPending(
      pending.map((entry) =>
        entry.accountScope === accountScope && entry.clientMsgId === clientMsgId
          ? { ...entry, error: null }
          : entry,
      ),
    );
  },
  /** Retires any echo the given canonical record supersedes. */
  resolve(accountScope: string, record: JournalRecord): void {
    if (!pending.length) return;
    const clientMsgId =
      record.kind === "message" ? record.clientMsgId : undefined;
    const next = pending.filter(
      (entry) =>
        entry.accountScope !== accountScope ||
        !(
          (clientMsgId !== undefined && entry.clientMsgId === clientMsgId) ||
          (entry.turnId !== null && entry.turnId === record.turnId)
        ),
    );
    if (next.length !== pending.length) emitPending(next);
  },
  getServerSnapshot(): readonly PendingPrompt[] {
    return EMPTY_PENDING;
  },
  retainAccountScope(accountScope: string): void {
    const next = pending.filter((entry) => entry.accountScope === accountScope);
    if (next.length !== pending.length) emitPending(next);
  },
};

// ----------------------------------------------------------------- store

/** How long a scrollback request may sit unanswered before the spinner stops. */
const OLDER_TIMEOUT_MS = 15_000;
/** How long the socket outlives its last watcher, to survive a remount. */
const TEARDOWN_GRACE_MS = 5_000;

class ConversationStore {
  readonly conversationId: string;
  readonly accountScope: string;
  private state: ConversationState;
  private readonly listeners = new Set<() => void>();
  private socket: ConversationSocket | null = null;
  private subscribers = 0;
  private baseUrl: string | null = null;
  private olderTimer: ReturnType<typeof setTimeout> | null = null;
  private teardownTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(conversationId: string, accountScope: string) {
    this.conversationId = conversationId;
    this.accountScope = accountScope;
    this.state = initialState(conversationId);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.subscribers += 1;
    if (this.teardownTimer) {
      clearTimeout(this.teardownTimer);
      this.teardownTimer = null;
    }
    this.ensureSocket();
    return () => {
      this.listeners.delete(listener);
      this.subscribers -= 1;
      if (this.subscribers > 0) return;
      // Debounced: React remounts (StrictMode, a route change and back) would
      // otherwise close the socket and reopen one with no cursor, which is the
      // slow path and the only way to lose the resume point.
      if (this.teardownTimer) clearTimeout(this.teardownTimer);
      this.teardownTimer = setTimeout(() => {
        this.teardownTimer = null;
        if (this.subscribers <= 0) this.teardown();
      }, TEARDOWN_GRACE_MS);
    };
  };

  getSnapshot = (): ConversationState => this.state;

  /**
   * The builder origin arrives from Convex, asynchronously and possibly after
   * the first render. Setting it is what actually opens the socket.
   * `resolved` separates "still loading" from "this deployment has none",
   * which are the same `null` but very different things to show a user.
   */
  setConfig(baseUrl: string | null, resolved: boolean): void {
    const next = baseUrl?.replace(/\/+$/, "") || null;
    if (next !== this.baseUrl) {
      this.baseUrl = next;
      if (this.socket) {
        this.socket.stop();
        this.socket = null;
      }
      this.ensureSocket();
    }
    if (!next && resolved && this.state.status !== "blocked") {
      this.patch({
        status: "blocked",
        statusMessage: "Live cloud chat isn't available on this deployment.",
        statusRetryable: false,
      });
    }
  }

  /** True when nothing is watching, so the registry may forget it. */
  get idle(): boolean {
    return this.subscribers <= 0;
  }

  retry(): void {
    this.socket?.retryNow();
  }

  /**
   * Drops the renderer projection after a successful epoch-changing mutation.
   * Reconnect from an empty cursor so the next paint can only come from the
   * new canonical generation; stale rows are never kept as a local fallback.
   */
  refreshAfterCanonicalMutation(): void {
    this.socket?.stop();
    this.socket = null;
    this.patch({
      status: "idle",
      statusMessage: null,
      statusRetryable: true,
      epoch: null,
      headSeq: -1,
      records: EMPTY_RECORDS,
      live: null,
      hasOlder: false,
      loadingOlder: false,
      olderNotice: null,
    });
    this.ensureSocket();
  }

  /** Immediately retires an old auth subject's socket and rendered state. */
  retireAuthority(): void {
    this.socket?.stop();
    this.socket = null;
    this.baseUrl = null;
    if (this.olderTimer) clearTimeout(this.olderTimer);
    this.olderTimer = null;
    this.state = initialState(this.conversationId);
    this.emit();
  }

  /** False when there is no live socket to carry the stop through. */
  cancelTurn(turnId: string): boolean {
    return this.socket?.cancelTurn(turnId) ?? false;
  }

  wake(): void {
    this.socket?.wake();
  }

  loadOlder(): void {
    if (this.state.loadingOlder || !this.state.hasOlder) return;
    const oldest = this.state.records[0]?.seq;
    if (oldest === undefined || oldest <= this.state.floorSeq) {
      this.patch({ hasOlder: false });
      return;
    }
    // The renderer holds a bounded number of records; the server holds all of
    // them. Say which limit was hit rather than leaving a button that does
    // nothing, and never grow the array without bound to avoid saying it.
    if (
      this.state.records.length + BACKFILL_BATCH_RECORDS >
      MAX_CLIENT_RECORDS
    ) {
      this.patch({
        hasOlder: false,
        olderNotice:
          "That's as far back as this view holds — reload to go further.",
      });
      return;
    }
    if (!this.socket?.requestOlder(oldest)) return;
    this.patch({ loadingOlder: true });
    if (this.olderTimer) clearTimeout(this.olderTimer);
    this.olderTimer = setTimeout(() => {
      this.olderTimer = null;
      if (this.state.loadingOlder) this.patch({ loadingOlder: false });
    }, OLDER_TIMEOUT_MS);
  }

  private ensureSocket(): void {
    if (this.socket || this.subscribers <= 0 || !this.baseUrl) return;
    this.socket = new ConversationSocket({
      conversationId: this.conversationId,
      baseUrl: this.baseUrl,
      getToken: (options) => getConvexToken(options ?? {}),
      onEvent: (event) => this.onEvent(event),
    });
    this.socket.start();
  }

  private teardown(): void {
    this.socket?.stop();
    this.socket = null;
    if (this.olderTimer) clearTimeout(this.olderTimer);
    this.olderTimer = null;
    // Records stay: remounting the same conversation should not blank the
    // view, and the socket resumes from the cursor it kept.
    this.patch({ status: "idle", live: null, loadingOlder: false });
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private patch(next: Partial<ConversationState>): void {
    this.state = { ...this.state, ...next };
    this.emit();
  }

  private onEvent(event: ConversationSocketEvent): void {
    switch (event.type) {
      case "status": {
        const message = event.message ?? null;
        if (
          this.state.status === event.status &&
          this.state.statusMessage === message &&
          this.state.statusRetryable === event.retryable
        ) {
          return;
        }
        this.patch({
          status: event.status,
          statusMessage: message,
          statusRetryable: event.retryable,
        });
        return;
      }
      case "ready": {
        const live = event.ready.live;
        const oldest = this.state.records[0]?.seq ?? event.ready.windowStartSeq;
        this.patch({
          title: event.ready.title,
          epoch: event.ready.epoch,
          headSeq: event.ready.headSeq,
          floorSeq: event.ready.floorSeq,
          hasOlder: oldest > event.ready.floorSeq,
          live: live
            ? {
                turnId: live.turnId,
                streamId: live.streamId,
                text: live.partialText,
                toolName: live.tools.at(-1)?.name ?? null,
                toolLabel: live.tools.at(-1)?.label ?? null,
                dropped: false,
              }
            : null,
        });
        return;
      }
      case "records":
        this.appendRecords(event.records);
        return;
      case "older":
        this.prependRecords(event.records);
        return;
      case "reset":
        this.patch({
          records: EMPTY_RECORDS,
          live: null,
          epoch: null,
          headSeq: -1,
          hasOlder: false,
          loadingOlder: false,
          olderNotice: null,
        });
        return;
      case "gap":
        // Named, not silent: everything below the reported range is gone from
        // the hot window but reachable, so scrollback stays offered.
        this.patch({ hasOlder: true });
        return;
      case "delta":
        this.applyDelta(event.turnId, event.streamId, event.kind, event.text);
        return;
      case "tool":
        this.applyTool(event.turnId, event.name, event.label, event.phase);
        return;
      case "deltas_dropped":
        if (this.state.live?.streamId === event.streamId) {
          this.patch({ live: { ...this.state.live, dropped: true } });
        }
        return;
    }
  }

  private appendRecords(incoming: readonly JournalRecord[]): void {
    if (!incoming.length) return;
    // The socket keeps its own cursor, but a socket can be replaced (teardown
    // and remount, a config change) while these records stay. Re-check
    // contiguity here so the two can never disagree: a repeat is dropped, and
    // a jump means the rows between are gone, which resets the view rather
    // than rendering a hole nobody named.
    const lastStored = this.state.records.at(-1)?.seq ?? -1;
    const fresh = incoming.filter((record) => record.seq > lastStored);
    if (!fresh.length) return;
    const restart = lastStored >= 0 && fresh[0]!.seq > lastStored + 1;
    let records = (restart ? [] : this.state.records).concat(fresh);
    let hasOlder = this.state.hasOlder || restart;
    if (records.length > MAX_CLIENT_RECORDS) {
      records = records.slice(records.length - MAX_CLIENT_RECORDS);
      hasOlder = true;
    }
    let live = this.state.live;
    for (const record of fresh) {
      pendingPrompts.resolve(this.accountScope, record);
      if (!live) continue;
      // The committed row replaces its provisional bubble wholesale. Matching
      // on `turnId` as well as `streamId` is deliberate: a committed assistant
      // row for the live turn supersedes whatever partial we were showing even
      // if the server did not stamp a stream id, and the next delta opens a
      // fresh bubble. Without it the partial would render beside its own
      // committed copy.
      if (
        record.kind === "message" &&
        record.role === "assistant" &&
        (record.streamId === live.streamId || record.turnId === live.turnId)
      ) {
        live = null;
      } else if (
        record.kind === "turn" &&
        record.turnId === live.turnId &&
        record.phase !== "started"
      ) {
        live = null;
      }
    }
    if (records[0] && records[0].seq > this.state.floorSeq) hasOlder = true;
    this.patch({
      records,
      hasOlder,
      live,
      headSeq: Math.max(this.state.headSeq, records.at(-1)?.seq ?? -1),
    });
  }

  private prependRecords(incoming: readonly JournalRecord[]): void {
    if (this.olderTimer) clearTimeout(this.olderTimer);
    this.olderTimer = null;
    const oldest = this.state.records[0]?.seq ?? Number.POSITIVE_INFINITY;
    const older = incoming
      .filter((record) => record.seq < oldest)
      .sort((a, b) => a.seq - b.seq);
    if (!older.length) {
      // The range we asked for came back with nothing in it. `seq` is gapless,
      // so this can only mean those rows are gone — stop offering a button
      // that would ask for the same empty range forever.
      this.patch({
        hasOlder: false,
        loadingOlder: false,
        olderNotice: "That's the start of what Stella still has.",
      });
      return;
    }
    const records = older.concat(this.state.records);
    this.patch({
      records,
      hasOlder: (records[0]?.seq ?? 0) > this.state.floorSeq,
      loadingOlder: false,
    });
  }

  private applyDelta(
    turnId: string,
    streamId: string,
    kind: "text" | "thinking",
    text: string,
  ): void {
    // Thinking is not rendered in this surface; it still proves the turn is
    // alive, which the working label reads off `live` being present.
    const current =
      this.state.live && this.state.live.streamId === streamId
        ? this.state.live
        : {
            turnId,
            streamId,
            text: "",
            toolName: null,
            toolLabel: null,
            dropped: false,
          };
    if (kind !== "text") {
      if (current !== this.state.live) this.patch({ live: current });
      return;
    }
    const joined = current.text + text;
    this.patch({
      live: {
        ...current,
        text:
          joined.length > LIVE_PARTIAL_MAX_CHARS
            ? joined.slice(joined.length - LIVE_PARTIAL_MAX_CHARS)
            : joined,
      },
    });
  }

  private applyTool(
    turnId: string,
    name: string,
    label: string | undefined,
    phase: "start" | "end",
  ): void {
    const current =
      this.state.live && this.state.live.turnId === turnId
        ? this.state.live
        : {
            turnId,
            streamId: `tool:${turnId}`,
            text: "",
            toolName: null,
            toolLabel: null,
            dropped: false,
          };
    this.patch({
      live: {
        ...current,
        toolName: phase === "start" ? name : null,
        toolLabel: phase === "start" ? (label ?? null) : null,
      },
    });
  }
}

/** Conversations kept warm so switching back does not blank the view. */
const MAX_RETAINED_STORES = 8;

const stores = new Map<string, ConversationStore>();

export const conversationStore = (
  conversationId: string,
  accountScope: string,
): ConversationStore => {
  const storeKey = `${accountScope}\u0000${conversationId}`;
  const existing = stores.get(storeKey);
  if (existing) return existing;
  const created = new ConversationStore(conversationId, accountScope);
  stores.set(storeKey, created);
  // Bounded: a session that hops conversations must not accumulate stores.
  // Only unwatched ones are forgotten — evicting a watched store would strand
  // its socket with no owner left to close it.
  if (stores.size > MAX_RETAINED_STORES) {
    for (const [id, store] of stores) {
      if (stores.size <= MAX_RETAINED_STORES) break;
      if (id !== storeKey && store.idle) stores.delete(id);
    }
  }
  return created;
};

/**
 * Called synchronously at the auth boundary. A socket authenticated for a
 * previous subject must not remain warm or be reused when the same durable
 * conversation id is transferred during anonymous account linking.
 */
export const retireCloudConversationClientAuthority = (
  accountScope: string,
): void => {
  for (const [key, store] of stores) {
    if (store.accountScope === accountScope) continue;
    store.retireAuthority();
    stores.delete(key);
  }
  pendingPrompts.retainAccountScope(accountScope);
};

export type { ConversationStore };
