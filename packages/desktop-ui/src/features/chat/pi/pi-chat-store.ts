/**
 * The desktop chat on pi-durable (unless the user's engine is Claude Code,
 * whose turns keep their own path).
 *
 * One `PiChatState` per watched conversation, folded with the shared reducer
 * from the runtime's event batches (`piChat:events`). Watching asks the
 * runtime for a snapshot; batches that arrive before it answers are held and
 * applied after it, so nothing is lost or applied out of order.
 */
import type { LocalChatAgentReport } from "@stella/contracts/local-chat";
import type { DesktopThreadActivityRecord } from "@/features/chat/thread-activity-types";
import {
  emptyPiChat,
  mergePiEntries,
  reducePiChat,
  type PiChatAgentsResult,
  type PiChatEvent,
  type PiChatEventsPayload,
  type PiChatOlderResult,
  type PiChatPlacedResult,
  type PiChatSend,
  type PiChatState,
  type PiChatWatchResult,
} from "@stella/contracts/pi-chat";

type Watched = {
  state: PiChatState;
  watchers: number;
  listeners: Set<() => void>;
  /** Batches that arrived while the snapshot was on its way. */
  held?: PiChatEvent[][];
  loading: boolean;
  loadingOlder: boolean;
  /** Its snapshot for the current watch has been applied: the state is current, not left from an earlier watch. */
  synced: boolean;
};

const EMPTY: PiChatState = emptyPiChat();
const watched = new Map<string, Watched>();
let unsubscribeEvents: (() => void) | undefined;

const api = () => (typeof window === "undefined" ? undefined : window.electronAPI?.piChat);

/** Whether the desktop chat runs on pi-durable now; the user's engine can move it. */
export const piChatEnabled = (): boolean => api()?.isEnabled() === true;

/** Calls `listener` when the chat moves onto or off pi-durable. */
export const subscribePiChatEnabled = (listener: () => void): (() => void) =>
  api()?.onEnabledChanged(() => listener()) ?? (() => {});

const publish = (entry: Watched) => {
  for (const listener of entry.listeners) listener();
};

const entryFor = (conversationId: string): Watched => {
  let entry = watched.get(conversationId);
  if (!entry) {
    entry = { state: EMPTY, watchers: 0, listeners: new Set(), loading: false, loadingOlder: false, synced: false };
    watched.set(conversationId, entry);
  }
  return entry;
};

/** Ask the runtime for a conversation's snapshot and its events from then on. */
const attach = (conversationId: string, entry: Watched) => {
  const chat = api();
  if (!chat) return;
  entry.held = [];
  entry.loading = true;
  entry.synced = false;
  publish(entry);
  void chat.request({ op: "watch", conversationId }).then(
    (result) => {
      const { snapshot, hasOlder, remote } = result as PiChatWatchResult;
      let state = reducePiChat({ ...entry.state, hasOlder, remote: remote ?? [] }, [snapshot]);
      for (const events of entry.held ?? []) state = reducePiChat(state, events);
      entry.held = undefined;
      entry.loading = false;
      entry.synced = true;
      entry.state = state;
      publish(entry);
    },
    (error: unknown) => {
      entry.held = undefined;
      entry.loading = false;
      entry.synced = true;
      entry.state = { ...entry.state, failure: error instanceof Error ? error.message : String(error) };
      publish(entry);
    },
  );
};

let runtimeReady = true;

const listen = () => {
  if (unsubscribeEvents) return;
  unsubscribeEvents = api()?.onEvents(({ conversationId, events }) => {
    const entry = watched.get(conversationId);
    if (!entry || entry.watchers === 0) return;
    if (entry.held) {
      entry.held.push(events);
      return;
    }
    entry.state = reducePiChat(entry.state, events);
    publish(entry);
  });
  // A restarted runtime has no streams: watch again once it is back.
  window.electronAPI?.agent?.onAvailability?.((snapshot) => {
    const ready = snapshot.connected && snapshot.ready;
    if (ready && !runtimeReady) {
      for (const [conversationId, entry] of watched) {
        if (entry.watchers === 0) continue;
        void api()
          ?.request({ op: "unwatch", conversationId })
          .catch(() => undefined)
          .then(() => attach(conversationId, entry));
      }
    }
    runtimeReady = ready;
  });
};

/** Watch a conversation while the returned stop is not called. */
export const watchPiChat = (conversationId: string): (() => void) => {
  const chat = api();
  if (!chat) return () => {};
  listen();
  const entry = entryFor(conversationId);
  entry.watchers += 1;
  if (entry.watchers === 1) attach(conversationId, entry);
  return () => {
    entry.watchers -= 1;
    if (entry.watchers > 0) return;
    entry.synced = false;
    void chat.request({ op: "unwatch", conversationId }).catch(() => undefined);
  };
};

export const subscribePiChat = (conversationId: string, listener: () => void): (() => void) => {
  const entry = entryFor(conversationId);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
};

export const piChatSnapshot = (conversationId: string | null): PiChatState =>
  (conversationId ? watched.get(conversationId)?.state : undefined) ?? EMPTY;

export const piChatLoading = (conversationId: string | null) => {
  const entry = conversationId ? watched.get(conversationId) : undefined;
  return {
    loading: entry?.loading ?? false,
    loadingOlder: entry?.loadingOlder ?? false,
    synced: (entry?.watchers ?? 0) > 0 && entry?.synced === true,
  };
};

/** The next older page of the transcript. */
export const loadOlderPiChat = async (conversationId: string): Promise<void> => {
  const chat = api();
  const entry = watched.get(conversationId);
  const first = entry?.state.entries[0];
  if (!chat || !entry || !first || !entry.state.hasOlder || entry.loadingOlder) return;
  entry.loadingOlder = true;
  publish(entry);
  try {
    const { entries, hasOlder } = (await chat.request({
      op: "older",
      conversationId,
      beforeEntryId: first.id,
    })) as PiChatOlderResult;
    entry.state = { ...entry.state, entries: mergePiEntries(entries, entry.state.entries), hasOlder };
  } finally {
    entry.loadingOlder = false;
    publish(entry);
  }
};

/** Send a message; one the user pointed elsewhere comes back placed there. */
export const submitPiChat = async (
  conversationId: string,
  requestId: string,
  text: string,
  send?: PiChatSend,
): Promise<PiChatPlacedResult["placed"] | undefined> => {
  const chat = api();
  if (!chat) throw new Error("Stella's runtime is not available.");
  const result = await chat.request({ op: "submit", conversationId, requestId, text, ...(send ? { send } : {}) });
  return (result as Partial<PiChatPlacedResult> | undefined)?.placed;
};

/** Stella's greeting after onboarding, as a reply in the conversation. */
export const submitPiWelcome = async (conversationId: string, message: string): Promise<void> => {
  const chat = api();
  if (!chat) throw new Error("Stella's runtime is not available.");
  await chat.request({ op: "welcome", conversationId, message });
};

/** Stop the conversation's run, and the placed turns it is running elsewhere. */
export const abortPiChat = (conversationId: string): void => {
  const dispatchIds = (watched.get(conversationId)?.state.remote ?? []).flatMap((turn) =>
    turn.clientMsgId ? [turn.clientMsgId] : [],
  );
  void api()
    ?.request({ op: "abort", conversationId, ...(dispatchIds.length > 0 ? { dispatchIds } : {}) })
    .catch(() => undefined);
};

/** A conversation's pi agents as the task rows, cards and focus view read them. */
export const piChatAgents = async (conversationId: string): Promise<DesktopThreadActivityRecord[]> => {
  const chat = api();
  if (!chat) return [];
  const { agents } = (await chat.request({ op: "agents", conversationId })) as PiChatAgentsResult;
  return agents.map((agent) => {
    const latest = agent.assistantMessages[agent.assistantMessages.length - 1];
    return {
      source: "stella",
      threadId: agent.threadId,
      conversationId,
      agentType: "general",
      description: agent.description,
      status: agent.status,
      startedAt: agent.startedAt,
      updatedAt: agent.updatedAt,
      ...(agent.status === "running" ? {} : { completedAt: agent.updatedAt }),
      ...(agent.status === "completed" && latest ? { result: latest } : {}),
      ...(agent.error ? { error: agent.error } : {}),
      assistantMessages: agent.assistantMessages,
      assistantMessagesUpdatedAt: agent.updatedAt,
    };
  });
};

/** One agent's report as the task report shows it: its latest words, whole. */
export const piAgentReport = async (
  conversationId: string,
  threadId: string,
): Promise<LocalChatAgentReport | null> => {
  const agent = (await piChatAgents(conversationId)).find((record) => record.threadId === threadId);
  if (!agent) return null;
  return {
    threadId,
    description: agent.description,
    agentType: agent.agentType,
    status: agent.status,
    ...(agent.result ? { result: agent.result } : {}),
    ...(agent.error ? { error: agent.error } : {}),
    startedAt: agent.startedAt,
    ...(agent.completedAt ? { completedAt: agent.completedAt } : {}),
  };
};

/** Batches of pi events for every watched conversation, as they arrive. */
export const onPiChatEvents = (listener: (payload: PiChatEventsPayload) => void): (() => void) =>
  api()?.onEvents(listener) ?? (() => {});
