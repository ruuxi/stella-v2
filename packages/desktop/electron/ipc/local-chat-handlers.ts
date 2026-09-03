import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import type { ConversationSummaryCursor } from "@stella/contracts/local-chat";
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
  IPC_LOCAL_CHAT_LIST_SYNC_MESSAGES_BEFORE,
} from "@stella/contracts/desktop/ipc-channels";
import type { LocalChatHistoryService } from "../services/local-chat-history-service.js";
import {
  parseCloudConversationCacheAccountScope,
  parseCloudConversationCacheAuthority,
  parseCloudConversationCacheLifecycleAuthority,
  parseCloudConversationCacheReplaceInput,
} from "../services/cloud-conversation-cache-store.js";
import { assertPrivilegedRequest } from "./privileged-ipc.js";

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

export const registerLocalChatHandlers = (
  options: LocalChatHandlersOptions,
) => {
  ipcMain.handle(
    IPC_CLOUD_CONVERSATION_CACHE_RETAIN_ACCOUNT,
    async (event, payload: unknown) =>
      await withLocalChatClient(
        options,
        event,
        IPC_CLOUD_CONVERSATION_CACHE_RETAIN_ACCOUNT,
        (client) =>
          client.retainCloudConversationCacheAccount(
            parseCloudConversationCacheAccountScope(payload),
          ),
      ),
  );

  ipcMain.handle(
    IPC_CLOUD_CONVERSATION_CACHE_ACTIVATE_AUTHORITY,
    async (event, payload: unknown) =>
      await withLocalChatClient(
        options,
        event,
        IPC_CLOUD_CONVERSATION_CACHE_ACTIVATE_AUTHORITY,
        (client) =>
          client.activateCloudConversationCacheAuthority(
            parseCloudConversationCacheLifecycleAuthority(payload),
          ),
      ),
  );

  ipcMain.handle(
    IPC_CLOUD_CONVERSATION_CACHE_READ,
    async (event, payload: unknown) =>
      await withLocalChatClient(
        options,
        event,
        IPC_CLOUD_CONVERSATION_CACHE_READ,
        (client) =>
          client.readCloudConversationCache(
            parseCloudConversationCacheAuthority(payload),
          ),
      ),
  );

  ipcMain.handle(
    IPC_CLOUD_CONVERSATION_CACHE_REPLACE,
    async (event, payload: unknown) =>
      await withLocalChatClient(
        options,
        event,
        IPC_CLOUD_CONVERSATION_CACHE_REPLACE,
        (client) => {
          const { serializedRecords: _validatedBytes, ...input } =
            parseCloudConversationCacheReplaceInput(payload);
          return client.replaceCloudConversationCache(input);
        },
      ),
  );

  ipcMain.handle(
    IPC_CLOUD_CONVERSATION_CACHE_PURGE_CONVERSATION,
    async (event, payload: unknown) =>
      await withLocalChatClient(
        options,
        event,
        IPC_CLOUD_CONVERSATION_CACHE_PURGE_CONVERSATION,
        (client) =>
          client.purgeCloudConversationCacheConversation(
            parseCloudConversationCacheAuthority(payload),
          ),
      ),
  );

  ipcMain.handle(
    "localChat:getOrCreateDefaultConversationId",
    async (event) => {
      return await withLocalChatClient(
        options,
        event,
        "localChat:getOrCreateDefaultConversationId",
        (client) => client.getOrCreateDefaultConversationId(),
      );
    },
  );

  ipcMain.handle("localChat:createNewDefaultConversationId", async (event) => {
    return await withLocalChatClient(
      options,
      event,
      "localChat:createNewDefaultConversationId",
      (client) => client.createNewDefaultConversationId(),
    );
  });

  ipcMain.handle(
    "localChat:setActiveConversationId",
    async (event, payload: { conversationId?: string }) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:setActiveConversationId",
        (client) =>
          client.setActiveConversationId(payload?.conversationId ?? ""),
      ),
  );

  ipcMain.handle(
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

  ipcMain.handle(
    IPC_LOCAL_CHAT_DELETE_CONVERSATION,
    async (event, payload: { conversationId?: string }) =>
      await withLocalChatClient(
        options,
        event,
        IPC_LOCAL_CHAT_DELETE_CONVERSATION,
        (client) => client.deleteConversation(payload?.conversationId ?? ""),
      ),
  );

  ipcMain.handle(
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

  ipcMain.handle(
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

  ipcMain.handle(
    "localChat:listEvents",
    async (
      event,
      payload: {
        conversationId?: string;
        maxItems?: number;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:listEvents",
        (client) =>
          client.listEvents({
            conversationId: payload?.conversationId ?? "",
            maxItems: payload?.maxItems,
          }),
      ),
  );

  ipcMain.handle(
    "localChat:listMessages",
    async (
      event,
      payload: {
        conversationId?: string;
        maxVisibleMessages?: number;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:listMessages",
        (client) =>
          client.listMessages({
            conversationId: payload?.conversationId ?? "",
            maxVisibleMessages: payload?.maxVisibleMessages,
          }),
      ),
  );

  ipcMain.handle(
    "localChat:listMessagesBefore",
    async (
      event,
      payload: {
        conversationId?: string;
        beforeTimestampMs?: number;
        beforeId?: string;
        maxVisibleMessages?: number;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:listMessagesBefore",
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
      ),
  );

  ipcMain.handle(
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
      await withLocalChatClient(
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
      ),
  );

  ipcMain.handle(
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
      await withLocalChatClient(
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
      ),
  );

  ipcMain.handle(
    "localChat:listActivity",
    async (
      event,
      payload: {
        conversationId?: string;
        limit?: number;
        beforeTimestampMs?: number;
        beforeId?: string;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:listActivity",
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
      ),
  );

  ipcMain.handle(
    "localChat:listThreadActivity",
    async (
      event,
      payload: {
        conversationId?: string;
        view?: "mobile-summary";
        maxItems?: number;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:listThreadActivity",
        (client) =>
          client.listThreadActivity({
            conversationId: payload?.conversationId ?? "",
            view: payload?.view,
            maxItems: payload?.maxItems,
          }),
      ),
  );

  ipcMain.handle(
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
      await withLocalChatClient(
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
      ),
  );

  ipcMain.handle(
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

  ipcMain.handle(
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

  ipcMain.handle(
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

  ipcMain.handle(
    "localChat:listFiles",
    async (
      event,
      payload: {
        conversationId?: string;
        limit?: number;
        beforeTimestampMs?: number;
        beforeId?: string;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:listFiles",
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
      ),
  );

  ipcMain.handle(
    "localChat:getEventCount",
    async (
      event,
      payload: {
        conversationId?: string;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:getEventCount",
        (client) =>
          client.getEventCount({
            conversationId: payload?.conversationId ?? "",
          }),
      ),
  );

  ipcMain.handle(
    "localChat:persistDiscoveryWelcome",
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
        "localChat:persistDiscoveryWelcome",
        (client) =>
          client.persistDiscoveryWelcome({
            conversationId: payload?.conversationId ?? "",
            message: payload?.message ?? "",
          }),
      ),
  );

  ipcMain.handle(
    "localChat:listSyncMessages",
    async (
      event,
      payload: {
        conversationId?: string;
        maxMessages?: number;
        includeDeveloperArtifacts?: boolean;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:listSyncMessages",
        (client) =>
          client.listSyncMessages({
            conversationId: payload?.conversationId ?? "",
            maxMessages: payload?.maxMessages,
            includeDeveloperArtifacts:
              payload?.includeDeveloperArtifacts === true,
          }),
      ),
  );

  ipcMain.handle(
    IPC_LOCAL_CHAT_LIST_SYNC_MESSAGES_BEFORE,
    async (
      event,
      payload: {
        conversationId?: string;
        beforeTimestampMs?: number;
        beforeId?: string;
        maxMessages?: number;
        includeDeveloperArtifacts?: boolean;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        IPC_LOCAL_CHAT_LIST_SYNC_MESSAGES_BEFORE,
        (client) =>
          client.listSyncMessagesBefore({
            conversationId: payload?.conversationId ?? "",
            beforeTimestampMs:
              typeof payload?.beforeTimestampMs === "number"
                ? payload.beforeTimestampMs
                : Number.MAX_SAFE_INTEGER,
            beforeId: payload?.beforeId ?? "",
            maxMessages: payload?.maxMessages,
            includeDeveloperArtifacts:
              payload?.includeDeveloperArtifacts === true,
          }),
      ),
  );

  ipcMain.handle(
    "localChat:syncMessages",
    async (
      event,
      payload: {
        conversationId?: string;
        sinceCursor?: string | null;
        maxMessages?: number;
        includeDeveloperArtifacts?: boolean;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:syncMessages",
        (client) =>
          client.syncMessages({
            conversationId: payload?.conversationId ?? "",
            sinceCursor: payload?.sinceCursor,
            maxMessages: payload?.maxMessages,
            includeDeveloperArtifacts:
              payload?.includeDeveloperArtifacts === true,
          }),
      ),
  );

  ipcMain.handle(
    "localChat:publishTaskDecoration",
    async (
      event,
      payload: {
        statusTextByAgentId?: Record<string, string>;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:publishTaskDecoration",
        (client) =>
          client.setTaskDecoration({
            statusTextByAgentId: payload?.statusTextByAgentId ?? {},
          }),
      ),
  );

};
