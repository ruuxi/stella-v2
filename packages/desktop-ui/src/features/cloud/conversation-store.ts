/**
 * The rendered state of one cloud conversation, reduced from the socket's
 * ordered record stream.
 *
 * Nothing here is authoritative. The Durable Object owns the transcript; this
 * is a view of it. Desktop may persist the same bounded raw rows as an
 * explicitly stale, rebuildable SQLite cache, but that cache never becomes a
 * send/cancel/runtime fallback and is repainted only behind this authority
 * reducer after a matching account + generation fence.
 *
 * `conversationStore(id, accountScope, ownerGeneration)` is per exact
 * lifecycle authority + conversation and owns its socket. Optimistic prompts
 * (`pendingPrompts`) are authority-scoped global state in `conversation-outbox`,
 * because the very first prompt is durably written before any conversation
 * exists to file it under; the SQLite replica is written by
 * `ConversationCachePersister`.
 */

import { getAuthToken } from "@/global/auth/services/auth-token";
import type { JournalRecord } from "@stella/contracts/conversation-protocol";
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
import {
  ConversationSocket,
  type ConversationSocketCursor,
  type ConversationSocketEvent,
} from "./conversation-socket";
import {
  pendingPrompts,
  type CloudConversationOutboxAuthority,
} from "./conversation-outbox";
import type { CloudConversationCacheAuthority } from "@stella/contracts/cloud-conversation-cache";
import { cloudConversationCacheClient } from "./cloud-conversation-cache-client";
import { ConversationCachePersister } from "./conversation-cache-persister";
import {
  cloudReadinessNow,
  reportCloudReadiness,
} from "./cloud-readiness-timing";

export type ConversationState = ConversationViewState & {
  /**
   * `cached-stale` rows may paint while a canonical socket reconnects, but are
   * never eligible to drive server/runtime behavior. Missing is equivalent to
   * `none` for older callers and SSR's inert snapshot.
   */
  recordsSource?: "none" | "cached-stale" | "canonical";
};

const initialState = (conversationId: string): ConversationState => ({
  ...initialConversationViewState(conversationId),
  recordsSource: "none",
});

// ----------------------------------------------------------------- store

const OLDER_CONTINUE_RETRY_MS = 3_500;
const OLDER_CONTINUE_RETRIES = 20;

class ConversationStore {
  readonly conversationId: string;
  readonly accountScope: string;
  readonly ownerGeneration: string;
  readonly authority: CloudConversationOutboxAuthority;
  private state: ConversationState;
  private readonly listeners = new Set<() => void>();
  private socket: ConversationSocket | null = null;
  private subscribers = 0;
  private baseUrl: string | null = null;
  private olderTimer: ReturnType<typeof setTimeout> | null = null;
  private olderPartial: {
    nextSeq: number;
    toSeq: number;
    records: JournalRecord[];
  } | null = null;
  private olderRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private teardownTimer: ReturnType<typeof setTimeout> | null = null;
  private authorityRetired = false;
  private cacheHydrationStarted = false;
  private cacheHydrated = false;
  /** True only while rendered rows still contain unverified SQLite bytes. */
  private cacheContainsUnverifiedRecords = false;
  private readonly cache: ConversationCachePersister;

  constructor(
    conversationId: string,
    accountScope: string,
    ownerGeneration: string,
  ) {
    this.conversationId = conversationId;
    this.accountScope = accountScope;
    this.ownerGeneration = ownerGeneration;
    this.authority = Object.freeze({ accountScope, ownerGeneration });
    this.state = initialState(conversationId);
    this.cache = new ConversationCachePersister({
      authority: this.cacheAuthority,
      isCurrent: () => this.isCurrentCacheAuthority(),
      snapshot: () =>
        this.state.recordsSource === "canonical" && this.state.epoch !== null
          ? {
              epoch: this.state.epoch,
              headSeq: this.state.headSeq,
              floorSeq: this.state.floorSeq,
              title: this.state.title,
              records: this.state.records,
            }
          : null,
    });
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

  /** Called only after main has activated this exact account generation. */
  activateCache(): void {
    if (this.authorityRetired || this.cacheHydrationStarted) return;
    this.cacheHydrationStarted = true;
    const cacheReadStartedAt = cloudReadinessNow();
    const generation = this.cache.generation;
    void this.cache
      .read()
      .then((cached) => {
        if (this.authorityRetired || generation !== this.cache.generation) {
          return;
        }
        this.cacheHydrated = true;
        this.cache.observe(cached);
        reportCloudReadiness("cloud.cache-read", {
          startedAt: cacheReadStartedAt,
          outcome: cached ? "hit" : "miss",
        });
        // A live canonical reducer may have won while the disk read was in
        // flight. Never replace it with older cache bytes; use it to rebuild.
        if (this.state.recordsSource === "canonical") {
          const incompatible =
            cached !== null &&
            (this.state.epoch === null ||
              cached.epoch !== this.state.epoch ||
              cached.headSeq > this.state.headSeq ||
              (cached.records[0]?.seq ?? cached.floorSeq) <
                this.state.floorSeq);
          if (incompatible) this.purgeCache();
          else this.scheduleCacheWrite();
          return;
        }
        if (!cached) return;
        // `ready` can beat a slow disk read. Once the socket has attested an
        // epoch/window, a late cache may only join that exact canonical view;
        // it may never rewind the reducer to its own stale ready metadata.
        if (this.state.epoch !== null) {
          const firstCachedSeq = cached.records[0]?.seq ?? cached.floorSeq;
          const compatibleWithReady =
            cached.epoch === this.state.epoch &&
            cached.headSeq <= this.state.headSeq &&
            firstCachedSeq >= this.state.floorSeq;
          if (!compatibleWithReady) {
            this.purgeCache();
            return;
          }
          if (cached.records.length) {
            this.cacheContainsUnverifiedRecords = true;
            this.patch({
              records: cached.records,
              recordsSource: "cached-stale",
              hasOlder: firstCachedSeq > this.state.floorSeq,
              loadingOlder: false,
              olderNotice: null,
            });
          }
          return;
        }
        this.cacheContainsUnverifiedRecords = cached.records.length > 0;
        this.patch({
          title: cached.title,
          epoch: cached.epoch,
          headSeq: cached.headSeq,
          floorSeq: cached.floorSeq,
          records: cached.records,
          recordsSource: "cached-stale",
          hasOlder:
            (cached.records[0]?.seq ?? cached.floorSeq) > cached.floorSeq,
          loadingOlder: false,
          olderNotice: null,
          live: null,
        });
      })
      .catch(() => {
        reportCloudReadiness("cloud.cache-read", {
          startedAt: cacheReadStartedAt,
          outcome: "unavailable",
        });
        // Derived cache failure never changes cloud availability.
      })
      .finally(() => {
        if (generation === this.cache.generation) {
          this.cacheHydrated = true;
          this.ensureSocket();
        }
      });
  }

  /**
   * The builder origin arrives from the backend, asynchronously and possibly after
   * the first render. Setting it is what actually opens the socket.
   * `resolved` separates "still loading" from "this deployment has none",
   * which are the same `null` but very different things to show a user.
   */
  setConfig(baseUrl: string | null, resolved: boolean): void {
    if (this.authorityRetired) return;
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
        this.purgeCache();
        this.state = initialState(this.conversationId);
        this.emit();
      }
      this.ensureSocket();
    }
    if (!next && resolved && this.state.status !== "blocked") {
      this.purgeCache();
      this.patch({
        status: "blocked",
        statusMessage: "Live cloud chat isn't available on this deployment.",
        statusRetryable: false,
        records: EMPTY_RECORDS,
        recordsSource: "none",
        epoch: null,
        headSeq: -1,
        live: null,
        hasOlder: false,
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
      recordsSource: "none",
      live: null,
      hasOlder: false,
      loadingOlder: false,
      olderNotice: null,
    });
    this.purgeCache();
    this.ensureSocket();
  }

  /** Immediately retires an old auth subject's socket and rendered state. */
  retireAuthority(): void {
    this.authorityRetired = true;
    this.socket?.stop();
    this.socket = null;
    this.baseUrl = null;
    if (this.olderTimer) clearTimeout(this.olderTimer);
    this.olderTimer = null;
    this.dropOlderPartial();
    this.cache.retire();
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
    if (
      this.cacheContainsUnverifiedRecords ||
      this.state.loadingOlder ||
      !this.state.hasOlder
    ) {
      return;
    }
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
    this.dropOlderPartial();
    if (!this.socket?.requestOlder(oldest)) return;
    this.patch({ loadingOlder: true, olderNotice: null });
    this.armOlderTimer();
  }

  private armOlderTimer(): void {
    if (this.olderTimer) clearTimeout(this.olderTimer);
    this.olderTimer = setTimeout(() => {
      this.olderTimer = null;
      this.dropOlderPartial();
      if (this.state.loadingOlder) this.patch({ loadingOlder: false });
    }, OLDER_TIMEOUT_MS);
  }

  private dropOlderPartial(): void {
    this.olderPartial = null;
    if (this.olderRetryTimer) clearTimeout(this.olderRetryTimer);
    this.olderRetryTimer = null;
  }

  private requestOlderRemainder(attempt: number): void {
    const partial = this.olderPartial;
    if (!partial) return;
    this.armOlderTimer();
    if (this.socket?.requestOlderRange(partial.nextSeq, partial.toSeq)) return;
    if (this.socket && attempt < OLDER_CONTINUE_RETRIES) {
      this.olderRetryTimer = setTimeout(() => {
        this.olderRetryTimer = null;
        this.requestOlderRemainder(attempt + 1);
      }, OLDER_CONTINUE_RETRY_MS);
      return;
    }
    if (this.olderTimer) clearTimeout(this.olderTimer);
    this.olderTimer = null;
    this.dropOlderPartial();
    this.patch({
      hasOlder: true,
      loadingOlder: false,
      olderNotice: OLDER_INCOMPLETE_NOTICE,
    });
  }

  private ensureSocket(): void {
    if (
      this.authorityRetired ||
      this.socket ||
      this.subscribers <= 0 ||
      !this.baseUrl ||
      !this.cacheHydrated
    ) {
      return;
    }
    const initialCursor: ConversationSocketCursor | undefined =
      this.state.recordsSource === "cached-stale" && this.state.epoch !== null
        ? {
            epoch: this.state.epoch,
            lastSeq: this.state.headSeq,
            headSeq: this.state.headSeq,
            floorSeq: this.state.floorSeq,
            windowStartSeq: this.state.records[0]?.seq ?? this.state.floorSeq,
          }
        : undefined;
    this.socket = new ConversationSocket({
      conversationId: this.conversationId,
      baseUrl: this.baseUrl,
      getToken: (options) => getAuthToken(options ?? {}),
      onEvent: (event) => this.onEvent(event),
      ...(initialCursor ? { initialCursor } : {}),
    });
    this.socket.start();
  }

  private teardown(): void {
    this.socket?.stop();
    this.socket = null;
    if (this.olderTimer) clearTimeout(this.olderTimer);
    this.olderTimer = null;
    this.dropOlderPartial();
    // Records stay: remounting the same conversation should not blank the
    // view, and the socket resumes from the cursor it kept.
    this.patch({
      status: "idle",
      live: null,
      loadingOlder: false,
      recordsSource:
        this.state.recordsSource === "none" ? "none" : "cached-stale",
    });
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private patch(next: Partial<ConversationState>): void {
    this.state = { ...this.state, ...next };
    this.emit();
  }

  private onEvent(event: ConversationSocketEvent): void {
    // A close can race a buffered socket callback. Once authority rotates, an
    // old callback may neither repaint nor acknowledge the successor outbox.
    if (this.authorityRetired) return;
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
        const terminal = event.status === "blocked" && !event.retryable;
        if (terminal) this.purgeCache();
        this.patch({
          status: event.status,
          statusMessage: message,
          statusRetryable: event.retryable,
          ...(terminal
            ? {
                records: EMPTY_RECORDS,
                recordsSource: "none" as const,
                epoch: null,
                headSeq: -1,
                live: null,
                hasOlder: false,
              }
            : event.status === "live"
              ? {}
              : this.state.recordsSource === "none"
                ? { recordsSource: "none" as const }
                : { recordsSource: "cached-stale" as const }),
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
        const cachedOutsideCanonicalWindow =
          this.state.recordsSource === "cached-stale" &&
          (this.state.headSeq > event.ready.headSeq ||
            (this.state.records[0]?.seq ?? event.ready.floorSeq) <
              event.ready.floorSeq);
        const dropCached = epochChanged || cachedOutsideCanonicalWindow;
        const records = dropCached ? EMPTY_RECORDS : this.state.records;
        if (dropCached) this.purgeCache();
        const oldest = records[0]?.seq ?? event.ready.windowStartSeq;
        // The socket resumed from the structurally validated cache cursor. If
        // it reached `ready` without an epoch/window reset, the retained bytes
        // are now server-attested and can accept only the delta that follows.
        // This applies equally to an explicit cached empty conversation.
        this.cacheContainsUnverifiedRecords = false;
        this.patch({
          title: event.ready.title,
          epoch: event.ready.epoch,
          headSeq: event.ready.headSeq,
          floorSeq: event.ready.floorSeq,
          recordsSource: "canonical",
          hasOlder: oldest > event.ready.floorSeq,
          ...(dropCached
            ? {
                records,
                loadingOlder: false,
                olderNotice: null,
              }
            : {}),
          live: liveTurnFromReady(event.ready.live),
        });
        this.scheduleCacheWrite();
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
        this.dropOlderPartial();
        this.purgeCache();
        this.patch({
          records: EMPTY_RECORDS,
          recordsSource: "none",
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
      case "tool":
        this.patch({ live: liveTurnWithTool(this.state.live, event) });
        return;
    }
  }

  private appendRecords(incoming: readonly JournalRecord[]): void {
    // SQLite rows are paint-only. The first canonical record frame replaces
    // the entire unverified window, including equal-seq rows; otherwise seq
    // dedupe would let structurally valid cache corruption masquerade as a
    // server-attested transcript forever.
    const appended = appendJournalRecords(this.state, incoming, {
      replaceRetained: this.cacheContainsUnverifiedRecords,
    });
    if (!appended) return;
    for (const record of appended.fresh) {
      pendingPrompts.resolve(this.authority, record);
    }
    this.cacheContainsUnverifiedRecords = false;
    this.patch({
      records: appended.records,
      recordsSource: "canonical",
      hasOlder: appended.hasOlder,
      live: liveTurnAfterRecords(this.state.live, appended.fresh),
      headSeq: appended.headSeq,
    });
    this.scheduleCacheWrite();
  }

  private prependRecords(
    incoming: readonly JournalRecord[],
    range?: { complete?: boolean; fromSeq?: number; toSeq?: number },
  ): void {
    const partial = this.olderPartial;
    const continuesPartial =
      partial !== null &&
      range?.fromSeq === partial.nextSeq &&
      range.toSeq === partial.toSeq;
    if (partial !== null && !continuesPartial) return;
    if (this.olderTimer) clearTimeout(this.olderTimer);
    this.olderTimer = null;
    if (this.cacheContainsUnverifiedRecords) {
      // A backfill cannot be joined to unverified cache bytes without silently
      // manufacturing a canonical window. Wait for the live replay to replace
      // the cache first.
      this.dropOlderPartial();
      this.patch({ loadingOlder: false });
      return;
    }
    if (continuesPartial) this.dropOlderPartial();
    const fromSeq = range?.fromSeq;
    const toSeq = range?.toSeq;
    const lastSeq = incoming.at(-1)?.seq;
    if (
      range?.complete === false &&
      fromSeq !== undefined &&
      toSeq !== undefined &&
      incoming.every((record, index) => record.seq === fromSeq + index) &&
      lastSeq !== undefined &&
      lastSeq < toSeq
    ) {
      this.dropOlderPartial();
      this.olderPartial = {
        nextSeq: lastSeq + 1,
        toSeq,
        records: (continuesPartial ? partial.records : []).concat(incoming),
      };
      this.requestOlderRemainder(0);
      return;
    }
    if (!olderRangeIsComplete(incoming, range)) {
      // Keep the cursor retryable and name the failure in the UI.
      this.patch({
        hasOlder: true,
        loadingOlder: false,
        olderNotice: OLDER_INCOMPLETE_NOTICE,
      });
      return;
    }
    const prepended = prependOlderRecords(
      this.state,
      continuesPartial ? partial.records.concat(incoming) : incoming,
    );
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
      recordsSource: "canonical",
      hasOlder: prepended.hasOlder,
      loadingOlder: false,
      olderNotice: null,
    });
    this.scheduleCacheWrite();
  }

  private get cacheAuthority(): CloudConversationCacheAuthority {
    return {
      accountScope: this.accountScope,
      ownerGeneration: this.ownerGeneration,
      conversationId: this.conversationId,
    };
  }

  private isCurrentCacheAuthority(): boolean {
    return (
      !this.authorityRetired &&
      activeOwnerGenerationByAccount.get(this.accountScope) ===
        this.ownerGeneration
    );
  }

  private scheduleCacheWrite(): void {
    if (
      !this.cacheHydrated ||
      !this.isCurrentCacheAuthority() ||
      this.state.recordsSource !== "canonical"
    ) {
      return;
    }
    this.cache.schedule();
  }

  private purgeCache(): void {
    this.cache.purge();
    this.cacheContainsUnverifiedRecords = false;
    this.cacheHydrated = true;
  }
}

const stores = new Map<string, ConversationStore>();
const activeOwnerGenerationByAccount = new Map<string, string>();
const UNRESOLVED_OWNER_GENERATION = "__unresolved_owner_generation__";

export const conversationStore = (
  conversationId: string,
  accountScope: string,
  ownerGeneration = activeOwnerGenerationByAccount.get(accountScope) ??
    UNRESOLVED_OWNER_GENERATION,
): ConversationStore => {
  const storeKey = `${accountScope}\u0000${ownerGeneration}\u0000${conversationId}`;
  const existing = stores.get(storeKey);
  if (existing) {
    if (activeOwnerGenerationByAccount.get(accountScope) === ownerGeneration) {
      existing.activateCache();
    }
    return existing;
  }
  const created = new ConversationStore(
    conversationId,
    accountScope,
    ownerGeneration,
  );
  stores.set(storeKey, created);
  if (activeOwnerGenerationByAccount.get(accountScope) === ownerGeneration) {
    created.activateCache();
  }
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
  for (const scope of activeOwnerGenerationByAccount.keys()) {
    if (scope !== accountScope) activeOwnerGenerationByAccount.delete(scope);
  }
  pendingPrompts.retainAccountScope(accountScope);
  void cloudConversationCacheClient.retainAccount(accountScope);
};

/**
 * Completes the auth fence once the backend reports the canonical lifecycle
 * generation. Old same-account sockets and persisted sends are retired before
 * the exact generation can connect or replay.
 */
export const activateCloudConversationClientAuthority = (
  authority: CloudConversationOutboxAuthority,
): boolean => {
  activeOwnerGenerationByAccount.set(
    authority.accountScope,
    authority.ownerGeneration,
  );
  for (const [key, store] of stores) {
    if (
      store.accountScope === authority.accountScope &&
      store.ownerGeneration === authority.ownerGeneration
    ) {
      continue;
    }
    store.retireAuthority();
    stores.delete(key);
  }
  void cloudConversationCacheClient.activateAuthority(authority).then(() => {
    if (
      activeOwnerGenerationByAccount.get(authority.accountScope) !==
      authority.ownerGeneration
    ) {
      return;
    }
    for (const store of stores.values()) {
      if (
        store.accountScope === authority.accountScope &&
        store.ownerGeneration === authority.ownerGeneration
      ) {
        store.activateCache();
      }
    }
  });
  return pendingPrompts.activateAuthority(authority);
};

export type { ConversationStore };
