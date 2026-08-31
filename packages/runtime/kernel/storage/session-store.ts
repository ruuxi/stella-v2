/**
 * SessionStore: the storage layer's public API, composed from the typed
 * modules (ChatLog, ThreadLog, AgentRegistry, SearchIndex). Consumers keep
 * the same surface they had against the legacy store; the internals run on
 * the v1 schema where ordering, visibility, and turn structure are written
 * at insert time.
 */

import { ThreadSummaryStore } from "../memory/thread-summary-store.js";
import {
  asTrimmedString,
  type LocalChatEventRecord,
  type SqliteDatabase,
} from "./shared.js";
import { ChatLog, type ChatMessageWindow } from "./chat-log.js";
import { ThreadLog } from "./thread-log.js";
import { AgentRegistry, type AgentRecordInput } from "./agent-registry.js";
import { SearchIndex } from "./search.js";
import {
  AGENT_ASSISTANT_UPDATE_LIMITS,
  EAGER_TOOL_EVENT_LIMIT,
  EAGER_TOOL_EVENT_PAYLOAD_BYTES,
  FtsSearchUnavailableError,
  RECALL_THREAD_RESULT_EXCERPT_CHARS,
  projectLocalChatUpdateEvent,
  tokenizeSearchQuery,
  type Cursor,
  type ThreadMessageInput,
} from "./view.js";

export {
  AGENT_ASSISTANT_UPDATE_LIMITS,
  EAGER_TOOL_EVENT_LIMIT,
  EAGER_TOOL_EVENT_PAYLOAD_BYTES,
  FtsSearchUnavailableError,
  RECALL_THREAD_RESULT_EXCERPT_CHARS,
  projectLocalChatUpdateEvent,
  tokenizeSearchQuery,
};

export type SessionStoreOptions = {
  onThreadActivityUpdate?: (payload: unknown) => void;
  onThreadAssistantUpdate?: (payload: unknown) => void;
  onThreadTranscriptUpdate?: (payload: unknown) => void;
};

export class SessionStore {
  readonly db: SqliteDatabase;
  readonly options: SessionStoreOptions;
  private readonly chat: ChatLog;
  private readonly threads: ThreadLog;
  private readonly agents: AgentRegistry;
  private readonly search: SearchIndex;
  private threadSummaryStoreInstance: ThreadSummaryStore | null = null;
  private inTransaction = false;

  constructor(db: SqliteDatabase, options: SessionStoreOptions = {}) {
    this.db = db;
    this.options = options;
    const tx = { immediate: (work: () => void) => this.withImmediateTransaction(work) };
    this.chat = new ChatLog(db, tx);
    this.threads = new ThreadLog(db, tx, (conversationId, updatedAt) =>
      this.chat.ensureConversation(conversationId, updatedAt),
    );
    this.agents = new AgentRegistry(db, {
      ensureConversation: (conversationId, updatedAt) =>
        this.chat.ensureConversation(conversationId, updatedAt),
      refreshThreadSearchText: (threadId) =>
        this.threads.refreshThreadSearchText(threadId),
    });
    this.search = new SearchIndex(db);
  }

  get threadSummaryStore(): ThreadSummaryStore {
    if (!this.threadSummaryStoreInstance) {
      this.threadSummaryStoreInstance = new ThreadSummaryStore(this.db);
    }
    return this.threadSummaryStoreInstance;
  }

  /* ------------------------------------------------------------------ */
  /* Transactions                                                        */
  /* ------------------------------------------------------------------ */

  withTransaction(work: () => void): void {
    this.withImmediateTransaction(work);
  }

  withImmediateTransaction(work: () => void): void {
    if (this.inTransaction) {
      work();
      return;
    }
    this.db.exec("BEGIN IMMEDIATE;");
    this.inTransaction = true;
    try {
      work();
      this.db.exec("COMMIT;");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        /* the transaction may already be gone */
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  sanitizeConversationId(value: unknown): string {
    const conversationId = asTrimmedString(value);
    if (!conversationId) {
      throw new Error("conversationId is required.");
    }
    return conversationId;
  }

  /* ------------------------------------------------------------------ */
  /* Settings and conversations                                          */
  /* ------------------------------------------------------------------ */

  getSetting(key: string): string | null {
    return this.chat.getSetting(key);
  }

  setSetting(key: string, value: string): void {
    this.chat.setSetting(key, value);
  }

  upsertSession(sessionId: string, updatedAt: number): void {
    this.chat.ensureConversation(sessionId, updatedAt);
  }

  getOrCreateDefaultConversationId(): string {
    return this.chat.getOrCreateDefaultConversationId();
  }

  createNewDefaultConversationId(): string {
    return this.chat.createNewDefaultConversationId();
  }

  setActiveDefaultConversationId(conversationIdInput: unknown): void {
    this.chat.setActiveDefaultConversationId(
      this.sanitizeConversationId(conversationIdInput),
    );
  }

  createConversation(): string {
    return this.chat.createConversation();
  }

  deleteConversation(conversationIdInput: unknown): boolean {
    return this.chat.deleteConversation(
      this.sanitizeConversationId(conversationIdInput),
    );
  }

  listConversationSummaries(
    args: Parameters<ChatLog["listConversationSummaries"]>[0] = {},
  ) {
    return this.chat.listConversationSummaries(args);
  }

  /* ------------------------------------------------------------------ */
  /* Chat events                                                         */
  /* ------------------------------------------------------------------ */

  appendEvent(args: Parameters<ChatLog["appendEvent"]>[0]): LocalChatEventRecord {
    return this.chat.appendEvent({
      ...args,
      conversationId: this.sanitizeConversationId(args.conversationId),
    });
  }

  mergeEventPayload(args: {
    conversationId: unknown;
    eventId: string;
    patch: Record<string, unknown>;
  }): LocalChatEventRecord | null {
    return this.chat.mergeEventPayload({
      conversationId: this.sanitizeConversationId(args.conversationId),
      eventId: args.eventId,
      patch: args.patch,
    });
  }

  hasEvent(conversationIdInput: unknown, eventIdInput: string, typeInput?: string): boolean {
    return this.chat.hasEvent(
      this.sanitizeConversationId(conversationIdInput),
      eventIdInput,
      typeInput,
    );
  }

  hasEventId(eventIdInput: string, typeInput?: string): boolean {
    return this.chat.hasEventId(eventIdInput, typeInput);
  }

  getEventCursor(conversationIdInput: unknown, eventIdInput: string): Cursor | null {
    return this.chat.getEventCursor(
      this.sanitizeConversationId(conversationIdInput),
      eventIdInput,
    );
  }

  truncateConversationAtEvent(
    conversationIdInput: unknown,
    eventIdInput: string,
  ): { removed: number } {
    return this.chat.truncateConversationAtEvent(
      this.sanitizeConversationId(conversationIdInput),
      eventIdInput,
    );
  }

  forkConversationBeforeEvent(
    conversationIdInput: unknown,
    eventIdInput: string,
  ): { conversationId: string } | null {
    return this.chat.forkConversationBeforeEvent(
      this.sanitizeConversationId(conversationIdInput),
      eventIdInput,
    );
  }

  recordRunEvent(event: Parameters<ChatLog["recordRunEvent"]>[0]): void {
    this.chat.recordRunEvent(event);
  }

  listEvents(conversationIdInput: unknown, maxItems = 200): LocalChatEventRecord[] {
    return this.chat.listEvents(
      this.sanitizeConversationId(conversationIdInput),
      maxItems,
    );
  }

  listEventsBefore(
    conversationIdInput: unknown,
    opts: Parameters<ChatLog["listEventsBefore"]>[1],
  ): LocalChatEventRecord[] {
    return this.chat.listEventsBefore(
      this.sanitizeConversationId(conversationIdInput),
      opts,
    );
  }

  listLifecycleEventsByIds(eventIds: string[]): LocalChatEventRecord[] {
    return this.chat.listLifecycleEventsByIds(eventIds);
  }

  listRecentActivitySince(args: { sinceMs: number; limit?: number }) {
    return this.chat.listRecentActivitySince(args);
  }

  listActivity(
    conversationIdInput: unknown,
    args: Parameters<ChatLog["listActivity"]>[1] = {},
  ) {
    return this.chat.listActivity(
      this.sanitizeConversationId(conversationIdInput),
      args,
    );
  }

  listFiles(
    conversationIdInput: unknown,
    args: Parameters<ChatLog["listFiles"]>[1] = {},
  ) {
    return this.chat.listFiles(
      this.sanitizeConversationId(conversationIdInput),
      args,
    );
  }

  getEventCount(conversationIdInput: unknown): number {
    return this.chat.getEventCount(
      this.sanitizeConversationId(conversationIdInput),
    );
  }

  listSyncMessages(conversationIdInput: unknown, maxMessages?: number) {
    return this.chat.listSyncMessages(
      this.sanitizeConversationId(conversationIdInput),
      maxMessages,
    );
  }

  /* ------------------------------------------------------------------ */
  /* Message windows                                                     */
  /* ------------------------------------------------------------------ */

  listMessages(
    conversationIdInput: unknown,
    args: { maxVisibleMessages?: number } = {},
  ): ChatMessageWindow {
    return this.chat.listMessages(
      this.sanitizeConversationId(conversationIdInput),
      args,
    );
  }

  listMessagesBefore(
    conversationIdInput: unknown,
    args: Parameters<ChatLog["listMessagesBefore"]>[1],
  ): ChatMessageWindow {
    return this.chat.listMessagesBefore(
      this.sanitizeConversationId(conversationIdInput),
      args,
    );
  }

  listMessagesAfter(
    conversationIdInput: unknown,
    args: Parameters<ChatLog["listMessagesAfter"]>[1],
  ) {
    return this.chat.listMessagesAfter(
      this.sanitizeConversationId(conversationIdInput),
      args,
    );
  }

  listMessageToolEvents(
    conversationIdInput: unknown,
    args: Parameters<ChatLog["listMessageToolEvents"]>[1],
  ) {
    return this.chat.listMessageToolEvents(
      this.sanitizeConversationId(conversationIdInput),
      args,
    );
  }

  listMobileTaskContext(conversationIdInput: unknown, agentIds: string[]) {
    return this.chat.listMobileTaskContext(
      this.sanitizeConversationId(conversationIdInput),
      agentIds,
    );
  }

  findVisibleMessagePageEndAfter(
    conversationIdInput: unknown,
    maxVisibleMessages: number,
    after: Cursor,
  ): Cursor | null {
    return this.chat.findVisibleMessagePageEndAfter(
      this.sanitizeConversationId(conversationIdInput),
      maxVisibleMessages,
      after,
    );
  }

  findVisibleMessageCursorAfter(
    conversationIdInput: unknown,
    after: Cursor,
  ): Cursor | null {
    return this.chat.findVisibleMessageCursorAfter(
      this.sanitizeConversationId(conversationIdInput),
      after,
    );
  }

  hasMobileSyncEventsAfter(
    conversationIdInput: unknown,
    afterTimestampMs: number,
    afterId: string,
    afterSequence?: number,
  ): boolean {
    return this.chat.hasMobileSyncEventsAfter(
      this.sanitizeConversationId(conversationIdInput),
      afterTimestampMs,
      afterId,
      afterSequence,
    );
  }

  isMobileSyncCursorValid(
    conversationIdInput: unknown,
    cursorTimestampMs: number,
    cursorId: string,
    cursorSequence?: number,
  ): boolean {
    return this.chat.isMobileSyncCursorValid(
      this.sanitizeConversationId(conversationIdInput),
      cursorTimestampMs,
      cursorId,
      cursorSequence,
    );
  }

  /* ------------------------------------------------------------------ */
  /* Thread transcripts                                                  */
  /* ------------------------------------------------------------------ */

  deriveImplicitThreadMetadata(threadKey: string) {
    return this.threads.deriveImplicitThreadMetadata(threadKey);
  }

  ensureImplicitThreadRow(threadKey: string) {
    return this.threads.ensureImplicitThreadRow(threadKey);
  }

  getThreadConversationId(threadKey: string): string {
    return this.threads.getThreadConversationId(threadKey);
  }

  getThreadSession(threadKey: string) {
    return this.threads.getThreadSession(threadKey);
  }

  ensureThreadSession(threadKey: string, conversationId: string, timestamp: number) {
    return this.threads.ensureThreadSession(threadKey, conversationId, timestamp);
  }

  getThreadLeafEntryId(threadKey: string): string | null {
    return this.threads.getThreadLeafEntryId(threadKey);
  }

  appendThreadMessage(message: ThreadMessageInput): void {
    this.appendThreadMessages([message]);
  }

  appendThreadMessages(messages: ThreadMessageInput[]): void {
    const appended = this.threads.appendThreadMessages(messages);
    for (const { entryId, message, payload, conversationId } of appended) {
      if (!entryId) continue;
      try {
        this.options.onThreadTranscriptUpdate?.({
          conversationId,
          transcriptUpdate: {
            source: "stella",
            threadId: message.threadKey,
            entryId,
            atMs: message.timestamp,
          },
        });
        if (payload.role === "assistant") {
          this.emitThreadAssistantUpdate(message.threadKey, message.timestamp);
        }
      } catch {
        /* notification failures never fail the write */
      }
    }
  }

  appendThreadCustomMessage(
    message: Parameters<ThreadLog["appendThreadCustomMessage"]>[0],
  ): void {
    this.threads.appendThreadCustomMessage(message);
  }

  appendThreadLifecycleEvent(
    message: Parameters<ThreadLog["appendThreadLifecycleEvent"]>[0],
  ): void {
    this.threads.appendThreadLifecycleEvent(message);
  }

  hasThreadLifecycleEvent(threadKey: string, eventId: string): boolean {
    return this.threads.hasThreadLifecycleEvent(threadKey, eventId);
  }

  listThreadLifecycleEntries(threadKey: string, limit?: number) {
    return this.threads.listThreadLifecycleEntries(threadKey, limit);
  }

  listRecentThreadUserMessages(threadKey: string, limit?: number) {
    return this.threads.listRecentThreadUserMessages(threadKey, limit);
  }

  loadThreadMessages(threadKey: string, limit?: number) {
    return this.threads
      .loadThreadMessages(threadKey, limit)
      .map((message) => ({
        ...(message.entryId ? { entryId: message.entryId } : {}),
        timestamp: message.timestamp,
        role: message.role,
        content: message.content,
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.payload ? { payload: message.payload } : {}),
        ...(message.customMessage ? { customMessage: message.customMessage } : {}),
        ...(message.checkpointQuarantineKeys
          ? { checkpointQuarantineKeys: message.checkpointQuarantineKeys }
          : {}),
        ...(message.checkpointImageReceipts
          ? { checkpointImageReceipts: message.checkpointImageReceipts }
          : {}),
      }));
  }

  loadRawThreadMessages(threadKey: string) {
    return this.threads.loadRawThreadMessages(threadKey).map((message) => ({
      ...(message.entryId ? { entryId: message.entryId } : {}),
      timestamp: message.timestamp,
      role: message.role,
      content: message.content,
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.payload ? { payload: message.payload } : {}),
      ...(message.customMessage ? { customMessage: message.customMessage } : {}),
    }));
  }

  loadThreadSessionEntries(threadKey: string, limit?: number) {
    return this.threads.loadThreadSessionEntries(threadKey, limit);
  }

  findLatestRangeCompaction(threadKey: string) {
    return this.threads.findLatestRangeCompaction(threadKey);
  }

  getThreadContextPressureStats(threadKey: string) {
    return this.threads.getThreadContextPressureStats(threadKey);
  }

  compactThread(args: Parameters<ThreadLog["compactThread"]>[0]): void {
    const { entryId, conversationId, timestamp } =
      this.threads.compactThread(args);
    if (entryId) {
      this.options.onThreadTranscriptUpdate?.({
        conversationId,
        transcriptUpdate: {
          source: "stella",
          threadId: args.threadKey,
          entryId,
          atMs: timestamp,
        },
      });
    }
  }

  removeThreadMessageEntry(threadKey: string, entryId: string): boolean {
    return this.threads.removeThreadMessageEntry(threadKey, entryId);
  }

  listModelUsage(args: Parameters<ThreadLog["listModelUsage"]>[0] = {}) {
    return this.threads.listModelUsage(args);
  }

  /* ------------------------------------------------------------------ */
  /* Thread rows                                                         */
  /* ------------------------------------------------------------------ */

  listActiveThreads(conversationId: string) {
    return this.agents.listActiveThreads(conversationId);
  }

  listActiveThreadsByAge(conversationId: string) {
    return this.threads.listActiveThreadsByAge(conversationId);
  }

  evictOldestThread(conversationId: string): void {
    this.threads.evictOldestThread(conversationId);
  }

  reactivateThread(conversationId: string, threadId: string): void {
    this.threads.reactivateThread(conversationId, threadId);
  }

  threadKeyExists(key: string): boolean {
    return this.threads.threadKeyExists(key);
  }

  mintUniqueKey(base: string): string {
    return this.threads.mintUniqueKey(base);
  }

  mintThreadKey(args: { agentType: string; nameHint?: string }): string {
    return this.threads.mintThreadKey(args);
  }

  resolveOrCreateActiveThread(
    args: Parameters<ThreadLog["resolveOrCreateActiveThread"]>[0],
  ) {
    return this.threads.resolveOrCreateActiveThread(args);
  }

  touchThread(threadKey: string): void {
    this.threads.touchThread(threadKey);
  }

  getThreadExternalSessionId(threadKey: string): string | undefined {
    return this.threads.getThreadExternalSessionId(threadKey);
  }

  setThreadExternalSessionId(
    threadKey: string,
    externalSessionId: string | undefined,
  ): void {
    this.threads.setThreadExternalSessionId(threadKey, externalSessionId);
  }

  updateThreadSummary(threadKey: string, summary: string): void {
    this.threads.updateThreadSummary(threadKey, summary);
  }

  getThreadName(threadKey: string): string | undefined {
    return this.threads.getThreadName(threadKey);
  }

  getThreadActivityMetadata(threadId: string) {
    return this.threads.getThreadActivityMetadata(threadId);
  }

  /* ------------------------------------------------------------------ */
  /* Agents                                                              */
  /* ------------------------------------------------------------------ */

  saveAgentRecord(record: AgentRecordInput): number | null {
    return this.agents.saveAgentRecord(record);
  }

  getAgentRecord(threadId: string) {
    return this.agents.getAgentRecord(threadId);
  }

  listAgentRecordsByStatus(status: string) {
    return this.agents.listAgentRecordsByStatus(status);
  }

  listThreadResultExcerpts(threadIds: string[]) {
    return this.agents.listThreadResultExcerpts(threadIds);
  }

  listAgentAssistantMessagesByThread(
    targets: Parameters<AgentRegistry["listAgentAssistantMessagesByThread"]>[0],
    limit?: number,
  ) {
    return this.agents.listAgentAssistantMessagesByThread(targets, limit);
  }

  listAgentAssistantMessages(agentId: string, limit?: number) {
    return this.agents.listAgentAssistantMessages(agentId, limit);
  }

  selectBoundedThreadActivityIds(conversationId: string, maxItems: number) {
    return this.agents.selectBoundedThreadActivityIds(conversationId, maxItems);
  }

  listThreadActivity(
    conversationId: string,
    options: Parameters<AgentRegistry["listThreadActivity"]>[1] = {},
  ) {
    return this.agents.listThreadActivity(conversationId, options);
  }

  emitThreadAssistantUpdate(threadId: string, atMs: number): void {
    if (!this.options.onThreadAssistantUpdate) return;
    const record = this.agents.getAgentRecord(threadId);
    if (
      !record ||
      record.status !== "running" ||
      record.agentType !== "general" ||
      atMs < (record.startedAt as number)
    )
      return;
    const entries =
      this.agents
        .listAgentAssistantMessagesByThread([
          {
            threadId: record.threadId as string,
            startedAt: record.startedAt as number,
            attemptGeneration: record.attemptGeneration as number,
          },
        ])
        .get(record.threadId as string) ?? [];
    const latest = entries[entries.length - 1];
    if (!latest) return;
    const assistantMessages = entries.map((entry) => entry.text);
    this.options.onThreadAssistantUpdate({
      conversationId: record.conversationId,
      assistantUpdate: {
        threadId: record.threadId,
        assistantMessages,
        reasoningSummaries: [...assistantMessages],
        latestMessage: latest.text,
        atMs: latest.atMs,
        atSequence: latest.sequence,
        attemptGeneration: record.attemptGeneration,
        ...(record.rootRunId ? { rootRunId: record.rootRunId } : {}),
      },
    });
  }

  /* ------------------------------------------------------------------ */
  /* Search                                                              */
  /* ------------------------------------------------------------------ */

  searchThreads(args: Parameters<SearchIndex["searchThreads"]>[0]) {
    return this.search.searchThreads(args);
  }

  searchTranscripts(args: Parameters<SearchIndex["searchTranscripts"]>[0]) {
    return this.search.searchTranscripts(args);
  }

  listTranscriptNeighbors(
    args: Parameters<SearchIndex["listTranscriptNeighbors"]>[0],
  ) {
    return this.search.listTranscriptNeighbors(args);
  }

  threadFtsAvailable(): boolean {
    return this.search.threadFtsAvailable();
  }

  transcriptFtsAvailable(): boolean {
    return this.search.transcriptFtsAvailable();
  }

  /* ------------------------------------------------------------------ */
  /* Orchestrator reminder state                                         */
  /* ------------------------------------------------------------------ */

  getOrchestratorReminderState(conversationId: string): {
    shouldInjectDynamicReminder: boolean;
  } {
    const row = this.db
      .prepare(
        `SELECT force_reminder_on_next_turn AS forceReminderOnNextTurn
         FROM runtime_conversation_state
         WHERE conversation_id = ?
         LIMIT 1`,
      )
      .get(conversationId) as { forceReminderOnNextTurn?: number } | undefined;
    return {
      shouldInjectDynamicReminder: row?.forceReminderOnNextTurn === 1,
    };
  }

  forceOrchestratorReminderOnNextTurn(conversationId: string): void {
    this.db
      .prepare(
        `INSERT INTO runtime_conversation_state (
           conversation_id, force_reminder_on_next_turn
         ) VALUES (?, 1)
         ON CONFLICT(conversation_id) DO UPDATE SET
           force_reminder_on_next_turn = 1`,
      )
      .run(conversationId);
  }

  consumeOrchestratorReminder(conversationId: string): void {
    this.db
      .prepare(
        `UPDATE runtime_conversation_state
         SET force_reminder_on_next_turn = 0
         WHERE conversation_id = ?`,
      )
      .run(conversationId);
  }
}
