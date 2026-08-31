import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { METHOD_NAMES } from "@stella/contracts/protocol";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import { fileChange } from "@stella/contracts/file-changes";
import { prepareStoredLocalChatPayload } from "../../../kernel/storage/local-chat-payload.js";
import type { LocalChatEventRecord } from "../../../kernel/storage/shared.js";
import { ChatStoreUnavailableError } from "../errors.js";
import * as WorkerSessions from "../sessions.js";
import { fromPromise, type WorkerRpcHandlers } from "../rpc.js";

const chatSession = WorkerSessions.sessionOrFail(
  () => new ChatStoreUnavailableError(),
);

export const localChatHandlers: WorkerRpcHandlers = {
  [METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_GET_OR_CREATE_DEFAULT]: () =>
    Effect.map(chatSession, (session) =>
      session.storage.chatStore.getOrCreateDefaultConversationId(),
    ),

  [METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_APPEND_EVENT]: (params) =>
    Effect.map(chatSession, (session) => {
      const eventArgs = params as {
        conversationId: string;
        type: string;
        payload?: unknown;
        requestId?: string;
        targetDeviceId?: string;
        deviceId?: string;
        timestamp?: number;
        eventId?: string;
        channelEnvelope?: unknown;
      };
      session.storage.appendChatEventAndNotify(eventArgs);
      return { ok: true };
    }),

  [METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_LIST_EVENTS]: (params) =>
    Effect.map(chatSession, (session) => {
      const payload = params as {
        conversationId?: string;
        maxItems?: number;
      };
      return session.storage.chatStore.listEvents(
        payload.conversationId ?? "",
        payload.maxItems,
      );
    }),

  [METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_GET_EVENT_COUNT]: (params) =>
    Effect.map(chatSession, (session) => {
      const payload = params as { conversationId?: string };
      return session.storage.chatStore.getEventCount(
        payload.conversationId ?? "",
      );
    }),

  [METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_PERSIST_DISCOVERY_WELCOME]: (
    params,
  ) =>
    Effect.flatMap(chatSession, (session) =>
      fromPromise(async () => {
        const payload = params as {
          conversationId?: string;
          message?: string;
          firstReport?: unknown;
        };
        const conversationId = payload.conversationId ?? "";
        const message =
          typeof payload.message === "string" ? payload.message : "";
        let latestEvent: LocalChatEventRecord | undefined;
        if (message.trim().length > 0) {
          latestEvent = session.storage.chatStore.appendEvent({
            conversationId,
            type: "assistant_message",
            payload: prepareStoredLocalChatPayload({
              type: "assistant_message",
              payload: { text: message },
              timestamp: Date.now(),
            }),
          });
        }
        const firstReport =
          payload.firstReport &&
          typeof payload.firstReport === "object" &&
          !Array.isArray(payload.firstReport)
            ? (payload.firstReport as Record<string, unknown>)
            : null;
        const reportTitle =
          typeof firstReport?.title === "string"
            ? firstReport.title.trim()
            : "";
        const reportHtml =
          typeof firstReport?.html === "string" ? firstReport.html : "";
        const stellaDataDirPath = session.config.get().stellaDataDirPath;
        if (reportTitle && reportHtml.trim() && stellaDataDirPath) {
          const rawSlug =
            typeof firstReport?.slug === "string" ? firstReport.slug : "";
          const slug =
            rawSlug
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "")
              .slice(0, 64) || "welcome";
          const timestamp = Date.now();
          const filePath = path.join(
            stellaDataDirPath,
            "outputs",
            "html",
            `${slug}.html`,
          );
          let kind: "add" | "update" = "add";
          try {
            await fsPromises.access(filePath);
            kind = "update";
          } catch {
            kind = "add";
          }
          await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
          await fsPromises.writeFile(filePath, reportHtml, "utf8");
          const bytes = Buffer.byteLength(reportHtml, "utf8");
          latestEvent = session.storage.chatStore.appendEvent({
            conversationId,
            type: "tool_result",
            requestId: `onboarding-first-report-${timestamp}`,
            timestamp: timestamp + 1,
            payload: {
              toolName: "html",
              result: `Canvas "${reportTitle}" saved to ${filePath} and opened in the panel.`,
              resultPreview: `Canvas "${reportTitle}" saved to ${filePath} and opened in the panel.`,
              details: {
                filePath,
                slug,
                title: reportTitle,
                createdAt: timestamp,
                bytes,
              },
              filePath,
              slug,
              title: reportTitle,
              createdAt: timestamp,
              bytes,
              fileChanges: [fileChange(filePath, { type: kind })],
              agentType: AGENT_IDS.ORCHESTRATOR,
            },
          });
        }
        session.storage.notifyLocalChatUpdated(conversationId, latestEvent);
        return { ok: true as const };
      }),
    ),

  [METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_LIST_SYNC_MESSAGES]: (params) =>
    Effect.map(chatSession, (session) => {
      const payload = params as {
        conversationId?: string;
        maxMessages?: number;
      };
      return session.storage.chatStore.listSyncMessages(
        payload.conversationId ?? "",
        payload.maxMessages,
      );
    }),

};
