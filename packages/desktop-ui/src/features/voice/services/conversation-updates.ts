/**
 * Mid-call updates from the conversation the call belongs to.
 *
 * A live call used to learn nothing about what happened in the text chat while
 * it was open, because the only sync path polled local SQLite — which is empty
 * for a cloud-stored conversation, i.e. the default. Both storage modes are
 * covered here:
 *
 *   - **local**: the `localChat` IPC surface (messages + agent activity),
 *     refreshed when main says the store changed.
 *   - **cloud**: the conversation stream itself. The voice runtime lives in the
 *     overlay window, which has no React cloud provider, so the authority the
 *     store needs is resolved directly: the auth session snapshot gives the
 *     account scope and `owner.identity` gives the owner generation.
 *
 * Output is deliberately small: new text turns and finished agent work, tagged
 * as something to SAY or something to merely KNOW. The session layer turns
 * those into `session.commentary.append` / `session.thinking.append`.
 */

import {
  activateCloudConversationClientAuthority,
  conversationStore,
} from "@/features/cloud/conversation-store";
import { messageText } from "@/features/cloud/conversation-protocol";
import type { JournalRecord } from "@/features/cloud/conversation-protocol";
import { parseCloudAgentLifecycleCard } from "@stella/contracts/cloud-agent-lifecycle";
import { getChatStorageMode } from "@/features/chat/services/chat-storage-preference";
import { resolveAuthSessionCacheScope } from "@/global/auth/lib/auth-session-scope";
import { getAuthSessionSnapshot } from "@/global/auth/services/auth-session";
import {
  backendClient,
  backendSocketUrl,
} from "@/platform/backend/backend-client";
import type { EventRecord } from "@stella/contracts/local-chat";

/** `say`: worth speaking. `note`: context only, never announced. */
export type ConversationUpdateKind = "say" | "note";

export type ConversationUpdate = {
  /** Stable per source row, so a replay cannot re-announce it. */
  id: string;
  kind: ConversationUpdateKind;
  text: string;
};

export type ConversationUpdateFeed = {
  /**
   * Adopt everything already present as known, without emitting. Called once
   * before the call goes live so the opening history is not narrated.
   */
  prime: () => Promise<void>;
  start: () => void;
  stop: () => void;
};

const LOCAL_WINDOW_LIMIT = 80;
const IGNORED_LOCAL_EVENT_TYPES = new Set(["agent-started", "agent-progress"]);

const isVoiceSourced = (payload: Record<string, unknown> | undefined): boolean =>
  payload?.source === "voice";

// ---------------------------------------------------------------------------
// Shared mapping
// ---------------------------------------------------------------------------

const agentCompletedUpdate = (result: string): string =>
  `A delegated agent finished. ${
    result || "The work is done."
  } Tell the user the outcome if they have not already heard it.`;

const agentFailedUpdate = (verb: string, error: string): string =>
  `A delegated agent ${verb}. ${
    error || "No reason was given."
  } Tell the user briefly.`;

const textTurnNote = (speaker: string, text: string): string =>
  `${speaker} in the text chat: ${text}`;

// ---------------------------------------------------------------------------
// Local source
// ---------------------------------------------------------------------------

const createLocalFeed = (args: {
  conversationId: string;
  onUpdate: (update: ConversationUpdate) => void;
}): ConversationUpdateFeed => {
  const seen = new Set<string>();
  let unsubscribe: (() => void) | null = null;
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;

  const mapEvent = (event: EventRecord): ConversationUpdate | null => {
    if (IGNORED_LOCAL_EVENT_TYPES.has(event.type)) return null;
    const payload = event.payload ?? {};

    if (event.type === "user_message" || event.type === "assistant_message") {
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text || isVoiceSourced(payload)) return null;
      return {
        id: event._id,
        kind: "note",
        text: textTurnNote(
          event.type === "user_message" ? "The user typed" : "Stella replied",
          text,
        ),
      };
    }

    if (event.type === "agent-completed") {
      const result =
        typeof payload.result === "string" ? payload.result.trim() : "";
      return { id: event._id, kind: "say", text: agentCompletedUpdate(result) };
    }

    if (event.type === "agent-failed" || event.type === "agent-canceled") {
      const error =
        typeof payload.error === "string" ? payload.error.trim() : "";
      return {
        id: event._id,
        kind: "say",
        text: agentFailedUpdate(
          event.type === "agent-failed" ? "failed" : "was canceled",
          error,
        ),
      };
    }

    return null;
  };

  const read = async (): Promise<EventRecord[]> => {
    const api = window.electronAPI?.localChat;
    if (!api?.listMessages || !api?.listActivity) return [];
    const [messagesWindow, activityWindow] = await Promise.all([
      api.listMessages({
        conversationId: args.conversationId,
        maxVisibleMessages: LOCAL_WINDOW_LIMIT,
      }),
      api.listActivity({
        conversationId: args.conversationId,
        limit: LOCAL_WINDOW_LIMIT,
      }),
    ]);
    const events: EventRecord[] = [
      ...messagesWindow.messages,
      ...activityWindow.activities,
    ];
    events.sort((a, b) =>
      a.timestamp !== b.timestamp
        ? a.timestamp - b.timestamp
        : a._id.localeCompare(b._id),
    );
    return events;
  };

  const sync = (emit: boolean): Promise<void> => {
    chain = chain
      .catch(() => undefined)
      .then(async () => {
        if (stopped) return;
        const events = await read();
        for (const event of events) {
          if (seen.has(event._id)) continue;
          seen.add(event._id);
          if (!emit) continue;
          const update = mapEvent(event);
          if (update) args.onUpdate(update);
        }
      })
      .catch((err) => {
        console.debug(
          "[voice-updates] Local conversation sync failed:",
          (err as Error).message,
        );
      });
    return chain;
  };

  return {
    prime: () => sync(false),
    start: () => {
      unsubscribe =
        window.electronAPI?.localChat.onUpdated?.(() => {
          void sync(true);
        }) ?? null;
      void sync(true);
    },
    stop: () => {
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
      seen.clear();
    },
  };
};

// ---------------------------------------------------------------------------
// Cloud source
// ---------------------------------------------------------------------------

type CloudAuthority = { accountScope: string; ownerGeneration: string };

/**
 * The overlay window has no cloud React context, so the store's authority is
 * assembled here: the account scope from the auth session snapshot (the same
 * immutable Better Auth user id the main window uses) and the owner
 * generation from the backend's own `owner.identity` answer.
 */
const resolveCloudAuthority = async (): Promise<CloudAuthority | null> => {
  const snapshot = getAuthSessionSnapshot();
  const accountScope = resolveAuthSessionCacheScope(
    snapshot.data as Parameters<typeof resolveAuthSessionCacheScope>[0],
  );
  if (accountScope === "signed-out") return null;
  try {
    const identity = await backendClient.call("owner.identity", {});
    const ownerGeneration = identity.ownerGeneration?.trim();
    if (!ownerGeneration) return null;
    return { accountScope, ownerGeneration };
  } catch (err) {
    console.debug(
      "[voice-updates] Could not resolve the cloud conversation authority:",
      (err as Error).message,
    );
    return null;
  }
};

const mapCloudRecord = (record: JournalRecord): ConversationUpdate | null => {
  if (record.kind === "message") {
    if (isVoiceSourced(record.payload)) return null;
    if (record.role === "toolResult") return null;
    const text = messageText(record.payload).trim();
    if (!text) return null;
    return {
      id: `cloud:${record.seq}`,
      kind: "note",
      text: textTurnNote(
        record.role === "user" ? "The user typed" : "Stella replied",
        text,
      ),
    };
  }

  if (record.kind === "card") {
    const card = parseCloudAgentLifecycleCard(record.card);
    if (!card) return null;
    const event = card.event;
    if (event.type === "agent-completed") {
      return {
        id: `cloud:${record.seq}`,
        kind: "say",
        text: agentCompletedUpdate(event.payload.result.trim()),
      };
    }
    if (event.type === "agent-failed" || event.type === "agent-canceled") {
      return {
        id: `cloud:${record.seq}`,
        kind: "say",
        text: agentFailedUpdate(
          event.type === "agent-failed" ? "failed" : "was canceled",
          event.payload.error?.trim() ?? "",
        ),
      };
    }
    return null;
  }

  return null;
};

const createCloudFeed = (args: {
  conversationId: string;
  onUpdate: (update: ConversationUpdate) => void;
}): ConversationUpdateFeed => {
  let unsubscribe: (() => void) | null = null;
  let store: ReturnType<typeof conversationStore> | null = null;
  let lastSeq = -1;
  let emitting = false;
  let stopped = false;
  let attachPromise: Promise<void> | null = null;

  const drain = (): void => {
    if (!store || stopped) return;
    const { records } = store.getSnapshot();
    for (const record of records) {
      if (record.seq <= lastSeq) continue;
      lastSeq = record.seq;
      if (!emitting) continue;
      const update = mapCloudRecord(record);
      if (update) args.onUpdate(update);
    }
  };

  const attach = async (): Promise<void> => {
    if (store || stopped) return;
    if (!backendSocketUrl) return;
    const authority = await resolveCloudAuthority();
    if (!authority || stopped) return;

    activateCloudConversationClientAuthority(authority);
    const created = conversationStore(
      args.conversationId,
      authority.accountScope,
      authority.ownerGeneration,
    );
    created.setConfig(backendSocketUrl, true);
    store = created;
    unsubscribe = created.subscribe(() => {
      drain();
    });
    drain();
  };

  return {
    prime: () => {
      attachPromise = attach().catch((err) => {
        console.debug(
          "[voice-updates] Cloud conversation stream unavailable:",
          (err as Error).message,
        );
      });
      return attachPromise;
    },
    start: () => {
      emitting = true;
      void (attachPromise ?? attach()).then(() => {
        drain();
      });
    },
    stop: () => {
      stopped = true;
      emitting = false;
      unsubscribe?.();
      unsubscribe = null;
      store = null;
    },
  };
};

// ---------------------------------------------------------------------------

/**
 * One feed for the conversation the call is attached to, picking the source
 * the conversation is actually stored in.
 */
export const createConversationUpdateFeed = (args: {
  conversationId: string;
  onUpdate: (update: ConversationUpdate) => void;
}): ConversationUpdateFeed => {
  const isLocal =
    args.conversationId.startsWith("local_") ||
    getChatStorageMode() === "local";
  return isLocal ? createLocalFeed(args) : createCloudFeed(args);
};
