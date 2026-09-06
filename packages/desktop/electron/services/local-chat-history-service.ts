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
  TaskDecorationUpdatedPayload,
  ThreadActivityRecord,
} from "@stella/contracts/local-chat";
import type {
  ConversationFocusRoot,
  ReplyCounts,
} from "@stella/contracts/reply-refs";
import {
  buildMobileSyncMessagesPage,
  buildMobileSyncMessages,
  decodeMobileSyncCursor,
  type LocalChatMobileSyncResult,
  type LocalChatMobileHistoryPage,
  type LocalChatSyncMessageWithArtifacts,
} from "./local-chat-artifacts.js";
import { CloudConversationCacheClient } from "./cloud-conversation-cache-client.js";
import { listCanonicalConversationFilePaths } from "./canonical-conversation-file-paths.js";

type LocalChatHistoryServiceOptions = {
  stellaAppDir: string;
  onUpdated?: (payload: LocalChatUpdatedPayload | null) => void;
  /**
   * Fired when the mirrored task decoration (statusText / reasoning
   * summaries) changes. Wired to a mobile-only broadcast — desktop windows
   * maintain their own decoration stores from the live stream.
   */
  onTaskDecorationUpdated?: (payload: TaskDecorationUpdatedPayload) => void;
};

const openNodeSqliteDatabase = (dbPath: string): SqliteDatabase =>
  new DatabaseSync(dbPath) as unknown as SqliteDatabase;

const MOBILE_TASK_EVENT_TYPES = new Set([
  "agent-started",
  "agent-progress",
  "agent-completed",
  "agent-failed",
  "agent-canceled",
]);

const taskAgentIdsInMessages = (
  messages: readonly LocalChatMessageRecord[],
) => {
  const touched = new Set<string>();
  const anchored = new Set<string>();
  for (const message of messages) {
    for (const event of message.toolEvents) {
      if (!MOBILE_TASK_EVENT_TYPES.has(event.type)) continue;
      const agentId =
        typeof event.payload?.agentId === "string"
          ? event.payload.agentId.trim()
          : "";
      if (!agentId) continue;
      touched.add(agentId);
      if (event.type === "agent-started") anchored.add(agentId);
    }
  }
  return { touched, anchored };
};

const mergeTaskContextMessages = (
  messages: readonly LocalChatMessageRecord[],
  extra: readonly LocalChatMessageRecord[],
): LocalChatMessageRecord[] => {
  const byId = new Map<string, LocalChatMessageRecord>();
  for (const message of [...extra, ...messages]) {
    const existing = byId.get(message._id);
    if (!existing) {
      byId.set(message._id, message);
      continue;
    }
    const events = new Map(
      [...existing.toolEvents, ...message.toolEvents].map((event) => [
        event._id,
        event,
      ]),
    );
    byId.set(message._id, {
      ...existing,
      ...message,
      toolEvents: [...events.values()].sort(
        (a, b) => a.timestamp - b.timestamp || a._id.localeCompare(b._id),
      ),
    });
  }
  return [...byId.values()].sort((a, b) => {
    if (typeof a.sequence === "number" && typeof b.sequence === "number") {
      return a.sequence - b.sequence;
    }
    return a.timestamp - b.timestamp || a._id.localeCompare(b._id);
  });
};

export class LocalChatHistoryService {
  private db: SqliteDatabase | null = null;
  private store: SessionStore | null = null;
  private cloudConversationCacheStore: CloudConversationCacheClient | null =
    null;
  private readonly stellaAppDir: string;
  private readonly onUpdated?: (
    payload: LocalChatUpdatedPayload | null,
  ) => void;
  private readonly onTaskDecorationUpdated?: (
    payload: TaskDecorationUpdatedPayload,
  ) => void;
  private resetInProgress = false;
  /**
   * Latest per-agent mid-run statusText mirrored from the renderer's
   * task-decoration store via `publishTaskDecoration`. Same lifecycle as the
   * reasoning summaries above: in-memory only, replaced wholesale per publish,
   * present only for running threads (the renderer clears a thread's
   * decoration on its terminal stream event).
   */
  private statusTextByAgent = new Map<string, string>();
  /** Last decoration payload serialization, so repeat publishes don't re-broadcast. */
  private lastTaskDecorationSerialized = "";

  constructor(options: LocalChatHistoryServiceOptions) {
    this.stellaAppDir = options.stellaAppDir;
    this.onUpdated = options.onUpdated;
    this.onTaskDecorationUpdated = options.onTaskDecorationUpdated;
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

  /**
   * Truncate a conversation at (and including) a user message — the
   * desktop "Rewind here" action. Notifies the renderer with a
   * payload that omits `event`, forcing a full window re-read so removed
   * rows drop out of the visible timeline.
   */
  truncateConversation(args: { conversationId: string; eventId: string }): {
    removed: number;
  } {
    const result = this.getStore().truncateConversationAtEvent(
      args.conversationId,
      args.eventId,
    );
    this.onUpdated?.({ conversationId: args.conversationId });
    return result;
  }

  /**
   * Branch a conversation's prefix (everything before a user message)
   * into a brand-new conversation — the desktop "Fork to new chat"
   * action. Returns the new conversation id (or null when the anchor
   * event is gone). The source conversation is untouched; the renderer
   * navigates to the new conversation and subscribes fresh.
   */
  forkConversation(args: {
    conversationId: string;
    eventId: string;
  }): { conversationId: string } | null {
    const result = this.getStore().forkConversationBeforeEvent(
      args.conversationId,
      args.eventId,
    );
    if (result) {
      this.onUpdated?.({ conversationId: result.conversationId });
    }
    return result;
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
    view?: "mobile-summary";
    maxItems?: number;
  }): ThreadActivityRecord[] {
    return this.getStore().listThreadActivity(args.conversationId, {
      view: args.view,
      maxItems: args.maxItems,
    }) as unknown as ThreadActivityRecord[];
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

  /**
   * Mirror the renderer's per-thread mid-run statusText (the task-decoration
   * store) into the in-memory snapshot the mobile sync serializer reads.
   * Progress ticks are no longer persisted as message rows, so this mirror is
   * the only bridge-side source of a running task's current statusText.
   */
  setTaskDecoration(args: { statusTextByAgentId: Record<string, string> }): {
    ok: true;
  } {
    const next = new Map<string, string>();
    for (const [rawAgentId, rawText] of Object.entries(
      args.statusTextByAgentId ?? {},
    )) {
      const agentId = typeof rawAgentId === "string" ? rawAgentId.trim() : "";
      const text = typeof rawText === "string" ? rawText.trim() : "";
      if (agentId && text) next.set(agentId, text);
    }
    this.statusTextByAgent = next;
    this.emitTaskDecorationUpdated();
    return { ok: true };
  }

  /**
   * Push the status decoration snapshot
   * to the mobile bridge so the phone's activity pill updates mid-run without
   * a persisted event to resync from. Deduped against the last broadcast —
   * identical publishes stay silent.
   */
  private emitTaskDecorationUpdated(): void {
    if (!this.onTaskDecorationUpdated) return;
    const payload: TaskDecorationUpdatedPayload = {
      statusTextByAgentId: Object.fromEntries(this.statusTextByAgent),
    };
    const serialized = JSON.stringify(payload);
    if (serialized === this.lastTaskDecorationSerialized) return;
    this.lastTaskDecorationSerialized = serialized;
    this.onTaskDecorationUpdated(payload);
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
      this.statusTextByAgent,
    );
  }

  listSyncMessagesBefore(args: {
    conversationId: string;
    beforeTimestampMs: number;
    beforeId: string;
    maxMessages?: number;
    includeDeveloperArtifacts?: boolean;
  }): LocalChatMobileHistoryPage {
    const maxMessages = Math.max(1, Math.floor(args.maxMessages ?? 100));
    const { messages, visibleMessageCount } =
      this.getStore().listMessagesBefore(args.conversationId, {
        beforeTimestampMs: args.beforeTimestampMs,
        beforeId: args.beforeId,
        maxVisibleMessages: maxMessages + 1,
      });
    // A historical page may contain an old task anchor whose completion is
    // newer than the page cursor, or only a lifecycle row whose anchor is on
    // an earlier page. Resolve just the touched task ids across the complete
    // conversation so old pages project today's task/artifact state without a
    // whole-transcript scan.
    const { touched } = taskAgentIdsInMessages(messages);
    const targetedTaskContext =
      touched.size > 0
        ? this.getStore().listMobileTaskContext(args.conversationId, [
            ...touched,
          ]).messages
        : [];
    const taskContextMessages = mergeTaskContextMessages(
      messages,
      targetedTaskContext,
    );
    const projected = buildMobileSyncMessages(
      messages,
      Math.max(1, messages.length * 2),
      {
        includeDeveloperArtifacts: args.includeDeveloperArtifacts === true,
      },
      this.getAssistantMessagesByAgent(args.conversationId),
      taskContextMessages,
      this.statusTextByAgent,
    );
    // One durable user row can project both its visible bubble and a synthetic
    // agent-work bubble. Page whole source groups so a row is never split at
    // the output limit (which would make the missing sibling unreachable).
    const sourceIdsNewestFirst: string[] = [];
    const seenSourceIds = new Set<string>();
    const projectedCountBySource = new Map<string, number>();
    for (const message of projected) {
      projectedCountBySource.set(
        message.sourceMessageId,
        (projectedCountBySource.get(message.sourceMessageId) ?? 0) + 1,
      );
    }
    let remainingProjectedRows = maxMessages;
    for (let index = projected.length - 1; index >= 0; index -= 1) {
      const sourceId = projected[index]!.sourceMessageId;
      if (seenSourceIds.has(sourceId)) continue;
      const groupSize = projectedCountBySource.get(sourceId) ?? 1;
      if (
        sourceIdsNewestFirst.length > 0 &&
        groupSize > remainingProjectedRows
      ) {
        break;
      }
      seenSourceIds.add(sourceId);
      sourceIdsNewestFirst.push(sourceId);
      remainingProjectedRows -= groupSize;
      if (remainingProjectedRows <= 0) break;
    }
    const keptSourceIds = new Set(sourceIdsNewestFirst);
    const page = projected.filter((message) =>
      keptSourceIds.has(message.sourceMessageId),
    );
    const oldestProjected = page[0];
    const oldestRaw = messages[0];
    const oldestSourceCursor = oldestProjected
      ? {
          timestamp: oldestProjected.sourceTimestamp,
          id: oldestProjected.sourceMessageId,
        }
      : oldestRaw
        ? { timestamp: oldestRaw.timestamp, id: oldestRaw._id }
        : null;
    return {
      messages: page,
      hasOlder:
        visibleMessageCount > maxMessages ||
        (Boolean(projected[0]) &&
          projected[0]!.sourceMessageId !== page[0]?.sourceMessageId),
      oldestSourceCursor,
    };
  }

  syncMessages(args: {
    conversationId: string;
    sinceCursor?: string | null;
    maxMessages?: number;
    includeDeveloperArtifacts?: boolean;
  }): LocalChatMobileSyncResult {
    const maxMessages = Math.max(1, Math.floor(args.maxMessages ?? 100));
    const artifactOptions = {
      includeDeveloperArtifacts: args.includeDeveloperArtifacts === true,
    };
    const requestedCursor = args.sinceCursor?.trim() || null;
    const cursor = decodeMobileSyncCursor(requestedCursor);
    const cursorIsValid = Boolean(
      cursor &&
        this.getStore().isMobileSyncCursorValid(
          args.conversationId,
          cursor.timestamp,
          cursor.id,
          cursor.sequence,
        ),
    );
    if (cursor && cursorIsValid) {
      if (
        !this.getStore().hasMobileSyncEventsAfter(
          args.conversationId,
          cursor.timestamp,
          cursor.id,
          cursor.sequence,
        )
      ) {
        return {
          messages: [],
          cursor: requestedCursor,
          cursorStatus: "valid",
          hasMore: false,
        };
      }
      const { messages, sourceEvents } = this.getStore().listMessagesAfter(
        args.conversationId,
        {
          afterTimestampMs: cursor.timestamp,
          afterId: cursor.id,
          afterSequence: cursor.sequence,
          maxVisibleMessages: maxMessages,
          includeSourceEvents: true,
        },
      );
      const { touched, anchored } = taskAgentIdsInMessages(messages);
      const missingAnchors = [...touched].filter(
        (agentId) => !anchored.has(agentId),
      );
      const targetedTaskContext =
        missingAnchors.length > 0
          ? this.getStore().listMobileTaskContext(
              args.conversationId,
              missingAnchors,
            ).messages
          : [];
      const taskContextMessages = mergeTaskContextMessages(
        messages,
        targetedTaskContext,
      );
      const page = buildMobileSyncMessagesPage(
        messages,
        maxMessages,
        sourceEvents,
        artifactOptions,
        this.getAssistantMessagesByAgent(args.conversationId),
        taskContextMessages,
        this.statusTextByAgent,
      );
      const pageCursor = decodeMobileSyncCursor(page.cursor);
      const hasMore = Boolean(
        pageCursor &&
          this.getStore().hasMobileSyncEventsAfter(
            args.conversationId,
            pageCursor.timestamp,
            pageCursor.id,
            pageCursor.sequence,
          ),
      );
      return { ...page, cursorStatus: "valid", hasMore };
    }

    const { messages } = this.getStore().listMessages(args.conversationId, {
      maxVisibleMessages: maxMessages,
    });
    const page = buildMobileSyncMessagesPage(
      messages,
      maxMessages,
      messages,
      artifactOptions,
      this.getAssistantMessagesByAgent(args.conversationId),
      messages,
      this.statusTextByAgent,
    );
    return {
      ...page,
      cursorStatus: requestedCursor ? "invalid" : "snapshot",
      hasMore: false,
    };
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
