import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type {
  ConversationSummaryCursor,
  EventRecord,
  LocalChatLineageWindow,
  LocalChatMessageWindow,
  LocalChatToolEventPage,
} from "@stella/contracts/local-chat";
import type { ConversationFocusRoot } from "@stella/contracts/reply-refs";
import {
  IPC_CLOUD_CONVERSATION_CACHE_ACTIVATE_AUTHORITY,
  IPC_CLOUD_CONVERSATION_CACHE_PURGE_CONVERSATION,
  IPC_CLOUD_CONVERSATION_CACHE_READ,
  IPC_CLOUD_CONVERSATION_CACHE_REPLACE,
  IPC_CLOUD_CONVERSATION_CACHE_RETAIN_ACCOUNT,
  IPC_LOCAL_CHAT_DELETE_CONVERSATION,
  IPC_LOCAL_CHAT_TRUNCATE_CONVERSATION,
  IPC_LOCAL_CHAT_FORK_CONVERSATION,
  IPC_LOCAL_CHAT_GET_AGENT_REPORT,
  IPC_LOCAL_CHAT_LIST_LINEAGE_MESSAGES,
  IPC_LOCAL_CHAT_LIST_REPLY_COUNTS,
  IPC_LOCAL_CHAT_LIST_CONVERSATIONS,
  IPC_LOCAL_CHAT_LIST_MESSAGES_AFTER,
  IPC_LOCAL_CHAT_LIST_MESSAGE_TOOL_EVENTS,
  IPC_LOCAL_CHAT_LIST_MODEL_USAGE,
  IPC_LOCAL_CHAT_GET_OR_CREATE_ID,
  IPC_LOCAL_CHAT_CREATE_NEW_DEFAULT_ID,
  IPC_LOCAL_CHAT_SET_ACTIVE_ID,
  IPC_LOCAL_CHAT_LIST_EVENTS,
  IPC_LOCAL_CHAT_LIST_MESSAGES,
  IPC_LOCAL_CHAT_LIST_MESSAGES_BEFORE,
  IPC_LOCAL_CHAT_LIST_ACTIVITY,
  IPC_LOCAL_CHAT_LIST_THREAD_ACTIVITY,
  IPC_LOCAL_CHAT_LIST_FILES,
  IPC_LOCAL_CHAT_GET_EVENT_COUNT,
  IPC_LOCAL_CHAT_PERSIST_WELCOME,
} from "@stella/contracts/desktop/ipc-channels";
import type { LocalChatHistoryService } from "../services/local-chat-history-service.js";
import { assertPrivilegedRequest } from "./privileged-ipc.js";
import { handleIpc } from "./typed-ipc.js";

const parseConversationFocusRoot = (
  value: unknown,
): ConversationFocusRoot | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as { kind?: unknown; id?: unknown; threadId?: unknown };
  if (record.kind === "message" && typeof record.id === "string" && record.id) {
    return { kind: "message", id: record.id };
  }
  if (
    record.kind === "agent" &&
    typeof record.threadId === "string" &&
    record.threadId
  ) {
    return { kind: "agent", threadId: record.threadId };
  }
  return null;
};

type LocalChatHandlersOptions = {
  localChatHistoryService: LocalChatHistoryService;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

const withLocalChatClient = async <T>(
  options: LocalChatHandlersOptions,
  event: IpcMainEvent | IpcMainInvokeEvent,
  channel: string,
  action: (client: LocalChatHistoryService) => T | Promise<T>,
) => {
  assertPrivilegedRequest(options, event, channel);
  return await action(options.localChatHistoryService);
};

/**
 * Rows from the runtime store type `channelEnvelope` as the raw JSON it was
 * persisted from. It is only ever written from a `ChannelEnvelope`, and the
 * contract hands rows to the renderer as the `@stella/contracts/local-chat`
 * row types (the `as` casts on the row-listing handlers below).
 */
export const registerLocalChatHandlers = (
  options: LocalChatHandlersOptions,
) => {
  handleIpc(
    IPC_CLOUD_CONVERSATION_CACHE_RETAIN_ACCOUNT,
    async (event, payload: unknown) =>
      await withLocalChatClient(
        options,
        event,
        IPC_CLOUD_CONVERSATION_CACHE_RETAIN_ACCOUNT,
        (client) => client.retainCloudConversationCacheAccount(payload),
      ),
  );

  handleIpc(
    IPC_CLOUD_CONVERSATION_CACHE_ACTIVATE_AUTHORITY,
    async (event, payload: unknown) =>
      await withLocalChatClient(
        options,
        event,
        IPC_CLOUD_CONVERSATION_CACHE_ACTIVATE_AUTHORITY,
        (client) => client.activateCloudConversationCacheAuthority(payload),
      ),
  );

  handleIpc(
    IPC_CLOUD_CONVERSATION_CACHE_READ,
    async (event, payload: unknown) =>
      await withLocalChatClient(
        options,
        event,
        IPC_CLOUD_CONVERSATION_CACHE_READ,
        (client) => client.readCloudConversationCache(payload),
      ),
  );

  handleIpc(
    IPC_CLOUD_CONVERSATION_CACHE_REPLACE,
    async (event, payload: unknown) =>
      await withLocalChatClient(
        options,
        event,
        IPC_CLOUD_CONVERSATION_CACHE_REPLACE,
        (client) => client.replaceCloudConversationCache(payload),
      ),
  );

  handleIpc(
    IPC_CLOUD_CONVERSATION_CACHE_PURGE_CONVERSATION,
    async (event, payload: unknown) =>
      await withLocalChatClient(
        options,
        event,
        IPC_CLOUD_CONVERSATION_CACHE_PURGE_CONVERSATION,
        (client) => client.purgeCloudConversationCacheConversation(payload),
      ),
  );

  handleIpc(IPC_LOCAL_CHAT_GET_OR_CREATE_ID, async (event) => {
    return await withLocalChatClient(
      options,
      event,
      IPC_LOCAL_CHAT_GET_OR_CREATE_ID,
      (client) => client.getOrCreateDefaultConversationId(),
    );
  });

  handleIpc(IPC_LOCAL_CHAT_CREATE_NEW_DEFAULT_ID, async (event) => {
    return await withLocalChatClient(
      options,
      event,
      IPC_LOCAL_CHAT_CREATE_NEW_DEFAULT_ID,
      (client) => client.createNewDefaultConversationId(),
    );
  });

  handleIpc(
    IPC_LOCAL_CHAT_SET_ACTIVE_ID,
    async (event, payload: { conversationId?: string }) =>
      await withLocalChatClient(
        options,
        event,
        IPC_LOCAL_CHAT_SET_ACTIVE_ID,
        (client) =>
          client.setActiveConversationId(payload?.conversationId ?? ""),
      ),
  );

  handleIpc(
    IPC_LOCAL_CHAT_LIST_CONVERSATIONS,
    async (
      event,
      payload: {
        limit?: number;
        cursor?: ConversationSummaryCursor | null;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        IPC_LOCAL_CHAT_LIST_CONVERSATIONS,
        (client) =>
          client.listConversations({
            limit: payload?.limit,
            cursor: payload?.cursor,
          }),
      ),
  );

  handleIpc(
    IPC_LOCAL_CHAT_DELETE_CONVERSATION,
    async (event, payload: { conversationId?: string }) =>
      await withLocalChatClient(
        options,
        event,
        IPC_LOCAL_CHAT_DELETE_CONVERSATION,
        (client) => client.deleteConversation(payload?.conversationId ?? ""),
      ),
  );

  handleIpc(
    IPC_LOCAL_CHAT_TRUNCATE_CONVERSATION,
    async (event, payload: { conversationId?: string; eventId?: string }) =>
      await withLocalChatClient(
        options,
        event,
        IPC_LOCAL_CHAT_TRUNCATE_CONVERSATION,
        (client) =>
          client.truncateConversation({
            conversationId: payload?.conversationId ?? "",
            eventId: payload?.eventId ?? "",
          }),
      ),
  );

  handleIpc(
    IPC_LOCAL_CHAT_FORK_CONVERSATION,
    async (event, payload: { conversationId?: string; eventId?: string }) =>
      await withLocalChatClient(
        options,
        event,
        IPC_LOCAL_CHAT_FORK_CONVERSATION,
        (client) =>
          client.forkConversation({
            conversationId: payload?.conversationId ?? "",
            eventId: payload?.eventId ?? "",
          }),
      ),
  );

  handleIpc(
    IPC_LOCAL_CHAT_LIST_EVENTS,
    async (
      event,
      payload: {
        conversationId?: string;
        maxItems?: number;
      },
    ) =>
      (await withLocalChatClient(
        options,
        event,
        IPC_LOCAL_CHAT_LIST_EVENTS,
        (client) =>
          client.listEvents({
            conversationId: payload?.conversationId ?? "",
            maxItems: payload?.maxItems,
          }),
      )) as EventRecord[],
  );

  handleIpc(
    IPC_LOCAL_CHAT_LIST_MESSAGES,
    async (
      event,
      payload: {
        conversationId?: string;
        maxVisibleMessages?: number;
      },
    ) =>
      (await withLocalChatClient(
        options,
        event,
        IPC_LOCAL_CHAT_LIST_MESSAGES,
        (client) =>
          client.listMessages({
            conversationId: payload?.conversationId ?? "",
            maxVisibleMessages: payload?.maxVisibleMessages,
          }),
      )) as LocalChatMessageWindow,
  );

  handleIpc(
    IPC_LOCAL_CHAT_LIST_MESSAGES_BEFORE,
    async (
      event,
      payload: {
        conversationId?: string;
        beforeTimestampMs?: number;
        beforeId?: string;
        maxVisibleMessages?: number;
      },
    ) =>
      (await withLocalChatClient(
        options,
        event,
        IPC_LOCAL_CHAT_LIST_MESSAGES_BEFORE,
        (client) =>
          client.listMessagesBefore({
            conversationId: payload?.conversationId ?? "",
            beforeTimestampMs:
              typeof payload?.beforeTimestampMs === "number"
                ? payload.beforeTimestampMs
                : Number.MAX_SAFE_INTEGER,
            beforeId: payload?.beforeId ?? "",
            maxVisibleMessages: payload?.maxVisibleMessages,
          }),
      )) as LocalChatMessageWindow,
  );

  handleIpc(
    IPC_LOCAL_CHAT_LIST_MESSAGES_AFTER,
    async (
      event,
      payload: {
        conversationId?: string;
        afterTimestampMs?: number;
        afterId?: string;
        afterSequence?: number;
        maxVisibleMessages?: number;
      },
    ) =>
      (await withLocalChatClient(
        options,
        event,
        IPC_LOCAL_CHAT_LIST_MESSAGES_AFTER,
        (client) =>
          client.listMessagesAfter({
            conversationId: payload?.conversationId ?? "",
            afterTimestampMs:
              typeof payload?.afterTimestampMs === "number"
                ? payload.afterTimestampMs
                : 0,
            afterId: payload?.afterId ?? "",
            afterSequence: payload?.afterSequence,
            maxVisibleMessages: payload?.maxVisibleMessages,
          }),
      )) as LocalChatMessageWindow,
  );

  handleIpc(
    IPC_LOCAL_CHAT_LIST_MESSAGE_TOOL_EVENTS,
    async (
      event,
      payload: {
        conversationId?: string;
        messageTimestampMs?: number;
        messageId?: string;
        messageSequence?: number;
        afterTimestampMs?: number;
        afterId?: string;
        afterSequence?: number;
        limit?: number;
      },
    ) =>
      (await withLocalChatClient(
        options,
        event,
        IPC_LOCAL_CHAT_LIST_MESSAGE_TOOL_EVENTS,
        (client) =>
          client.listMessageToolEvents({
            conversationId: payload?.conversationId ?? "",
            messageTimestampMs: payload?.messageTimestampMs ?? 0,
            messageId: payload?.messageId ?? "",
            messageSequence: payload?.messageSequence,
            afterTimestampMs: payload?.afterTimestampMs,
            afterId: payload?.afterId,
            afterSequence: payload?.afterSequence,
            limit: payload?.limit,
          }),
      )) as LocalChatToolEventPage,
  );

  handleIpc(
    IPC_LOCAL_CHAT_LIST_ACTIVITY,
    async (
      event,
      payload: {
        conversationId?: string;
        limit?: number;
        beforeTimestampMs?: number;
        beforeId?: string;
      },
    ) =>
      (await withLocalChatClient(
        options,
        event,
        IPC_LOCAL_CHAT_LIST_ACTIVITY,
        (client) =>
          client.listActivity({
            conversationId: payload?.conversationId ?? "",
            limit: payload?.limit,
            beforeTimestampMs:
              typeof payload?.beforeTimestampMs === "number"
                ? payload.beforeTimestampMs
                : undefined,
            beforeId: payload?.beforeId,
          }),
      )) as { activities: EventRecord[] },
  );

  handleIpc(
    IPC_LOCAL_CHAT_LIST_THREAD_ACTIVITY,
    async (
      event,
      payload: {
        conversationId?: string;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        IPC_LOCAL_CHAT_LIST_THREAD_ACTIVITY,
        (client) =>
          client.listThreadActivity({
            conversationId: payload?.conversationId ?? "",
          }),
      ),
  );

  handleIpc(
    IPC_LOCAL_CHAT_LIST_LINEAGE_MESSAGES,
    async (
      event,
      payload: {
        conversationId?: string;
        root?: unknown;
        beforeSequence?: number;
        limit?: number;
      },
    ) =>
      (await withLocalChatClient(
        options,
        event,
        IPC_LOCAL_CHAT_LIST_LINEAGE_MESSAGES,
        (client) => {
          const root = parseConversationFocusRoot(payload?.root);
          if (!root) {
            throw new Error("A focus root is required.");
          }
          return client.listLineageMessages({
            conversationId: payload?.conversationId ?? "",
            root,
            ...(typeof payload?.beforeSequence === "number"
              ? { beforeSequence: payload.beforeSequence }
              : {}),
            ...(typeof payload?.limit === "number"
              ? { limit: payload.limit }
              : {}),
          });
        },
      )) as LocalChatLineageWindow,
  );

  handleIpc(
    IPC_LOCAL_CHAT_LIST_REPLY_COUNTS,
    async (event, payload: { conversationId?: string }) =>
      await withLocalChatClient(
        options,
        event,
        IPC_LOCAL_CHAT_LIST_REPLY_COUNTS,
        (client) =>
          client.listReplyCounts({
            conversationId: payload?.conversationId ?? "",
          }),
      ),
  );

  handleIpc(
    IPC_LOCAL_CHAT_GET_AGENT_REPORT,
    async (event, payload: { threadId?: string }) =>
      await withLocalChatClient(
        options,
        event,
        IPC_LOCAL_CHAT_GET_AGENT_REPORT,
        (client) =>
          client.getAgentReport({ threadId: payload?.threadId ?? "" }),
      ),
  );

  handleIpc(
    IPC_LOCAL_CHAT_LIST_MODEL_USAGE,
    async (
      event,
      payload: {
        fromMs?: number;
        toMs?: number;
        conversationId?: string;
        threadId?: string;
        limit?: number;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        IPC_LOCAL_CHAT_LIST_MODEL_USAGE,
        (client) =>
          client.listModelUsage({
            fromMs: payload?.fromMs,
            toMs: payload?.toMs,
            conversationId: payload?.conversationId,
            threadId: payload?.threadId,
            limit: payload?.limit,
          }),
      ),
  );

  handleIpc(
    IPC_LOCAL_CHAT_LIST_FILES,
    async (
      event,
      payload: {
        conversationId?: string;
        limit?: number;
        beforeTimestampMs?: number;
        beforeId?: string;
      },
    ) =>
      (await withLocalChatClient(
        options,
        event,
        IPC_LOCAL_CHAT_LIST_FILES,
        (client) =>
          client.listFiles({
            conversationId: payload?.conversationId ?? "",
            limit: payload?.limit,
            beforeTimestampMs:
              typeof payload?.beforeTimestampMs === "number"
                ? payload.beforeTimestampMs
                : undefined,
            beforeId: payload?.beforeId,
          }),
      )) as { files: EventRecord[] },
  );

  handleIpc(
    IPC_LOCAL_CHAT_GET_EVENT_COUNT,
    async (
      event,
      payload: {
        conversationId?: string;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        IPC_LOCAL_CHAT_GET_EVENT_COUNT,
        (client) =>
          client.getEventCount({
            conversationId: payload?.conversationId ?? "",
          }),
      ),
  );

  handleIpc(
    IPC_LOCAL_CHAT_PERSIST_WELCOME,
    async (
      event,
      payload: {
        conversationId?: string;
        message?: string;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        IPC_LOCAL_CHAT_PERSIST_WELCOME,
        (client) =>
          client.persistDiscoveryWelcome({
            conversationId: payload?.conversationId ?? "",
            message: payload?.message ?? "",
          }),
      ),
  );
};
