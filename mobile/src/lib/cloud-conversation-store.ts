import { getConvexToken } from "./auth-token";
import {
  disposeAccountScopedResources,
  withoutAccountScope,
} from "./cloud-account-memory";
import {
  CLOUD_CONVERSATION_BACKFILL_BATCH,
  CLOUD_CONVERSATION_LIVE_TEXT_LIMIT,
  CLOUD_CONVERSATION_MAX_RECORDS,
  type CloudJournalRecord,
} from "./cloud-conversation-protocol";
import {
  CloudConversationSocket,
  type CloudConversationSocketEvent,
  type CloudConversationSocketStatus,
} from "./cloud-conversation-socket";

export type CloudPendingPrompt = {
  accountScope: string;
  clientMsgId: string;
  text: string;
  createdAtMs: number;
  conversationId: string;
  turnId: string | null;
  error: string | null;
  cancelRequested: boolean;
};

export type CloudConversationLiveState = {
  turnId: string;
  streamId: string;
  text: string;
  toolName: string | null;
  toolLabel: string | null;
  toolCallId: string | null;
  hasToolActivity: boolean;
  dropped: boolean;
};

export type CloudConversationState = {
  conversationId: string;
  status: CloudConversationSocketStatus;
  statusMessage: string | null;
  statusRetryable: boolean;
  records: readonly CloudJournalRecord[];
  live: CloudConversationLiveState | null;
  title: string;
  floorSeq: number;
  hasOlder: boolean;
  loadingOlder: boolean;
  olderNotice: string | null;
};

const emptyState = (conversationId: string): CloudConversationState => ({
  conversationId,
  status: "idle",
  statusMessage: null,
  statusRetryable: true,
  records: [],
  live: null,
  title: "",
  floorSeq: 0,
  hasOlder: false,
  loadingOlder: false,
  olderNotice: null,
});

let appActive = true;
const stores = new Map<string, CloudConversationStore>();
const pendingListeners = new Set<() => void>();
let pending: readonly CloudPendingPrompt[] = [];
const EMPTY_PENDING: readonly CloudPendingPrompt[] = [];

const emitPending = (next: readonly CloudPendingPrompt[]) => {
  pending = next;
  for (const listener of pendingListeners) listener();
};

export const cloudPendingPrompts = {
  subscribe(listener: () => void): () => void {
    pendingListeners.add(listener);
    return () => pendingListeners.delete(listener);
  },
  getSnapshot(): readonly CloudPendingPrompt[] {
    return pending;
  },
  getServerSnapshot(): readonly CloudPendingPrompt[] {
    return EMPTY_PENDING;
  },
  add(
    accountScope: string,
    clientMsgId: string,
    text: string,
    conversationId: string,
  ): void {
    if (
      pending.some(
        (entry) =>
          entry.accountScope === accountScope &&
          entry.clientMsgId === clientMsgId,
      )
    ) {
      return;
    }
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
        cancelRequested: false,
      },
    ]);
  },
  bind(accountScope: string, clientMsgId: string, turnId: string): boolean {
    let cancelRequested = false;
    emitPending(
      pending.map((entry) => {
        if (
          entry.accountScope !== accountScope ||
          entry.clientMsgId !== clientMsgId
        ) {
          return entry;
        }
        cancelRequested = entry.cancelRequested;
        return { ...entry, turnId };
      }),
    );
    return cancelRequested;
  },
  fail(accountScope: string, clientMsgId: string, error: string): void {
    emitPending(
      pending.map((entry) =>
        entry.accountScope === accountScope &&
        entry.clientMsgId === clientMsgId
          ? { ...entry, error }
          : entry,
      ),
    );
  },
  clearError(accountScope: string, clientMsgId: string): void {
    emitPending(
      pending.map((entry) =>
        entry.accountScope === accountScope &&
        entry.clientMsgId === clientMsgId
          ? { ...entry, error: null, cancelRequested: false }
          : entry,
      ),
    );
  },
  requestCancel(
    accountScope: string,
    conversationId: string,
  ): { clientMsgId: string; turnId: string | null } | null {
    const entry = [...pending]
      .reverse()
      .find(
        (candidate) =>
          candidate.accountScope === accountScope &&
          candidate.conversationId === conversationId &&
          candidate.error === null,
      );
    if (!entry) return null;
    emitPending(
      pending.map((candidate) =>
        candidate === entry ? { ...candidate, cancelRequested: true } : candidate,
      ),
    );
    return { clientMsgId: entry.clientMsgId, turnId: entry.turnId };
  },
  resolve(
    accountScope: string,
    conversationId: string,
    record: CloudJournalRecord,
  ): string | null {
    const clientMsgId =
      record.kind === "message" ? record.clientMsgId : undefined;
    const terminal =
      record.kind === "turn" && record.phase !== "started";
    let cancelTurnId: string | null = null;
    let changed = false;
    const next = pending.flatMap((entry) => {
      if (
        entry.accountScope !== accountScope ||
        entry.conversationId !== conversationId
      ) {
        return [entry];
      }
      const matches =
        (clientMsgId && clientMsgId === entry.clientMsgId) ||
        (entry.turnId && entry.turnId === record.turnId);
      if (!matches) return [entry];
      changed = true;
      if (!entry.cancelRequested || terminal) return [];
      cancelTurnId = record.turnId;
      return [{ ...entry, turnId: record.turnId }];
    });
    if (changed) emitPending(next);
    return cancelTurnId;
  },
  resetAccountScope(accountScope: string): void {
    const next = withoutAccountScope(pending, accountScope);
    if (next.length !== pending.length) emitPending(next);
  },
};

export const setCloudConversationAppActive = (active: boolean): void => {
  appActive = active;
  if (active) {
    for (const store of stores.values()) store.wake();
  }
};

class CloudConversationStore {
  private state: CloudConversationState;
  private readonly listeners = new Set<() => void>();
  private socket: CloudConversationSocket | null = null;
  private subscribers = 0;
  private baseUrl: string | null = null;
  private teardownTimer: ReturnType<typeof setTimeout> | null = null;
  private olderTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly queuedCancels = new Set<string>();
  private disposed = false;

  constructor(
    readonly accountScope: string,
    readonly conversationId: string,
  ) {
    this.state = emptyState(conversationId);
  }

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    this.subscribers += 1;
    if (this.teardownTimer) clearTimeout(this.teardownTimer);
    this.teardownTimer = null;
    this.ensureSocket();
    return () => {
      this.listeners.delete(listener);
      this.subscribers -= 1;
      if (this.disposed) return;
      if (this.subscribers > 0) return;
      this.teardownTimer = setTimeout(() => {
        this.teardownTimer = null;
        if (this.subscribers <= 0) {
          this.socket?.stop();
          if (this.olderTimer) clearTimeout(this.olderTimer);
          this.olderTimer = null;
          this.patch({ status: "idle", live: null });
        }
      }, 5_000);
    };
  };

  getSnapshot = (): CloudConversationState => this.state;

  get idle(): boolean {
    return this.subscribers <= 0;
  }

  setConfig(baseUrl: string | null, resolved: boolean): void {
    if (this.disposed) return;
    const normalized = baseUrl?.replace(/\/+$/, "") || null;
    if (normalized !== this.baseUrl) {
      this.socket?.stop();
      this.socket = null;
      this.baseUrl = normalized;
      this.ensureSocket();
    }
    if (!normalized && resolved) {
      this.patch({
        status: "blocked",
        statusMessage: "Live cloud chat isn't available on this deployment.",
        statusRetryable: false,
      });
    }
  }

  wake(): void {
    if (this.disposed || this.subscribers <= 0) return;
    this.ensureSocket();
    this.socket?.wake();
  }

  retry(): void {
    if (this.disposed) return;
    this.ensureSocket();
    this.socket?.retry();
  }

  cancelTurn(turnId: string): boolean {
    const normalized = turnId.trim();
    if (!normalized || this.disposed) return false;
    this.queuedCancels.add(normalized);
    this.socket?.cancelTurn(normalized);
    return true;
  }

  loadOlder(): void {
    if (this.state.loadingOlder || !this.state.hasOlder) return;
    const oldest = this.state.records[0]?.seq;
    if (oldest === undefined || oldest <= this.state.floorSeq) {
      this.patch({ hasOlder: false });
      return;
    }
    if (
      this.state.records.length + CLOUD_CONVERSATION_BACKFILL_BATCH >
      CLOUD_CONVERSATION_MAX_RECORDS
    ) {
      this.patch({
        hasOlder: false,
        olderNotice:
          "That's as far back as this view holds — reopen it to start elsewhere.",
      });
      return;
    }
    if (this.socket?.requestOlder(oldest)) {
      this.patch({ loadingOlder: true, olderNotice: null });
      if (this.olderTimer) clearTimeout(this.olderTimer);
      this.olderTimer = setTimeout(() => {
        this.olderTimer = null;
        if (this.state.loadingOlder) this.patch({ loadingOlder: false });
      }, 15_000);
    }
  }

  private ensureSocket(): void {
    if (this.disposed || this.subscribers <= 0 || !this.baseUrl) return;
    if (!this.socket) {
      this.socket = new CloudConversationSocket({
        conversationId: this.conversationId,
        baseUrl: this.baseUrl,
        getToken: (options) => getConvexToken(options),
        isActive: () => appActive,
        onEvent: (event) => this.onEvent(event),
      });
    }
    this.socket.start();
    for (const turnId of this.queuedCancels) {
      this.socket.cancelTurn(turnId);
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private patch(next: Partial<CloudConversationState>): void {
    this.state = { ...this.state, ...next };
    this.emit();
  }

  private onEvent(event: CloudConversationSocketEvent): void {
    if (event.type === "status") {
      this.patch({
        status: event.status,
        statusMessage: event.message ?? null,
        statusRetryable: event.retryable,
      });
      return;
    }
    if (event.type === "ready") {
      const readyLive = event.ready.live;
      const oldest = this.state.records[0]?.seq ?? event.ready.windowStartSeq;
      this.patch({
        title: event.ready.title,
        floorSeq: event.ready.floorSeq,
        hasOlder: oldest > event.ready.floorSeq,
        live: readyLive
          ? {
              turnId: readyLive.turnId,
              streamId: readyLive.streamId,
              text: readyLive.partialText,
              toolName: readyLive.tools.at(-1)?.name ?? null,
              toolLabel: readyLive.tools.at(-1)?.label ?? null,
              toolCallId: readyLive.tools.at(-1)?.toolCallId ?? null,
              hasToolActivity: readyLive.tools.length > 0,
              dropped: false,
            }
          : null,
      });
      for (const turnId of this.queuedCancels) {
        this.socket?.cancelTurn(turnId);
      }
      return;
    }
    if (event.type === "records") {
      this.append(event.records);
      return;
    }
    if (event.type === "older") {
      this.prepend(event.records);
      return;
    }
    if (event.type === "reset") {
      if (this.olderTimer) clearTimeout(this.olderTimer);
      this.olderTimer = null;
      this.patch({
        records: [],
        live: null,
        hasOlder: false,
        loadingOlder: false,
        olderNotice: null,
      });
      return;
    }
    if (event.type === "gap") {
      this.patch({ hasOlder: true });
      return;
    }
    if (event.type === "delta") {
      const current =
        this.state.live?.streamId === event.streamId
          ? this.state.live
          : {
              turnId: event.turnId,
              streamId: event.streamId,
              text: "",
              toolName: null,
              toolLabel: null,
              toolCallId: null,
              hasToolActivity: false,
              dropped: false,
            };
      if (event.kind === "thinking") {
        if (current !== this.state.live) this.patch({ live: current });
        return;
      }
      const joined = `${current.text}${event.text}`;
      this.patch({
        live: {
          ...current,
          text:
            joined.length > CLOUD_CONVERSATION_LIVE_TEXT_LIMIT
              ? joined.slice(-CLOUD_CONVERSATION_LIVE_TEXT_LIMIT)
              : joined,
        },
      });
      return;
    }
    if (event.type === "tool") {
      const current =
        this.state.live?.turnId === event.turnId
          ? this.state.live
          : {
              turnId: event.turnId,
              streamId: `tool:${event.turnId}`,
              text: "",
              toolName: null,
              toolLabel: null,
              toolCallId: null,
              hasToolActivity: false,
              dropped: false,
            };
      this.patch({
        live: {
          ...current,
          toolName: event.phase === "start" ? event.name : null,
          toolLabel: event.phase === "start" ? (event.label ?? null) : null,
          toolCallId: event.phase === "start" ? event.toolCallId : null,
          hasToolActivity: true,
        },
      });
      return;
    }
    if (
      event.type === "deltas_dropped" &&
      this.state.live?.streamId === event.streamId
    ) {
      this.patch({ live: { ...this.state.live, dropped: true } });
    }
  }

  private append(incoming: readonly CloudJournalRecord[]): void {
    if (!incoming.length) return;
    const lastStored = this.state.records.at(-1)?.seq ?? -1;
    const fresh = incoming.filter((record) => record.seq > lastStored);
    if (!fresh.length) return;
    const discontinuity = lastStored >= 0 && fresh[0]!.seq > lastStored + 1;
    let records = (discontinuity ? [] : this.state.records).concat(fresh);
    let hasOlder = this.state.hasOlder || discontinuity;
    if (records.length > CLOUD_CONVERSATION_MAX_RECORDS) {
      records = records.slice(-CLOUD_CONVERSATION_MAX_RECORDS);
      hasOlder = true;
    }
    let live = this.state.live;
    for (const record of fresh) {
      const cancelTurnId = cloudPendingPrompts.resolve(
        this.accountScope,
        this.conversationId,
        record,
      );
      if (cancelTurnId) this.cancelTurn(cancelTurnId);
      if (record.kind === "turn" && record.phase !== "started") {
        this.queuedCancels.delete(record.turnId);
      }
      if (!live) continue;
      if (
        record.kind === "message" &&
        record.role === "assistant" &&
        (record.turnId === live.turnId || record.streamId === live.streamId)
      ) {
        live = null;
      }
      if (
        record.kind === "turn" &&
        record.turnId === live?.turnId &&
        record.phase !== "started"
      ) {
        live = null;
      }
    }
    if (records[0] && records[0].seq > this.state.floorSeq) hasOlder = true;
    this.patch({ records, live, hasOlder });
  }

  private prepend(incoming: readonly CloudJournalRecord[]): void {
    if (this.olderTimer) clearTimeout(this.olderTimer);
    this.olderTimer = null;
    const oldest = this.state.records[0]?.seq ?? Number.POSITIVE_INFINITY;
    const older = incoming
      .filter((record) => record.seq < oldest)
      .sort((left, right) => left.seq - right.seq);
    if (!older.length) {
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.teardownTimer) clearTimeout(this.teardownTimer);
    if (this.olderTimer) clearTimeout(this.olderTimer);
    this.teardownTimer = null;
    this.olderTimer = null;
    this.socket?.stop();
    this.socket = null;
    this.queuedCancels.clear();
    this.state = emptyState(this.conversationId);
    this.emit();
  }
}

const MAX_STORES = 8;

export const cloudConversationStore = (
  accountScope: string,
  conversationId: string,
): CloudConversationStore => {
  const key = `${accountScope}\u0000${conversationId}`;
  const existing = stores.get(key);
  if (existing) return existing;
  const created = new CloudConversationStore(accountScope, conversationId);
  stores.set(key, created);
  if (stores.size > MAX_STORES) {
    for (const [id, store] of stores) {
      if (stores.size <= MAX_STORES) break;
      if (id !== key && store.idle) {
        store.dispose();
        stores.delete(id);
      }
    }
  }
  return created;
};

export const resetCloudConversationAccountScope = (
  accountScope: string,
): void => {
  disposeAccountScopedResources(stores, accountScope);
  cloudPendingPrompts.resetAccountScope(accountScope);
};

export type { CloudConversationStore };
