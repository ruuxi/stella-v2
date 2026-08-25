import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import type { ConversationSummaryCursor } from "@stella/contracts/local-chat";
import {
  IPC_LOCAL_CHAT_DELETE_CONVERSATION,
  IPC_LOCAL_CHAT_TRUNCATE_CONVERSATION,
  IPC_LOCAL_CHAT_FORK_CONVERSATION,
  IPC_LOCAL_CHAT_LIST_CONVERSATIONS,
  IPC_LOCAL_CHAT_LIST_MESSAGES_AFTER,
  IPC_LOCAL_CHAT_LIST_MESSAGE_TOOL_EVENTS,
  IPC_LOCAL_CHAT_LIST_MODEL_USAGE,
} from "@stella/contracts/desktop/ipc-channels";
import type { LocalChatHistoryService } from "../services/local-chat-history-service.js";
import { assertPrivilegedRequest } from "./privileged-ipc.js";

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
    async (
      event,
      payload: { conversationId?: string; eventId?: string },
    ) =>
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
    async (
      event,
      payload: { conversationId?: string; eventId?: string },
    ) =>
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
    "localChat:listAgentThreadMessages",
    async (event, payload) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:listAgentThreadMessages",
        (client) =>
          client.listAgentThreadMessages({
            threadId: payload?.threadId ?? "",
            limit: payload?.limit,
          }),
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
        firstReport?: unknown;
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
            firstReport: payload?.firstReport,
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

  ipcMain.handle(
    "localChat:getSyncCheckpoint",
    async (
      event,
      payload: {
        conversationId?: string;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:getSyncCheckpoint",
        (client) =>
          client.getSyncCheckpoint({
            conversationId: payload?.conversationId ?? "",
          }),
      ),
  );

  ipcMain.handle(
    "localChat:setSyncCheckpoint",
    async (
      event,
      payload: {
        conversationId?: string;
        localMessageId?: string;
      },
    ) =>
      await withLocalChatClient(
        options,
        event,
        "localChat:setSyncCheckpoint",
        (client) =>
          client.setSyncCheckpoint({
            conversationId: payload?.conversationId ?? "",
            localMessageId: payload?.localMessageId ?? "",
          }),
      ),
  );
};
