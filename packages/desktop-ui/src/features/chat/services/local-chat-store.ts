/**
 * Slim renderer-side wrappers for the few non-timeline consumers that
 * still need raw event-log access. The chat surfaces themselves read
 * from `local-message-store.ts` / `local-activity-store.ts` /
 * `local-files-store.ts` — this module is intentionally tiny:
 *
 *   - `getOrCreateLocalConversationId` — bootstrap helper used before
 *     any conversation context exists.
 *   - `listLocalEvents` — used by onboarding (`WelcomeDialog` reads the
 *     welcome `assistant_message`) and a few auxiliary event readers that
 *     aren't part of the message/activity/files streams.
 *   - `subscribeToLocalChatUpdates` — push notifications backing both
 *     of the above so they refresh when the runtime persists a new
 *     auxiliary event.
 *
 * Anything that wants the chat timeline should use the purpose-built
 * stream hooks instead — don't reach for `listLocalEvents` to render
 * messages.
 */
import { type EventRecord } from "@/features/chat/lib/event-transforms";
import type { LocalChatUpdatedPayload } from "@stella/contracts/local-chat";

/**
 * Absent outside Electron (plain-browser `bun run dev`): chat persistence
 * lives in main-process SQLite. Reads degrade to empty, the update
 * subscription no-ops, and conversation creation fails loudly — a browser
 * tab has no chat backend to create against.
 */
export const isLocalChatApiAvailable = (): boolean =>
  Boolean(window.electronAPI?.localChat);

const getLocalChatApi = () => {
  const api = window.electronAPI?.localChat;
  if (!api) {
    throw new Error(
      "[local-chat-store] Electron local chat API is unavailable.",
    );
  }
  return api;
};

// UiState survives account changes and may still contain the last cloud UUID.
// Only ids returned by the local persistence API in this renderer lifetime are
// eligible to become signed-out routes.
const knownLocalConversationIds = new Set<string>();

export const isKnownLocalConversationId = (conversationId: string): boolean =>
  knownLocalConversationIds.has(conversationId);

export const getOrCreateLocalConversationId = async (): Promise<string> => {
  const conversationId =
    await getLocalChatApi().getOrCreateDefaultConversationId();
  knownLocalConversationIds.add(conversationId);
  return conversationId;
};

export const createNewLocalConversationId = async (): Promise<string> => {
  const conversationId =
    await getLocalChatApi().createNewDefaultConversationId();
  knownLocalConversationIds.add(conversationId);
  return conversationId;
};

/**
 * Record `conversationId` as the durable active-conversation pointer. This
 * is the single source of truth the app restores from on boot, so it's
 * written whenever the router's active conversation changes.
 */
export const setActiveLocalConversationId = async (
  conversationId: string,
): Promise<void> => {
  if (!conversationId) return;
  const api = window.electronAPI?.localChat;
  if (!api) return;
  knownLocalConversationIds.add(conversationId);
  await api.setActiveConversationId({ conversationId });
};

export const listLocalEvents = async (
  conversationId: string,
  maxItems = 200,
): Promise<EventRecord[]> => {
  const api = window.electronAPI?.localChat;
  if (!api) return [];
  return api.listEvents({
    conversationId,
    maxItems,
  });
};

export const subscribeToLocalChatUpdates = (
  listener: (payload: LocalChatUpdatedPayload | null) => void,
): (() => void) =>
  window.electronAPI?.localChat?.onUpdated(listener) ?? (() => {});
