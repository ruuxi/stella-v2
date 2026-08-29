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
 * Two stores, on purpose:
 *  - `conversationStore(id, accountScope, ownerGeneration)` is per exact
 *    lifecycle authority + conversation and owns its socket.
 *  - `pendingPrompts` is authority-scoped global state, because the very first
 *    prompt is durably written before any conversation exists to file it under.
 */

import { getConvexToken } from "@/global/auth/services/auth-token";
import {
  BACKFILL_BATCH_RECORDS,
  MAX_CLIENT_RECORDS,
  type JournalRecord,
} from "./conversation-protocol";
import {
  ConversationSocket,
  type ConversationSocketEvent,
  type SocketStatus,
} from "./conversation-socket";
import {
  cloudConversationOutbox,
  type CloudConversationOutboxAuthority,
  type PendingCloudTurnSubmission,
  type PendingPrompt,
} from "./conversation-outbox";
import type {
  CloudConversationCacheAuthority,
  CloudConversationCacheVersion,
} from "@stella/contracts/cloud-conversation-cache";
import { cloudConversationCacheClient } from "./cloud-conversation-cache-client";

export type {
  CloudConversationOutboxAuthority,
  PendingCloudTurnSubmission,
  PendingPrompt,
} from "./conversation-outbox";

/**
 * The turn that is running right now. Assistant replies are delivered whole,
 * so this carries no text: it exists to keep the working indicator up between
 * the turn's `started` row and its terminal one.
 */
export type LiveStream = {
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
  /**
   * `cached-stale` rows may paint while a canonical socket reconnects, but are
   * never eligible to drive server/runtime behavior. Missing is equivalent to
   * `none` for older callers and SSR's inert snapshot.
   */
  recordsSource?: "none" | "cached-stale" | "canonical";
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
  recordsSource: "none",
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
const inFlightPending = new Set<string>();
let activePendingAuthorityKey: string | null = null;
let activePendingAuthorityReady = false;

const authorityKey = (authority: CloudConversationOutboxAuthority): string =>
  `${authority.accountScope}\u0000${authority.ownerGeneration}`;

const pendingKey = (
  authority: CloudConversationOutboxAuthority,
  clientMsgId: string,
): string => `${authorityKey(authority)}\u0000${clientMsgId}`;

const ownsPending = (
  entry: PendingPrompt,
  authority: CloudConversationOutboxAuthority,
): boolean =>
  entry.accountScope === authority.accountScope &&
  entry.ownerGeneration === authority.ownerGeneration;

const reliableStorageError = (error: unknown): string =>
  error instanceof Error && error.message
    ? error.message
    : "Reliable message storage is unavailable. This message was not sent.";

const frozenSubmission = (
  submission: PendingCloudTurnSubmission,
): PendingCloudTurnSubmission =>
  Object.freeze({
    requestedConversationId: submission.requestedConversationId,
    prompt: submission.prompt,
    imagePaths: Object.freeze([...submission.imagePaths]),
    attachments: Object.freeze(
      submission.attachments.map((attachment) =>
        Object.freeze({ ...attachment }),
      ),
    ),
    locale: submission.locale,
    execution: submission.execution
      ? Object.freeze({ ...submission.execution })
      : null,
  });

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
    authority: CloudConversationOutboxAuthority,
    clientMsgId: string,
    text: string,
    conversationId: string | null,
    submission: PendingCloudTurnSubmission,
  ): PendingPrompt {
    const base: PendingPrompt = {
      ...authority,
      clientMsgId,
      text,
      createdAtMs: Date.now(),
      conversationId,
      turnId: null,
      dispatchId: null,
      cancelRequested: false,
      error: null,
      retryOnNextActivation: false,
      durable: false,
      deliveryAcknowledged: false,
      submission: frozenSubmission(submission),
    };
    let entry = base;
    if (
      activePendingAuthorityReady &&
      activePendingAuthorityKey === authorityKey(authority)
    ) {
      try {
        entry = cloudConversationOutbox.enqueue(base);
      } catch (error) {
        entry = { ...base, error: reliableStorageError(error) };
      }
    } else {
      entry = {
        ...base,
        error:
          "Stella is still verifying reliable delivery for this account. This message was not sent.",
      };
    }
    emitPending([...pending, entry]);
    return entry;
  },
  bindDispatch(
    authority: CloudConversationOutboxAuthority,
    clientMsgId: string,
    dispatchId: string,
  ): void {
    this.patch(authority, clientMsgId, (entry) => ({ ...entry, dispatchId }));
  },
  requestCancel(
    authority: CloudConversationOutboxAuthority,
    clientMsgId: string,
  ): void {
    this.patch(authority, clientMsgId, (entry) => ({
      ...entry,
      cancelRequested: true,
    }));
  },
  find(
    authority: CloudConversationOutboxAuthority,
    clientMsgId: string,
  ): PendingPrompt | null {
    return (
      pending.find(
        (entry) =>
          ownsPending(entry, authority) && entry.clientMsgId === clientMsgId,
      ) ?? null
    );
  },
  /** The mutation answered: we now know where the prompt landed. */
  bind(
    authority: CloudConversationOutboxAuthority,
    clientMsgId: string,
    conversationId: string,
    turnId: string,
  ): void {
    this.patch(authority, clientMsgId, (entry) => ({
      ...entry,
      conversationId,
      turnId,
    }));
  },
  fail(
    authority: CloudConversationOutboxAuthority,
    clientMsgId: string,
    message: string,
    retryOnNextActivation = false,
  ): void {
    this.patch(authority, clientMsgId, (entry) => ({
      ...entry,
      error: message,
      retryOnNextActivation,
    }));
  },
  drop(authority: CloudConversationOutboxAuthority, clientMsgId: string): void {
    const found = this.find(authority, clientMsgId);
    if (!found) return;
    if (found.durable) {
      try {
        cloudConversationOutbox.remove(found);
      } catch (error) {
        this.fail(authority, clientMsgId, reliableStorageError(error));
        return;
      }
    }
    const next = pending.filter(
      (entry) =>
        !ownsPending(entry, authority) || entry.clientMsgId !== clientMsgId,
    );
    if (next.length !== pending.length) emitPending(next);
    inFlightPending.delete(pendingKey(authority, clientMsgId));
  },
  /** Persists a storage-denied row if needed, then re-arms exact retry. */
  prepareRetry(
    authority: CloudConversationOutboxAuthority,
    clientMsgId: string,
  ): PendingPrompt | null {
    const found = this.find(authority, clientMsgId);
    if (!found) return null;
    const candidate = {
      ...found,
      error: null,
      retryOnNextActivation: false,
    };
    try {
      const durable = found.durable
        ? cloudConversationOutbox.update(candidate)
        : cloudConversationOutbox.enqueue(candidate);
      if (!durable) return null;
      emitPending(
        pending.map((entry) =>
          ownsPending(entry, authority) && entry.clientMsgId === clientMsgId
            ? durable
            : entry,
        ),
      );
      return durable;
    } catch (error) {
      const failed = { ...found, error: reliableStorageError(error) };
      emitPending(
        pending.map((entry) =>
          ownsPending(entry, authority) && entry.clientMsgId === clientMsgId
            ? failed
            : entry,
        ),
      );
      return null;
    }
  },
  /** Removes persistence only after a matching canonical turn admission. */
  acknowledgeAdmission(
    authority: CloudConversationOutboxAuthority,
    clientMsgId: string,
    conversationId: string,
    turnId: string,
  ): boolean {
    const found = this.find(authority, clientMsgId);
    if (
      !found ||
      !turnId ||
      found.turnId !== turnId ||
      found.conversationId !== conversationId ||
      (found.submission.requestedConversationId !== null &&
        found.submission.requestedConversationId !== conversationId)
    ) {
      return false;
    }
    if (found.durable) {
      try {
        cloudConversationOutbox.remove(found);
      } catch {
        return false;
      }
    }
    const acknowledged = {
      ...found,
      durable: false,
      deliveryAcknowledged: true,
      retryOnNextActivation: false,
    };
    emitPending(
      pending.map((entry) =>
        ownsPending(entry, authority) && entry.clientMsgId === clientMsgId
          ? acknowledged
          : entry,
      ),
    );
    return true;
  },
  /** Placement terminal evidence can acknowledge even before a turn id exists. */
  acknowledgeTerminal(
    authority: CloudConversationOutboxAuthority,
    clientMsgId: string,
    dispatchId: string,
  ): boolean {
    const found = this.find(authority, clientMsgId);
    if (!found || !dispatchId || found.dispatchId !== dispatchId) return false;
    if (found.durable) {
      try {
        cloudConversationOutbox.remove(found);
      } catch {
        return false;
      }
    }
    const acknowledged = {
      ...found,
      durable: false,
      deliveryAcknowledged: true,
      retryOnNextActivation: false,
    };
    emitPending(
      pending.map((entry) =>
        ownsPending(entry, authority) && entry.clientMsgId === clientMsgId
          ? acknowledged
          : entry,
      ),
    );
    return true;
  },
  /** Retires any echo the given canonical record supersedes. */
  resolve(
    authority: CloudConversationOutboxAuthority,
    record: JournalRecord,
  ): void {
    if (!pending.length) return;
    const clientMsgId =
      record.kind === "message" ? record.clientMsgId : undefined;
    const acknowledged = pending.filter(
      (entry) =>
        ownsPending(entry, authority) &&
        ((clientMsgId !== undefined && entry.clientMsgId === clientMsgId) ||
          (clientMsgId !== undefined && entry.dispatchId === clientMsgId) ||
          (entry.turnId !== null && entry.turnId === record.turnId)),
    );
    if (!acknowledged.length) return;
    const removed = new Set<string>();
    for (const entry of acknowledged) {
      try {
        if (!entry.durable || cloudConversationOutbox.remove(entry)) {
          removed.add(entry.clientMsgId);
          inFlightPending.delete(pendingKey(authority, entry.clientMsgId));
        }
      } catch {
        // Keep the durable row. Exact backend dedupe makes a later replay safe,
        // while deleting it only in memory could lose the required retry.
      }
    }
    const next = pending.filter(
      (entry) =>
        !ownsPending(entry, authority) || !removed.has(entry.clientMsgId),
    );
    if (next.length !== pending.length) emitPending(next);
  },
  getServerSnapshot(): readonly PendingPrompt[] {
    return EMPTY_PENDING;
  },
  retainAccountScope(accountScope: string): void {
    activePendingAuthorityKey = null;
    activePendingAuthorityReady = false;
    inFlightPending.clear();
    try {
      cloudConversationOutbox.purgeOtherAccounts(accountScope);
    } catch {
      // Generation activation retries the synchronous purge before any send.
    }
    const next = pending.filter((entry) => entry.accountScope === accountScope);
    if (next.length !== pending.length) emitPending(next);
  },
  activateAuthority(authority: CloudConversationOutboxAuthority): boolean {
    const nextAuthorityKey = authorityKey(authority);
    if (
      activePendingAuthorityReady &&
      activePendingAuthorityKey === nextAuthorityKey
    ) {
      return true;
    }
    activePendingAuthorityKey = nextAuthorityKey;
    activePendingAuthorityReady = false;
    inFlightPending.clear();
    try {
      const hydrated = cloudConversationOutbox
        .activate(authority)
        .map((entry) => {
          if (!entry.retryOnNextActivation) return entry;
          const rearmed = {
            ...entry,
            error: null,
            retryOnNextActivation: false,
          };
          return cloudConversationOutbox.update(rearmed) ?? entry;
        });
      activePendingAuthorityReady = true;
      emitPending(hydrated);
      return true;
    } catch {
      emitPending(EMPTY_PENDING);
      return false;
    }
  },
  isAuthorityReady(authority: CloudConversationOutboxAuthority): boolean {
    return (
      activePendingAuthorityReady &&
      activePendingAuthorityKey === authorityKey(authority)
    );
  },
  claimDispatch(
    authority: CloudConversationOutboxAuthority,
    clientMsgId: string,
  ): boolean {
    const entry = this.find(authority, clientMsgId);
    const key = pendingKey(authority, clientMsgId);
    if (
      !entry?.durable ||
      entry.error !== null ||
      !this.isAuthorityReady(authority) ||
      inFlightPending.has(key)
    ) {
      return false;
    }
    inFlightPending.add(key);
    return true;
  },
  releaseDispatch(
    authority: CloudConversationOutboxAuthority,
    clientMsgId: string,
  ): void {
    inFlightPending.delete(pendingKey(authority, clientMsgId));
  },
  patch(
    authority: CloudConversationOutboxAuthority,
    clientMsgId: string,
    update: (entry: PendingPrompt) => PendingPrompt,
  ): void {
    const found = this.find(authority, clientMsgId);
    if (!found) return;
    let nextEntry = update(found);
    if (found.durable) {
      try {
        const persisted = cloudConversationOutbox.update(nextEntry);
        if (!persisted) return;
        nextEntry = persisted;
      } catch (error) {
        nextEntry = { ...nextEntry, error: reliableStorageError(error) };
      }
    }
    emitPending(
      pending.map((entry) =>
        ownsPending(entry, authority) && entry.clientMsgId === clientMsgId
          ? nextEntry
          : entry,
      ),
    );
  },
};

// ----------------------------------------------------------------- store

/** How long a scrollback request may sit unanswered before the spinner stops. */
const OLDER_TIMEOUT_MS = 15_000;
/** How long the socket outlives its last watcher, to survive a remount. */
const TEARDOWN_GRACE_MS = 5_000;
const CACHE_WRITE_DEBOUNCE_MS = 50;

const cacheVersionsEqual = (
  left: CloudConversationCacheVersion | null,
  right: CloudConversationCacheVersion | null,
): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.epoch === right.epoch &&
    left.headSeq === right.headSeq &&
    left.floorSeq === right.floorSeq &&
    left.revision === right.revision);

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
  private teardownTimer: ReturnType<typeof setTimeout> | null = null;
  private authorityRetired = false;
  private cacheHydrationStarted = false;
  private cacheHydrated = false;
  private cacheVersion: CloudConversationCacheVersion | null = null;
  /** True only while rendered rows still contain unverified SQLite bytes. */
  private cacheContainsUnverifiedRecords = false;
  private cacheOperationGeneration = 0;
  private cacheWriteTimer: ReturnType<typeof setTimeout> | null = null;
  private cacheWriteChain: Promise<void> = Promise.resolve();

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
    const generation = this.cacheOperationGeneration;
    void cloudConversationCacheClient
      .read(this.cacheAuthority)
      .then((cached) => {
        if (
          this.authorityRetired ||
          generation !== this.cacheOperationGeneration
        ) {
          return;
        }
        this.cacheHydrated = true;
        this.cacheVersion = cached
          ? {
              epoch: cached.epoch,
              headSeq: cached.headSeq,
              floorSeq: cached.floorSeq,
              revision: cached.revision,
            }
          : null;
        // A live canonical reducer may have won while the disk read was in
        // flight. Never replace it with older cache bytes; use it to rebuild.
        if (this.state.recordsSource === "canonical") {
          this.scheduleCacheWrite();
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
        // Derived cache failure never changes cloud availability.
      })
      .finally(() => {
        if (generation === this.cacheOperationGeneration) {
          this.cacheHydrated = true;
        }
      });
  }

  /**
   * The builder origin arrives from Convex, asynchronously and possibly after
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
    if (this.cacheWriteTimer) clearTimeout(this.cacheWriteTimer);
    this.cacheWriteTimer = null;
    this.cacheOperationGeneration += 1;
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
    if (
      this.authorityRetired ||
      this.socket ||
      this.subscribers <= 0 ||
      !this.baseUrl
    ) {
      return;
    }
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
    this.patch({
      status: "idle",
      live: null,
      loadingOlder: false,
      recordsSource: this.state.records.length ? "cached-stale" : "none",
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
              : this.state.records.length
                ? { recordsSource: "cached-stale" as const }
                : { recordsSource: "none" as const }),
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
        const cachedOutsideCanonicalWindow =
          this.state.recordsSource === "cached-stale" &&
          (this.state.headSeq > event.ready.headSeq ||
            (this.state.records[0]?.seq ?? event.ready.floorSeq) <
              event.ready.floorSeq);
        const dropCached = epochChanged || cachedOutsideCanonicalWindow;
        const records = dropCached ? EMPTY_RECORDS : this.state.records;
        if (dropCached) this.purgeCache();
        const oldest = records[0]?.seq ?? event.ready.windowStartSeq;
        this.patch({
          title: event.ready.title,
          epoch: event.ready.epoch,
          headSeq: event.ready.headSeq,
          floorSeq: event.ready.floorSeq,
          recordsSource: records.length
            ? this.cacheContainsUnverifiedRecords
              ? "cached-stale"
              : "canonical"
            : "none",
          hasOlder: oldest > event.ready.floorSeq,
          ...(dropCached
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
    // SQLite rows are paint-only. The first canonical record frame replaces
    // the entire unverified window, including equal-seq rows; otherwise seq
    // dedupe would let structurally valid cache corruption masquerade as a
    // server-attested transcript forever.
    const replacingUnverifiedCache = this.cacheContainsUnverifiedRecords;
    const retainedRecords = replacingUnverifiedCache
      ? EMPTY_RECORDS
      : this.state.records;
    const lastStored = retainedRecords.at(-1)?.seq ?? -1;
    const fresh = incoming.filter((record) => record.seq > lastStored);
    if (!fresh.length) return;
    const restart = lastStored >= 0 && fresh[0]!.seq > lastStored + 1;
    let records = (restart ? [] : retainedRecords).concat(fresh);
    let hasOlder = replacingUnverifiedCache
      ? (fresh[0]?.seq ?? this.state.floorSeq) > this.state.floorSeq
      : this.state.hasOlder || restart;
    if (records.length > MAX_CLIENT_RECORDS) {
      records = records.slice(records.length - MAX_CLIENT_RECORDS);
      hasOlder = true;
    }
    let live = this.state.live;
    for (const record of fresh) {
      pendingPrompts.resolve(this.authority, record);
      // The turn's own journal rows bracket the working indicator. Nothing
      // else can: with replies delivered whole there is no per-token traffic
      // to infer liveness from, and a committed assistant row is not the end
      // of a turn — a preamble is followed by tools and another reply.
      if (record.kind !== "turn") continue;
      if (record.phase === "started") {
        if (live?.turnId !== record.turnId) {
          live = { turnId: record.turnId, toolName: null, toolLabel: null };
        }
      } else if (live?.turnId === record.turnId) {
        live = null;
      }
    }
    if (records[0] && records[0].seq > this.state.floorSeq) hasOlder = true;
    this.cacheContainsUnverifiedRecords = false;
    this.patch({
      records,
      recordsSource: "canonical",
      hasOlder,
      live,
      headSeq: Math.max(this.state.headSeq, records.at(-1)?.seq ?? -1),
    });
    this.scheduleCacheWrite();
  }

  private prependRecords(
    incoming: readonly JournalRecord[],
    range?: { complete?: boolean; fromSeq?: number; toSeq?: number },
  ): void {
    if (this.olderTimer) clearTimeout(this.olderTimer);
    this.olderTimer = null;
    if (this.cacheContainsUnverifiedRecords) {
      // A backfill cannot be joined to unverified cache bytes without silently
      // manufacturing a canonical window. Wait for the live replay to replace
      // the cache first.
      this.patch({ loadingOlder: false });
      return;
    }
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
      recordsSource: "canonical",
      hasOlder: (records[0]?.seq ?? 0) > this.state.floorSeq,
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
    if (this.cacheWriteTimer) clearTimeout(this.cacheWriteTimer);
    const generation = this.cacheOperationGeneration;
    this.cacheWriteTimer = setTimeout(() => {
      this.cacheWriteTimer = null;
      this.cacheWriteChain = this.cacheWriteChain.then(() =>
        this.persistCurrentCache(generation),
      );
    }, CACHE_WRITE_DEBOUNCE_MS);
  }

  private async persistCurrentCache(generation: number): Promise<void> {
    if (
      generation !== this.cacheOperationGeneration ||
      !this.isCurrentCacheAuthority() ||
      this.state.recordsSource !== "canonical" ||
      this.state.epoch === null
    ) {
      return;
    }
    const records = [...this.state.records];
    const tail = records.at(-1)?.seq ?? -1;
    // `ready` can name a head before all replay frames arrive. Persist only a
    // complete suffix so a crash can never turn an in-flight hole into cache.
    if (tail !== this.state.headSeq) return;
    const snapshot = {
      epoch: this.state.epoch,
      headSeq: this.state.headSeq,
      floorSeq: this.state.floorSeq,
      title: this.state.title,
    };
    let expected = this.cacheVersion;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await cloudConversationCacheClient.replace({
        ...this.cacheAuthority,
        expected,
        epoch: snapshot.epoch,
        headSeq: snapshot.headSeq,
        floorSeq: snapshot.floorSeq,
        title: snapshot.title,
        records,
      });
      if (
        generation !== this.cacheOperationGeneration ||
        !this.isCurrentCacheAuthority()
      ) {
        return;
      }
      if (result.status === "applied") {
        this.cacheVersion = result.version;
        return;
      }
      if (result.status === "inactive") {
        const reactivated =
          await cloudConversationCacheClient.activateAuthority(this.authority);
        if (!reactivated || !this.isCurrentCacheAuthority()) return;
        const current = await cloudConversationCacheClient.read(
          this.cacheAuthority,
        );
        const currentVersion = current
          ? {
              epoch: current.epoch,
              headSeq: current.headSeq,
              floorSeq: current.floorSeq,
              revision: current.revision,
            }
          : null;
        // Main-process restart may forget only the in-memory active authority.
        // Reuse the on-disk CAS token only when it is still the exact token this
        // writer had already observed. Cache loss (null) is also rebuildable.
        if (
          currentVersion !== null &&
          !cacheVersionsEqual(currentVersion, expected)
        ) {
          return;
        }
        expected = currentVersion;
        this.cacheVersion = currentVersion;
        continue;
      }
      // A null conflict means the disposable file/window vanished between our
      // read and write, so one null-CAS rebuild is safe. A non-null conflict is
      // another writer's exact epoch/head/floor/revision fence; adopting that
      // token would let a stale pre-reset epoch overwrite its successor.
      if (result.current !== null) return;
      this.cacheVersion = null;
      expected = null;
    }
  }

  private purgeCache(): void {
    this.cacheOperationGeneration += 1;
    if (this.cacheWriteTimer) clearTimeout(this.cacheWriteTimer);
    this.cacheWriteTimer = null;
    this.cacheVersion = null;
    this.cacheContainsUnverifiedRecords = false;
    this.cacheHydrated = true;
    const authority = this.cacheAuthority;
    this.cacheWriteChain = this.cacheWriteChain.then(async () => {
      await cloudConversationCacheClient.purgeConversation(authority);
    });
  }

  private applyTool(
    turnId: string,
    name: string,
    label: string | undefined,
    phase: "start" | "end",
  ): void {
    // A tool frame can outrun the turn's `started` row on a fresh connect, so
    // it opens the live turn rather than assuming one is already there.
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
 * Completes the auth fence once Convex reports the canonical lifecycle
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
