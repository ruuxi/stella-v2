/**
 * Rebuildable mobile view of one account-owned cloud conversation.
 *
 * The Durable Object journal is the sole transcript authority. This store is
 * deliberately in-memory: deleting SQLite or reinstalling the app must only
 * discard a cache, because reconnecting the socket reconstructs the view.
 */

import type { AgentActivityEntry } from "@stella/contracts/conversation-agent-activity";
import {
  MAX_CLIENT_RECORDS,
  type JournalRecord,
} from "@stella/contracts/conversation-protocol";
import {
  ConversationSocket,
  type ConversationSocketEvent,
} from "@stella/contracts/conversation-socket";
import {
  EMPTY_JOURNAL_RECORDS as EMPTY_RECORDS,
  MAX_RETAINED_STORES,
  OLDER_EXHAUSTED_NOTICE,
  OLDER_INCOMPLETE_NOTICE,
  OLDER_LIMIT_NOTICE,
  OLDER_TIMEOUT_MS,
  TEARDOWN_GRACE_MS,
  appendJournalRecords,
  initialConversationViewState,
  liveTurnAfterRecords,
  liveTurnFromReady,
  liveTurnWithTool,
  olderRangeIsComplete,
  olderWouldExceedRetainedLimit,
  prependOlderRecords,
  type ConversationViewState,
} from "@stella/contracts/conversation-store-reducer";

let appActive = true;

export const setCloudConversationAppActive = (active: boolean): void => {
  appActive = active;
  if (!active) return;
  for (const store of stores.values()) store.wake();
};

export type { LiveTurn } from "@stella/contracts/conversation-store-reducer";

export type ConversationState = ConversationViewState & {
  /**
   * Whether the conversation itself is working, as the journal's own owner
   * reports it. Independent of how much transcript this view holds, so it is
   * the one honest answer while a replay is still in flight.
   */
  activity: "idle" | "running";
  /**
   * Agents the journal still shows as working, named by the server over the
   * whole journal. The retained records can only confirm this list, never
   * shorten it: an agent started below the window leaves no trace in it.
   */
  runningAgents: readonly AgentActivityEntry[];
};

const EMPTY_AGENTS: readonly AgentActivityEntry[] = [];

/**
 * How long consecutive journal updates may collapse into one notification.
 *
 * A resume arrives as one frame per record, each its own task on the JS thread,
 * so every record used to cost a render and a fresh whole-journal projection —
 * which is what made catching up slow enough to sit and watch, and what made
 * the composer flip between send and stop as intermediate turn states went by.
 * One frame of coalescing bounds a burst to ~60 renders a second; a single
 * record arriving into a quiet view still lands immediately.
 */
const EMIT_COALESCE_MS = 16;

const initialState = (conversationId: string): ConversationState => ({
  ...initialConversationViewState(conversationId),
  activity: "idle",
  runningAgents: EMPTY_AGENTS,
});

// ----------------------------------------------------------------- store

/**
 * How long the first socket waits for the on-disk journal tail. A slow disk
 * must not hold the transcript hostage: past this the socket opens cold and a
 * late seed is discarded.
 */
const HYDRATE_TIMEOUT_MS = 1_500;

/** Rows and cursor restored from disk before the first socket opens. */
export type ConversationStoreSeed = {
  epoch: number;
  headSeq: number;
  floorSeq: number;
  /** Ascending, contiguous, ending at `headSeq`. */
  records: readonly JournalRecord[];
};

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
  /** Pending disk read the first socket waits on; null once settled. */
  private hydration: Promise<void> | null = null;
  private hydrateRequested = false;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEmitMs = 0;

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
   * The builder origin arrives from the backend, asynchronously and possibly after
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

  /**
   * Seeds the view from the journal tail the last session persisted, so the
   * first socket resumes with a cursor and the server replays only what this
   * device has not seen. One shot per store, and only while the store has
   * never heard from a socket: anything a live socket has said is newer than
   * anything on disk. The socket waits for this (bounded by
   * `HYDRATE_TIMEOUT_MS`) so the seed and the cursor can never disagree.
   */
  hydrate(load: () => Promise<ConversationStoreSeed | null>): void {
    if (this.hydrateRequested) return;
    this.hydrateRequested = true;
    if (this.socket || this.state.epoch !== null || this.state.records.length) {
      return;
    }
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      this.hydration = null;
      this.ensureSocket();
    };
    const timer = setTimeout(settle, HYDRATE_TIMEOUT_MS);
    this.hydration = load()
      .then((seed) => {
        if (settled) return;
        clearTimeout(timer);
        if (seed) this.applySeed(seed);
      })
      .catch(() => undefined)
      .then(settle);
  }

  private applySeed(seed: ConversationStoreSeed): void {
    // The socket is the authority once it exists; a seed that lost the race
    // to a cold connect would only fight the replay it is about to receive.
    if (this.socket || this.state.epoch !== null || this.state.records.length) {
      return;
    }
    const records = seed.records;
    if (!records.length || records[records.length - 1]!.seq !== seed.headSeq) {
      return;
    }
    for (let index = 1; index < records.length; index += 1) {
      if (records[index]!.seq !== records[index - 1]!.seq + 1) return;
    }
    this.patch({
      epoch: seed.epoch,
      headSeq: seed.headSeq,
      floorSeq: seed.floorSeq,
      records: records.slice(-MAX_CLIENT_RECORDS),
      hasOlder: records[0]!.seq > seed.floorSeq,
    });
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
    // Say which limit was hit rather than leaving a button that does nothing,
    // and never grow the array without bound to avoid saying it.
    if (olderWouldExceedRetainedLimit(this.state.records)) {
      this.patch({ hasOlder: false, olderNotice: OLDER_LIMIT_NOTICE });
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
    // The seed read is in flight: it re-enters here when it settles.
    if (this.hydration) return;
    const lastSeq = this.state.records.at(-1)?.seq ?? -1;
    const initialCursor =
      this.state.epoch !== null && lastSeq >= 0
        ? {
            epoch: this.state.epoch,
            lastSeq,
            headSeq: lastSeq,
            floorSeq: this.state.floorSeq,
            windowStartSeq: this.state.records[0]!.seq,
          }
        : undefined;
    this.socket = new ConversationSocket({
      conversationId: this.conversationId,
      baseUrl: this.baseUrl,
      ...(initialCursor ? { initialCursor } : {}),
      // Keep the journal store framework-free until a socket genuinely starts.
      // `auth-token` reaches the native auth client, which reducer tests and
      // server-side rendering must not eagerly evaluate.
      getToken: async (options) => {
        const { getAuthToken } = await import("./auth-token");
        return getAuthToken(options);
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
    if (this.emitTimer) return;
    const sinceLast = Date.now() - this.lastEmitMs;
    if (sinceLast >= EMIT_COALESCE_MS) {
      this.notify();
      return;
    }
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.notify();
    }, EMIT_COALESCE_MS - sinceLast);
  }

  private notify(): void {
    this.lastEmitMs = Date.now();
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
          activity: event.ready.activity === "running" ? "running" : "idle",
          runningAgents:
            event.ready.agents.length > 0 ? event.ready.agents : EMPTY_AGENTS,
          hasOlder: oldest > event.ready.floorSeq,
          ...(epochChanged
            ? {
                records,
                loadingOlder: false,
                olderNotice: null,
              }
            : {}),
          live: liveTurnFromReady(event.ready.live),
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
        this.patch({ live: liveTurnWithTool(this.state.live, event) });
        return;
    }
  }

  private appendRecords(incoming: readonly JournalRecord[]): void {
    const appended = appendJournalRecords(this.state, incoming);
    if (!appended) return;
    this.patch({
      records: appended.records,
      hasOlder: appended.hasOlder,
      live: liveTurnAfterRecords(this.state.live, appended.fresh),
      headSeq: appended.headSeq,
    });
  }

  private prependRecords(
    incoming: readonly JournalRecord[],
    range?: { complete?: boolean; fromSeq?: number; toSeq?: number },
  ): void {
    if (this.olderTimer) clearTimeout(this.olderTimer);
    this.olderTimer = null;
    if (!olderRangeIsComplete(incoming, range)) {
      // Keep the cursor retryable and name the failure in the UI.
      this.patch({
        hasOlder: true,
        loadingOlder: false,
        olderNotice: OLDER_INCOMPLETE_NOTICE,
      });
      return;
    }
    const prepended = prependOlderRecords(this.state, incoming);
    if (!prepended) {
      // Stop offering a button that would ask for the same empty range forever.
      this.patch({
        hasOlder: false,
        loadingOlder: false,
        olderNotice: OLDER_EXHAUSTED_NOTICE,
      });
      return;
    }
    this.patch({
      records: prepended.records,
      hasOlder: prepended.hasOlder,
      loadingOlder: false,
      olderNotice: null,
    });
  }
}

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
