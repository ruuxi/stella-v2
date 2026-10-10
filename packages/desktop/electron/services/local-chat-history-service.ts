import { DatabaseSync } from "node:sqlite";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "@stella/runtime/kernel/storage/database-init";
import { prepareStoredLocalChatPayload } from "@stella/runtime/kernel/storage/local-chat-payload";
import {
  SessionStore,
  projectLocalChatUpdateEvent,
} from "@stella/runtime/kernel/storage/session-store";
import type {
  LocalChatActivityWindow,
  LocalChatAppendEventArgs,
  LocalChatEventRecord,
  LocalChatFilesWindow,
  LocalChatMessageRecord,
  LocalChatMessageWindow,
  SqliteDatabase,
} from "@stella/runtime/kernel/storage/shared";
import type {
  CloudConversationCacheLifecycleAuthority,
  CloudConversationCachePurgeResult,
  CloudConversationCacheReplaceResult,
  CloudConversationCacheSnapshot,
} from "@stella/contracts/cloud-conversation-cache";
import type {
  ConversationSummaryCursor,
  ConversationSummaryPage,
  LocalChatAgentReport,
  LocalModelUsagePage,
  LocalChatUpdatedPayload,
  ThreadActivityRecord,
} from "@stella/contracts/local-chat";
import type {
  ConversationFocusRoot,
  ReplyCounts,
} from "@stella/contracts/reply-refs";
import {
  buildMobileSyncMessages,
  type LocalChatSyncMessageWithArtifacts,
} from "./local-chat-artifacts.js";
import { CloudConversationCacheClient } from "./cloud-conversation-cache-client.js";
import { listCanonicalConversationFilePaths } from "./canonical-conversation-file-paths.js";

type LocalChatHistoryServiceOptions = {
  stellaAppDir: string;
  onUpdated?: (payload: LocalChatUpdatedPayload | null) => void;
};

const openNodeSqliteDatabase = (dbPath: string): SqliteDatabase =>
  new DatabaseSync(dbPath) as unknown as SqliteDatabase;

export class LocalChatHistoryService {
  private db: SqliteDatabase | null = null;
  private store: SessionStore | null = null;
  private cloudConversationCacheStore: CloudConversationCacheClient | null =
    null;
  private readonly stellaAppDir: string;
  private readonly onUpdated?: (
    payload: LocalChatUpdatedPayload | null,
  ) => void;
  private resetInProgress = false;
  constructor(options: LocalChatHistoryServiceOptions) {
    this.stellaAppDir = options.stellaAppDir;
    this.onUpdated = options.onUpdated;
    this.open();
  }

  private open(): void {
    const db = openNodeSqliteDatabase(
      getDesktopDatabasePath(this.stellaAppDir),
    );
    initializeDesktopDatabase(db);
    this.db = db;
    this.store = new SessionStore(db);
  }

  private getStore(): SessionStore {
    if (this.resetInProgress) {
      throw new Error("Local chat history is resetting.");
    }
    if (!this.store) {
      this.open();
    }
    if (!this.store) {
      throw new Error("Local chat history store is unavailable.");
    }
    return this.store;
  }

  private getCloudConversationCacheStore(): CloudConversationCacheClient {
    if (this.resetInProgress)
      throw new Error("Local cloud conversation cache is resetting.");
    if (!this.db) this.open();
    if (this.cloudConversationCacheStore?.hasFailed) {
      const failed = this.cloudConversationCacheStore;
      this.cloudConversationCacheStore = null;
      void failed.close().catch(() => undefined);
    }
    this.cloudConversationCacheStore ??= new CloudConversationCacheClient(
      getDesktopDatabasePath(this.stellaAppDir),
    );
    return this.cloudConversationCacheStore;
  }

  private getAssistantMessagesByAgent(
    conversationId: string,
  ): Map<string, string[]> {
    type ActivityWithAssistantMessages = {
      threadId: string;
      assistantMessages?: string[];
    };
    const records = this.getStore().listThreadActivity(
      conversationId,
    ) as ActivityWithAssistantMessages[];
    return new Map(
      records
        .filter((record) => record.assistantMessages?.length)
        .map((record) => [record.threadId, record.assistantMessages!]),
    );
  }

  async close(): Promise<void> {
    const db = this.db;
    this.db = null;
    this.store = null;
    const cache = this.cloudConversationCacheStore;
    this.cloudConversationCacheStore = null;
    db?.close();
    await cache?.close();
  }

  async closeForReset(): Promise<void> {
    this.resetInProgress = true;
    await this.close();
  }

  async reopen(): Promise<void> {
    this.resetInProgress = true;
    await this.close();
    this.open();
    this.resetInProgress = false;
  }

  getOrCreateDefaultConversationId(): string {
    return this.getStore().getOrCreateDefaultConversationId();
  }

  createNewDefaultConversationId(): string {
    return this.getStore().createNewDefaultConversationId();
  }

  setActiveConversationId(conversationId: string): { ok: true } {
    this.getStore().setActiveDefaultConversationId(conversationId);
    return { ok: true };
  }

  listConversations(args: {
    limit?: number;
    cursor?: ConversationSummaryCursor | null;
  }): ConversationSummaryPage {
    return this.getStore().listConversationSummaries(args);
  }

  deleteConversation(conversationId: string): { deleted: boolean } {
    return { deleted: this.getStore().deleteConversation(conversationId) };
  }

  listEvents(args: {
    conversationId: string;
    maxItems?: number;
  }): LocalChatEventRecord[] {
    return this.getStore().listEvents(
      args.conversationId,
      args.maxItems,
    ) as LocalChatEventRecord[];
  }

  listModelUsage(args: {
    fromMs?: number;
    toMs?: number;
    conversationId?: string;
    threadId?: string;
    limit?: number;
  }): LocalModelUsagePage {
    return this.getStore().listModelUsage(args) as LocalModelUsagePage;
  }

  listMessages(args: {
    conversationId: string;
    maxVisibleMessages?: number;
  }): LocalChatMessageWindow {
    return this.getStore().listMessages(args.conversationId, {
      maxVisibleMessages: args.maxVisibleMessages,
    });
  }

  listMessagesBefore(args: {
    conversationId: string;
    beforeTimestampMs: number;
    beforeId: string;
    maxVisibleMessages?: number;
  }): LocalChatMessageWindow {
    return this.getStore().listMessagesBefore(args.conversationId, {
      beforeTimestampMs: args.beforeTimestampMs,
      beforeId: args.beforeId,
      maxVisibleMessages: args.maxVisibleMessages,
    });
  }

  /**
   * Changed-rows query for the renderer's tail-only refresh: new
   * user/assistant messages after the cursor plus existing rows whose turn
   * gained tool-derived artifacts after it. The mobile-sync `sourceEvents`
   * are dropped — the renderer merge only needs the message rows.
   */
  listMessagesAfter(args: {
    conversationId: string;
    afterTimestampMs: number;
    afterId: string;
    afterSequence?: number;
    maxVisibleMessages?: number;
  }): LocalChatMessageWindow {
    const { messages, visibleMessageCount, nextCursor } =
      this.getStore().listMessagesAfter(args.conversationId, {
        afterTimestampMs: args.afterTimestampMs,
        afterId: args.afterId,
        afterSequence: args.afterSequence,
        maxVisibleMessages: args.maxVisibleMessages,
        includeSourceEvents: false,
      });
    return { messages, visibleMessageCount, nextCursor };
  }

  listMessageToolEvents(args: {
    conversationId: string;
    messageTimestampMs: number;
    messageId: string;
    messageSequence?: number;
    afterTimestampMs?: number;
    afterId?: string;
    afterSequence?: number;
    limit?: number;
  }) {
    return this.getStore().listMessageToolEvents(args.conversationId, args);
  }

  listActivity(args: {
    conversationId: string;
    limit?: number;
    beforeTimestampMs?: number;
    beforeId?: string;
  }): LocalChatActivityWindow {
    return this.getStore().listActivity(args.conversationId, {
      limit: args.limit,
      beforeTimestampMs: args.beforeTimestampMs,
      beforeId: args.beforeId,
    }) as LocalChatActivityWindow;
  }

  listThreadActivity(args: {
    conversationId: string;
  }): ThreadActivityRecord[] {
    return this.getStore().listThreadActivity(
      args.conversationId,
    ) as unknown as ThreadActivityRecord[];
  }

  /**
   * Focus (lineage) page for one message or agent thread. Reads the
   * `entry_ref` index the runtime writes with every assistant row, so the
   * cost is proportional to the lineage, not the conversation.
   */
  listLineageMessages(args: {
    conversationId: string;
    root: ConversationFocusRoot;
    beforeSequence?: number;
    limit?: number;
  }): { messages: LocalChatMessageRecord[]; hasOlder: boolean } {
    const window = this.getStore().listLineageMessages(args.conversationId, {
      root: args.root,
      ...(typeof args.beforeSequence === "number"
        ? { beforeSequence: args.beforeSequence }
        : {}),
      ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
    });
    return { messages: window.messages, hasOlder: window.hasOlder };
  }

  listReplyCounts(args: { conversationId: string }): ReplyCounts {
    return this.getStore().listReplyCounts(args.conversationId);
  }

  /** The untruncated report an agent returned (the activity list ships a
   *  bounded excerpt; this is the on-demand full read behind the reply
   *  preview's expand affordance). */
  getAgentReport(args: { threadId: string }): LocalChatAgentReport | null {
    const record = this.getStore().getAgentRecord(args.threadId);
    if (!record) return null;
    return {
      threadId: record.threadId,
      description: record.description,
      agentType: record.agentType,
      status: record.status,
      ...(typeof record.result === "string" && record.result.trim()
        ? { result: record.result }
        : {}),
      ...(typeof record.error === "string" && record.error.trim()
        ? { error: record.error }
        : {}),
      startedAt: record.startedAt,
      ...(typeof record.completedAt === "number"
        ? { completedAt: record.completedAt }
        : {}),
    };
  }

  listCanonicalFilePaths(
    conversationId: string,
    ownerScope: string | null,
  ): string[] {
    this.getStore(); // Respect reset/closed lifecycle before accessing SQLite.
    return this.db
      ? listCanonicalConversationFilePaths(this.db, conversationId, ownerScope)
      : [];
  }

  listFiles(args: {
    conversationId: string;
    limit?: number;
    beforeTimestampMs?: number;
    beforeId?: string;
  }): LocalChatFilesWindow {
    return this.getStore().listFiles(args.conversationId, {
      limit: args.limit,
      beforeTimestampMs: args.beforeTimestampMs,
      beforeId: args.beforeId,
    }) as LocalChatFilesWindow;
  }

  getEventCount(args: { conversationId: string }): number {
    return this.getStore().getEventCount(args.conversationId);
  }

  appendEvent(args: LocalChatAppendEventArgs): LocalChatEventRecord {
    const event = this.getStore().appendEvent(args);
    this.onUpdated?.({
      conversationId: args.conversationId,
      event: projectLocalChatUpdateEvent(
        event,
      ) as unknown as LocalChatUpdatedPayload["event"],
    });
    return event;
  }

  hasEvent(args: {
    conversationId: string;
    eventId: string;
    type?: string;
  }): boolean {
    return this.getStore().hasEvent(
      args.conversationId,
      args.eventId,
      args.type,
    );
  }

  hasEventId(args: { eventId: string; type?: string }): boolean {
    return this.getStore().hasEventId(args.eventId, args.type);
  }

  persistDiscoveryWelcome(args: { conversationId: string; message: string }): {
    ok: true;
  } {
    const message = args.message.trim();
    const store = this.getStore();
    let latestEvent: LocalChatEventRecord | undefined;
    if (message.length > 0) {
      latestEvent = store.appendEvent({
        conversationId: args.conversationId,
        type: "assistant_message",
        payload: prepareStoredLocalChatPayload({
          type: "assistant_message",
          payload: { text: message },
          timestamp: Date.now(),
        }),
      });
    }

    this.onUpdated?.({
      conversationId: args.conversationId,
      ...(latestEvent
        ? {
            event: projectLocalChatUpdateEvent(
              latestEvent,
            ) as unknown as LocalChatUpdatedPayload["event"],
          }
        : {}),
    });
    return { ok: true };
  }

  listSyncMessages(args: {
    conversationId: string;
    maxMessages?: number;
    includeDeveloperArtifacts?: boolean;
  }): LocalChatSyncMessageWithArtifacts[] {
    const maxMessages = Math.max(1, Math.floor(args.maxMessages ?? 100));
    const { messages } = this.getStore().listMessages(args.conversationId, {
      maxVisibleMessages: maxMessages,
    });
    return buildMobileSyncMessages(
      messages,
      maxMessages,
      {
        includeDeveloperArtifacts: args.includeDeveloperArtifacts === true,
      },
      this.getAssistantMessagesByAgent(args.conversationId),
      messages,
    );
  }

  retainCloudConversationCacheAccount(
    payload: unknown,
  ): Promise<CloudConversationCachePurgeResult> {
    return this.getCloudConversationCacheStore().request(
      "retain",
      typeof payload === "string" ? { accountScope: payload } : payload,
    );
  }

  activateCloudConversationCacheAuthority(
    payload: unknown,
  ): Promise<CloudConversationCachePurgeResult> {
    return this.getCloudConversationCacheStore().request("activate", payload);
  }

  getActiveCloudConversationCacheAuthority(): CloudConversationCacheLifecycleAuthority | null {
    return this.cloudConversationCacheStore?.getActiveAuthority() ?? null;
  }

  readCloudConversationCache(
    payload: unknown,
  ): Promise<CloudConversationCacheSnapshot | null> {
    return this.getCloudConversationCacheStore().request("read", payload);
  }

  replaceCloudConversationCache(
    payload: unknown,
  ): Promise<CloudConversationCacheReplaceResult> {
    return this.getCloudConversationCacheStore().request("replace", payload);
  }

  purgeCloudConversationCacheConversation(
    payload: unknown,
  ): Promise<CloudConversationCachePurgeResult> {
    return this.getCloudConversationCacheStore().request("purge", payload);
  }
}
