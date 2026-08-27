import {} from "@/features/chat/lib/event-transforms";

export const isLocalChatApiAvailable = () => Boolean(window.electronAPI?.localChat);
const getLocalChatApi = () => {
    const api = window.electronAPI?.localChat;
    if (!api) {
        throw new Error("[local-chat-store] Electron local chat API is unavailable.");
    }
    return api;
};
export const getOrCreateLocalConversationId = async () => getLocalChatApi().getOrCreateDefaultConversationId();
export const createNewLocalConversationId = async () => getLocalChatApi().createNewDefaultConversationId();

export const setActiveLocalConversationId = async (conversationId) => {
    if (!conversationId)
        return;
    const api = window.electronAPI?.localChat;
    if (!api)
        return;
    await api.setActiveConversationId({ conversationId });
};
export const listLocalConversations = async (args) => {
    const api = window.electronAPI?.localChat;
    if (!api)
        return { conversations: [], hasMore: false };
    return api.listConversations(args);
};
export const deleteLocalConversation = async (conversationId) => {
    const result = await getLocalChatApi().deleteConversation({ conversationId });
    return result.deleted;
};

export const truncateLocalConversation = async (conversationId, eventId) => {
    if (!conversationId || !eventId)
        return { removed: 0 };
    return getLocalChatApi().truncateConversation({ conversationId, eventId });
};

export const forkLocalConversation = async (conversationId, eventId) => {
    if (!conversationId || !eventId)
        return null;
    const result = await getLocalChatApi().forkConversation({ conversationId, eventId });
    return result?.conversationId ?? null;
};

export const conversationTitleFromUpdate = (payload) => {
    const conversationId = payload?.conversationId?.trim();
    const event = payload?.event;
    if (!conversationId || !event)
        return null;
    if (event.type !== "user_message" && event.type !== "assistant_message")
        return null;
    const metadata = event.payload?.metadata && typeof event.payload.metadata === "object"
        ? event.payload.metadata
        : null;
    const ui = metadata?.ui && typeof metadata.ui === "object" ? metadata.ui : null;
    const trigger = metadata?.trigger && typeof metadata.trigger === "object"
        ? metadata.trigger
        : null;
    if (ui?.visibility === "hidden" ||
        trigger?.kind === "workspace_creation_request") {
        return null;
    }
    const title = typeof event.payload?.text === "string"
        ? event.payload.text.replace(/\s+/g, " ").trim().slice(0, 240)
        : "";
    return title
        ? {
            conversationId,
            title,
            latestMessageAt: event.timestamp,
            latestMessageId: event._id,
        }
        : null;
};
export const listLocalEvents = async (conversationId, maxItems = 200) => {
    const api = window.electronAPI?.localChat;
    if (!api)
        return [];
    return api.listEvents({
        conversationId,
        maxItems,
    });
};
export const subscribeToLocalChatUpdates = (listener) => window.electronAPI?.localChat?.onUpdated(listener) ?? (() => { });
