/**
 * Rebuildable mobile view of one account-owned cloud conversation.
 *
 * The Durable Object journal is the sole transcript authority. This store is
 * deliberately in-memory: deleting SQLite or reinstalling the app must only
 * discard a cache, because reconnecting the socket reconstructs the view.
 */

import {
  BACKFILL_BATCH_RECORDS,
  MAX_CLIENT_RECORDS,
  type JournalRecord,
} from "./cloud-conversation-protocol";
import {
  ConversationSocket,
  type ConversationSocketEvent,
  type SocketStatus,
} from "./cloud-conversation-socket";

let appActive = true;

export const setCloudConversationAppActive = (active: boolean): void => {
  appActive = active;
  if (!active) return;
  for (const store of stores.values()) store.wake();
};

/**
 * The turn running right now. There is no partial reply to hold: assistant
 * text arrives whole on a committed record, so all a running turn contributes
 * to the view is its identity and the tool it is currently inside.
 */
export type LiveTurn = {
  turnId: string;
  /** The tool currently running, for the working label. */
  toolName: string | null;
  toolLabel: string | null;
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
  live: LiveTurn | null;
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

// ----------------------------------------------------------------- store

/** How long a scrollback request may sit unanswered before the spinner stops. */
const OLDER_TIMEOUT_MS = 15_000;
/** How long the socket outlives its last watcher, to survive a remount. */
const TEARDOWN_GRACE_MS = 5_000;

class ConversationStore {
  readonly conversationId: string;
  readonly accountScope: string;
  readonly ownerGeneration: string;
  private state: ConversationState;
  private readonly listeners = new Set<() => void>();
  private socket: ConversationSocket | null = null;
  private subscribers = 0;
  private baseUrl: string | null = null;
  private olderTimer: ReturnType<typeof setTimeout> | null = null;
  private teardownTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    conversationId: string,
    accountScope: string,
    ownerGeneration: string,
  ) {
    this.conversationId = conversationId;
    this.accountScope = accountScope;
    this.ownerGeneration = ownerGeneration;
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
      const replacedAuthority = this.baseUrl !== null;
      this.baseUrl = next;
      if (this.socket) {
        this.socket.stop();
        this.socket = null;
      }
      // An origin change is an authority change. Epochs and sequence numbers
      // are scoped to the DO behind that origin, so retaining the old rows
      // would let an unrelated generation win the reducer's seq dedupe.
      if (replacedAuthority) {
        this.state = initialState(this.conversationId);
        this.emit();
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
    this.patch({ loadingOlder: true, olderNotice: null });
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
      // Keep the journal store framework-free until a socket genuinely starts.
      // `auth-token` reaches the native auth client, which reducer tests and
      // server-side rendering must not eagerly evaluate.
      getToken: async (options) => {
        const { getConvexToken } = await import("./auth-token");
        return getConvexToken(options);
      },
      isActive: () => appActive,
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
        // A socket can be replaced after the teardown grace while this
        // renderer store deliberately keeps its rows. The new socket has no
        // local epoch to compare, so the store is the final authority fence:
        // rows from an older canonical generation must disappear before any
        // record from the new generation reaches seq-based dedupe below.
        const epochChanged =
          this.state.epoch !== null && this.state.epoch !== event.ready.epoch;
        const records = epochChanged ? EMPTY_RECORDS : this.state.records;
        const oldest = records[0]?.seq ?? event.ready.windowStartSeq;
        this.patch({
          title: event.ready.title,
          epoch: event.ready.epoch,
          headSeq: event.ready.headSeq,
          floorSeq: event.ready.floorSeq,
          hasOlder: oldest > event.ready.floorSeq,
          ...(epochChanged
            ? {
                records,
                loadingOlder: false,
                olderNotice: null,
              }
            : {}),
          live: live
            ? {
                turnId: live.turnId,
                toolName: live.tools.at(-1)?.name ?? null,
                toolLabel: live.tools.at(-1)?.label ?? null,
              }
            : null,
        });
        return;
      }
      case "records":
        this.appendRecords(event.records);
        return;
      case "older":
        this.prependRecords(event.records, {
          complete: event.complete,
          fromSeq: event.fromSeq,
          toSeq: event.toSeq,
        });
        return;
      case "reset":
        this.patch({
          records: EMPTY_RECORDS,
          live: null,
          hasOlder: false,
          loadingOlder: false,
          olderNotice: null,
        });
        return;
      case "gap":
        // Named, not silent: everything below the reported range is gone from
        // the hot window but reachable, so scrollback stays offered.
        this.patch({
          floorSeq: Math.max(this.state.floorSeq, event.toSeq + 1),
          hasOlder: true,
        });
        return;
      case "tool":
        this.applyTool(event.turnId, event.name, event.label, event.phase);
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
      if (!live) continue;
      // Only the turn's own terminal record retires it. A committed assistant
      // row no longer means the turn is over: the run can answer, then reach
      // for another tool, and clearing here would blink the working indicator
      // out mid-turn.
      if (
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

  private prependRecords(
    incoming: readonly JournalRecord[],
    range?: { complete?: boolean; fromSeq?: number; toSeq?: number },
  ): void {
    if (this.olderTimer) clearTimeout(this.olderTimer);
    this.olderTimer = null;
    const claimedRangeIsComplete =
      range?.complete !== false &&
      (range?.fromSeq === undefined ||
        range.toSeq === undefined ||
        (incoming.length === range.toSeq - range.fromSeq + 1 &&
          incoming.every(
            (record, index) => record.seq === range.fromSeq! + index,
          )));
    if (!claimedRangeIsComplete) {
      // Never splice a partial archive page beside the retained window. That
      // would turn missing canonical rows into an invisible transcript hole.
      // Keep the cursor retryable and name the failure in the UI.
      this.patch({
        hasOlder: true,
        loadingOlder: false,
        olderNotice: "Couldn't load that part of this conversation. Try again.",
      });
      return;
    }
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
      olderNotice: null,
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
        : { turnId, toolName: null, toolLabel: null };
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
  ownerGeneration = "unfenced",
): ConversationStore => {
  const storeKey = `${accountScope}\u0000${ownerGeneration}\u0000${conversationId}`;
  const existing = stores.get(storeKey);
  if (existing) return existing;
  const created = new ConversationStore(
    conversationId,
    accountScope,
    ownerGeneration,
  );
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
  ownerGeneration?: string,
): void => {
  for (const [key, store] of stores) {
    if (
      store.accountScope === accountScope &&
      (ownerGeneration === undefined ||
        store.ownerGeneration === ownerGeneration)
    ) {
      continue;
    }
    store.retireAuthority();
    stores.delete(key);
  }
};

export type { ConversationStore };
