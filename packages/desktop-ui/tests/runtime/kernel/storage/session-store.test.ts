import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "@stella/runtime/kernel/storage/database-init";
import {
  SessionStore,
  projectLocalChatUpdateEvent,
} from "../../../../../runtime/kernel/storage/session-store.js";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";
import {
  getThreadImageHistoryStats,
  maybeCompactRuntimeThread,
  parseThreadCheckpoint,
} from "@stella/runtime/kernel/thread-runtime";
import { withForcedThreadCompaction } from "@stella/runtime/kernel/agent-runtime/context-budget";

type TestContext = {
  rootPath: string;
  db: SqliteDatabase;
  store: SessionStore;
};

const activeContexts = new Set<TestContext>();

const appendUserThreadMessages = (
  store: SessionStore,
  threadId: string,
  count: number,
) => {
  for (let index = 0; index < count; index += 1) {
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 8_500 + index,
      role: "user",
      content: `Graph message ${index}`,
      payload: {
        role: "user",
        content: `Graph message ${index}`,
        timestamp: 8_500 + index,
      },
    });
  }
  return store.loadThreadMessages(threadId);
};

const createTestContext = (): TestContext => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-session-store-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const dbPath = getDesktopDatabasePath(rootPath);
  const db = new DatabaseSync(dbPath, {
    timeout: 5000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const context = {
    rootPath,
    db,
    store: new SessionStore(db),
  };
  activeContexts.add(context);
  return context;
};

afterEach(async () => {
  for (const context of activeContexts) {
    context.db.close();
    await rm(context.rootPath, { recursive: true, force: true });
  }
  activeContexts.clear();
});

describe("session-store", () => {
  it("does not arm an Other Threads roster when a child summary changes", () => {
    const { store } = createTestContext();
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-child-summary",
      agentType: "general",
    });

    store.updateThreadSummary(threadId, "Child summary changed.");

    expect(
      store.getOrchestratorReminderState("conv-child-summary")
        .shouldInjectDynamicReminder,
    ).toBe(false);
  });

  it("keeps a compaction-owned roster flag armed until durable consumption", () => {
    const { store } = createTestContext();
    const conversationId = "conv-roster-consumption";

    store.forceOrchestratorReminderOnNextTurn(conversationId);
    expect(
      store.getOrchestratorReminderState(conversationId)
        .shouldInjectDynamicReminder,
    ).toBe(true);

    store.consumeOrchestratorReminder(conversationId);
    expect(
      store.getOrchestratorReminderState(conversationId)
        .shouldInjectDynamicReminder,
    ).toBe(false);
  });

  it("rolls back an entire assistant/tool group when one SQLite append fails", () => {
    const { db, store } = createTestContext();
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-atomic-tool-group",
      agentType: "orchestrator",
    });
    const originalAppend = store.appendThreadSessionEntry.bind(store);
    let appendCount = 0;
    vi.spyOn(store, "appendThreadSessionEntry").mockImplementation((args) => {
      appendCount += 1;
      if (appendCount === 2) {
        throw new Error("injected SQLite failure");
      }
      return originalAppend(args);
    });

    expect(() =>
      store.appendThreadMessages([
        {
          threadKey: threadId,
          timestamp: 2_100,
          role: "assistant",
          content: "Running two tools",
          payload: {
            role: "assistant",
            content: [
              { type: "text", text: "A".repeat(6_100_000) },
              { type: "toolCall", id: "call-a", name: "a", arguments: {} },
              { type: "toolCall", id: "call-b", name: "b", arguments: {} },
            ],
            api: "openai-completions",
            provider: "openai",
            model: "test-model",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "toolUse",
            timestamp: 2_100,
          },
          preservePayloadExactly: true,
        },
        {
          threadKey: threadId,
          timestamp: 2_101,
          role: "toolResult",
          content: "first result",
          toolCallId: "call-a",
          payload: {
            role: "toolResult",
            toolCallId: "call-a",
            toolName: "a",
            content: [{ type: "text", text: "first result" }],
            isError: false,
            timestamp: 2_101,
          },
          preservePayloadExactly: true,
        },
        {
          threadKey: threadId,
          timestamp: 2_102,
          role: "toolResult",
          content: "second result",
          toolCallId: "call-b",
          payload: {
            role: "toolResult",
            toolCallId: "call-b",
            toolName: "b",
            content: [{ type: "text", text: "second result" }],
            isError: false,
            timestamp: 2_102,
          },
          preservePayloadExactly: true,
        },
      ]),
    ).toThrow("injected SQLite failure");

    expect(store.loadRawThreadMessages(threadId)).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM runtime_thread_entry_payload_chunks",
        )
        .get()?.count,
    ).toBe(0);
  });

  it("migrates v1 append-sequence rows to the canonical insertion sequence", async () => {
    const rootPath = path.join(
      os.tmpdir(),
      `stella-session-store-v1-thread-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(rootPath, { recursive: true });
    const db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
      timeout: 5000,
    }) as unknown as SqliteDatabase;
    db.exec(`
      CREATE TABLE runtime_thread_entries (
        entry_id TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        parent_entry_id TEXT,
        entry_type TEXT NOT NULL,
        timestamp_iso TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        append_seq INTEGER,
        data_json TEXT
      );
      CREATE INDEX idx_runtime_thread_entries_thread_append
      ON runtime_thread_entries(thread_key, append_seq);
    `);
    const insertLegacy = db.prepare(`
      INSERT INTO runtime_thread_entries (
        entry_id, thread_key, session_id, parent_entry_id, entry_type,
        timestamp_iso, created_at, append_seq, data_json
      ) VALUES (?, 'legacy-thread', 'legacy-session', ?, ?, ?, ?, ?, ?)
    `);
    const timestamp = 1_700_000_000_000;
    insertLegacy.run(
      "legacy-random-z",
      null,
      "message",
      new Date(timestamp).toISOString(),
      timestamp,
      1,
      JSON.stringify({
        message: { role: "user", content: "Legacy first", timestamp },
      }),
    );
    insertLegacy.run(
      "legacy-random-a",
      "legacy-random-z",
      "custom_message",
      new Date(timestamp).toISOString(),
      timestamp,
      2,
      JSON.stringify({
        customType: "managed-child-terminal",
        content: "Legacy sibling event",
        display: false,
        eventId: "legacy-child-event",
      }),
    );
    insertLegacy.run(
      "legacy-random-m",
      "legacy-random-z",
      "message",
      new Date(timestamp).toISOString(),
      timestamp,
      3,
      JSON.stringify({
        message: { role: "user", content: "Legacy second", timestamp },
      }),
    );

    initializeDesktopDatabase(db);
    const context = { rootPath, db, store: new SessionStore(db) };
    activeContexts.add(context);

    expect(
      context.store
        .loadThreadMessages("legacy-thread")
        .map((message) => message.content),
    ).toEqual(["Legacy first", "Legacy sibling event", "Legacy second"]);
    expect(
      db
        .prepare(
          `SELECT insertion_sequence AS insertionSequence
           FROM runtime_thread_entries
           WHERE thread_key = 'legacy-thread'
           ORDER BY insertion_sequence`,
        )
        .all(),
    ).toEqual([
      { insertionSequence: 1 },
      { insertionSequence: 2 },
      { insertionSequence: 3 },
    ]);
    expect(
      db
        .prepare(
          `SELECT 1 FROM sqlite_schema
           WHERE type = 'index'
             AND name = 'idx_runtime_thread_entries_thread_append'`,
        )
        .get(),
    ).toBeUndefined();

    db.prepare(
      `INSERT INTO runtime_thread_entries (
         entry_id, thread_key, session_id, parent_entry_id, entry_type,
         timestamp_iso, created_at, data_json
       ) VALUES (?, 'legacy-thread', 'legacy-session', ?, 'message', ?, ?, ?)`,
    ).run(
      "legacy-random-new",
      "legacy-random-m",
      new Date(timestamp).toISOString(),
      timestamp,
      JSON.stringify({
        message: { role: "user", content: "Imported later", timestamp },
      }),
    );
    expect(
      db
        .prepare(
          `SELECT insertion_sequence AS insertionSequence
           FROM runtime_thread_entries
           WHERE entry_id = 'legacy-random-new'`,
        )
        .get(),
    ).toMatchObject({ insertionSequence: 4 });
  });

  it("projects durable provider usage by conversation and agent thread", () => {
    const { store } = createTestContext();
    const conversationId = "conversation-usage";
    const orchestrator = store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "orchestrator",
      nameHint: "Orchestrator",
    });
    const agent = store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "general",
      nameHint: "Research pricing",
    });
    store.saveAgentRecord({
      threadId: agent.threadId,
      conversationId,
      agentType: "general",
      description: "Research pricing",
      agentDepth: 1,
      parentAgentId: orchestrator.threadId,
      rootRunId: "run-usage",
      status: "completed",
      startedAt: 150,
      completedAt: 210,
      updatedAt: 210,
    });

    const appendUsage = (
      threadKey: string,
      timestamp: number,
      model: string,
      input: number,
      cacheRead: number,
      output: number,
      reasoning: number,
      totalCost: number,
    ) =>
      store.appendThreadMessage({
        threadKey,
        role: "assistant",
        content: "done",
        timestamp,
        payload: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          api: "openai-responses",
          provider: "fireworks",
          model,
          usage: {
            input,
            cacheRead,
            cacheWrite: 0,
            output,
            reasoning,
            totalTokens: input + cacheRead + output,
            cost: {
              input: totalCost / 4,
              cacheRead: totalCost / 4,
              cacheWrite: 0,
              output: totalCost / 2,
              total: totalCost,
            },
          },
          stopReason: "stop",
          timestamp,
        },
      });

    appendUsage(
      orchestrator.threadId,
      100,
      "deepseek-v4-flash",
      100,
      200,
      50,
      20,
      0.01,
    );
    appendUsage(
      agent.threadId,
      200,
      "deepseek-v4-flash",
      300,
      400,
      60,
      30,
      0.02,
    );

    expect(store.listModelUsage({ conversationId })).toEqual({
      truncated: false,
      records: [
        expect.objectContaining({
          timestamp: 200,
          threadId: agent.threadId,
          agentType: "general",
          agentDescription: "Research pricing",
          agentDepth: 1,
          parentAgentId: orchestrator.threadId,
          rootRunId: "run-usage",
          inputTokens: 300,
          cacheReadTokens: 400,
          outputTokens: 60,
          reasoningTokens: 30,
          totalCostUsd: 0.02,
        }),
        expect.objectContaining({
          timestamp: 100,
          threadId: orchestrator.threadId,
          agentType: "orchestrator",
          totalCostUsd: 0.01,
        }),
      ],
    });
    expect(
      store.listModelUsage({ threadId: agent.threadId, limit: 1 }),
    ).toMatchObject({
      truncated: false,
      records: [{ threadId: agent.threadId }],
    });
    expect(store.listModelUsage({ conversationId, limit: 1 })).toMatchObject({
      truncated: true,
      records: [{ threadId: agent.threadId }],
    });
  });

  it("serves listModelUsage from the partial usage index instead of a table scan", () => {
    const { db } = createTestContext();
    // Mirrors the static WHERE / ORDER BY of SessionStore.listModelUsage —
    // these clauses must stay textually in sync with the WHERE of
    // idx_runtime_thread_entries_usage for the partial-index prover to
    // accept the index.
    const plan = db
      .prepare(
        `
      EXPLAIN QUERY PLAN
      SELECT entry.entry_id
      FROM runtime_thread_entries entry
      JOIN runtime_threads thread ON thread.thread_key = entry.thread_key
      LEFT JOIN runtime_agents agent ON agent.thread_id = thread.thread_key
      LEFT JOIN session ON session.id = thread.conversation_id
      WHERE entry.entry_type = 'message'
        AND json_extract(entry.data_json, '$.message.role') = 'assistant'
        AND json_type(entry.data_json, '$.message.usage') = 'object'
        AND COALESCE(json_extract(entry.data_json, '$.message.model'), '') != 'history'
      ORDER BY entry.created_at DESC, entry.entry_id DESC
      LIMIT ?
    `,
      )
      .all(100) as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail);

    const entryStep = details.find((detail) => detail.includes("entry"));
    expect(entryStep).toContain("USING INDEX idx_runtime_thread_entries_usage");
    // The index also satisfies the recency ORDER BY — no temp sort.
    expect(details.join("\n")).not.toContain("TEMP B-TREE");
  });

  it("persists parent-owned lifecycle entries outside model-visible thread messages", () => {
    const { store } = createTestContext();
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conversation-nested-lifecycle",
      agentType: "general",
      nameHint: "Parent agent",
    });
    const started = {
      _id: "child-agent:1:agent-started",
      timestamp: 200,
      type: "agent-started",
      payload: {
        agentId: "child-agent",
        parentAgentId: threadId,
        description: "Inspect nested state",
      },
    };
    const completed = {
      _id: "child-agent:1:agent-completed",
      timestamp: 201,
      type: "agent-completed",
      payload: { agentId: "child-agent", result: "Nested work finished" },
    };

    store.appendThreadLifecycleEvent({ threadKey: threadId, event: started });
    store.appendThreadLifecycleEvent({ threadKey: threadId, event: completed });

    expect(store.hasThreadLifecycleEvent(threadId, started._id)).toBe(true);
    expect(store.hasThreadLifecycleEvent(threadId, "missing-event")).toBe(
      false,
    );
    expect(store.listThreadLifecycleEntries(threadId)).toEqual([
      { entryId: expect.any(String), event: started },
      { entryId: expect.any(String), event: completed },
    ]);
    expect(store.listThreadLifecycleEntries(threadId, 1)).toEqual([
      { entryId: expect.any(String), event: completed },
    ]);
    expect(store.loadThreadMessages(threadId)).toEqual([]);
    expect(() =>
      store.appendThreadLifecycleEvent({
        threadKey: threadId,
        event: { ...started, type: "user_message" },
      }),
    ).toThrow("A valid lifecycle event is required");
  });

  it("migrates legacy agent rows with a zero ownership generation", async () => {
    const rootPath = path.join(
      os.tmpdir(),
      `stella-session-store-legacy-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(rootPath, { recursive: true });
    const db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
      timeout: 5000,
    }) as unknown as SqliteDatabase;
    db.exec(`
      CREATE TABLE runtime_agents (
        thread_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        description TEXT NOT NULL,
        agent_depth INTEGER NOT NULL,
        max_agent_depth INTEGER,
        parent_agent_id TEXT,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        result TEXT,
        error TEXT,
        updated_at INTEGER NOT NULL,
        root_run_id TEXT
      );
      INSERT INTO runtime_agents (
        thread_id, conversation_id, agent_type, description, agent_depth,
        status, started_at, updated_at
      ) VALUES (
        'legacy-agent', 'legacy-conversation', 'general', 'Legacy row', 1,
        'completed', 1, 2
      );
    `);
    initializeDesktopDatabase(db);
    const context = { rootPath, db, store: new SessionStore(db) };
    activeContexts.add(context);

    expect(context.store.getAgentRecord("legacy-agent")).toMatchObject({
      threadId: "legacy-agent",
      attemptGeneration: 0,
    });
    const columns = db
      .prepare("PRAGMA table_info(runtime_agents)")
      .all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toContain("model_config_json");
  });

  it("round-trips a Manager's inherited model configuration", () => {
    const { store } = createTestContext();
    const modelConfigSnapshot = {
      engine: "codex_cli" as const,
      routeModel: "stella/openai/gpt-5.6-sol",
      engineModel: "gpt-5.6-codex",
      reasoningEffort: "high" as const,
    };
    store.saveAgentRecord({
      threadId: "manager-model-route",
      conversationId: "conversation-model-route",
      agentType: "manager",
      description: "Coordinate work",
      agentDepth: 1,
      status: "completed",
      attemptGeneration: 2,
      startedAt: 1,
      completedAt: 2,
      updatedAt: 2,
      modelConfigSnapshot,
    });

    expect(
      store.getAgentRecord("manager-model-route")?.modelConfigSnapshot,
    ).toEqual(modelConfigSnapshot);
    expect(
      store.listAgentRecordsByStatus("completed")[0]?.modelConfigSnapshot,
    ).toEqual(modelConfigSnapshot);
  });

  it("starts a fresh default conversation without deleting old messages", () => {
    const { store } = createTestContext();
    const firstConversationId = store.getOrCreateDefaultConversationId();
    store.appendEvent({
      conversationId: firstConversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "Keep this" },
    });

    const nextConversationId = store.createNewDefaultConversationId();

    expect(nextConversationId).not.toBe(firstConversationId);
    expect(store.getOrCreateDefaultConversationId()).toBe(nextConversationId);
    expect(
      store.listMessages(nextConversationId, { maxVisibleMessages: 10 })
        .messages,
    ).toEqual([]);
    expect(
      store
        .listMessages(firstConversationId, { maxVisibleMessages: 10 })
        .messages.map((message) => message.payload.text),
    ).toEqual(["Keep this"]);
  });

  it("reconstructs chat events from session, message, and part rows", () => {
    const { db, store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    const userEvent = store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "Plan a trip" },
    });
    store.appendEvent({
      conversationId,
      type: "tool_request",
      timestamp: 1_001,
      requestId: "tool-1",
      payload: { toolName: "web", args: { query: "weather" } },
    });
    const assistantEvent = store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_002,
      payload: { text: "Here are some options." },
    });

    expect(
      store.listEvents(conversationId, 10).map((event) => event.type),
    ).toEqual(["user_message", "tool_request", "assistant_message"]);
    expect(store.getEventCount(conversationId)).toBe(3);

    store.setSyncCheckpoint(conversationId, assistantEvent._id);
    expect(store.getSyncCheckpoint(conversationId)).toBe(assistantEvent._id);

    const messageRows = db
      .prepare(
        `
      SELECT id, type, role
      FROM message
      WHERE session_id = ?
      ORDER BY created_at ASC, id ASC
    `,
      )
      .all(conversationId) as Array<{ id: string; type: string; role: string }>;
    expect(
      messageRows.map((row) => ({ type: row.type, role: row.role })),
    ).toEqual([
      { type: "user_message", role: "user" },
      { type: "tool_request", role: "tool" },
      { type: "assistant_message", role: "assistant" },
    ]);
    expect(messageRows[0]?.id).toBe(userEvent._id);
    expect(messageRows[2]?.id).toBe(assistantEvent._id);

    const oldTables = db
      .prepare(
        `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN (
          'chat_conversations',
          'chat_events',
          'chat_sync_checkpoints',
          'runtime_thread_messages',
          'runtime_run_events',
          'runtime_memories'
        )
      ORDER BY name ASC
    `,
      )
      .all() as Array<{ name: string }>;
    expect(oldTables).toEqual([]);
  });

  it("anchors turn tools to the first assistant of the turn, falling back to the user_message when none exists", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    const userA = store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "Make a chart" },
    });
    const assistantA = store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_001,
      payload: { text: "On it." },
    });
    store.appendEvent({
      conversationId,
      type: "tool_request",
      timestamp: 1_002,
      requestId: "req-1",
      payload: { toolName: "image_gen", args: {} },
    });
    store.appendEvent({
      conversationId,
      type: "tool_result",
      timestamp: 1_003,
      requestId: "req-1",
      payload: { toolName: "image_gen", resultPreview: "[image]" },
    });
    store.appendEvent({
      conversationId,
      type: "agent-completed",
      timestamp: 1_004,
      payload: { agentId: "agent-1", result: "ok" },
    });

    const userB = store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 2_000,
      payload: { text: "Try again" },
    });
    // Tool fires BEFORE any assistant in this second turn. No assistant
    // in turn → user_message is anchor.
    store.appendEvent({
      conversationId,
      type: "tool_request",
      timestamp: 2_001,
      requestId: "req-2",
      payload: { toolName: "image_gen", args: { prompt: "which?" } },
    });

    const { messages } = store.listMessages(conversationId, {
      maxVisibleMessages: 10,
    });
    expect(messages.map((m) => m._id)).toEqual([
      userA._id,
      assistantA._id,
      userB._id,
    ]);
    expect(messages[0]?.toolEvents).toEqual([]);
    expect(messages[1]?.toolEvents.map((event) => event.type)).toEqual([
      "tool_request",
      "tool_result",
      "agent-completed",
    ]);
    expect(messages[2]?.toolEvents.map((event) => event.type)).toEqual([
      "tool_request",
    ]);
  });

  it("attaches pre-reply tool outputs to the assistant when one fires later in the turn", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    // Regression: orchestrator emits image_gen BEFORE its reply text.
    // The renderer derives inline artifact cards from assistant rows
    // only — these tools must anchor on the assistant to render.
    const userA = store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "draw a cat" },
    });
    store.appendEvent({
      conversationId,
      type: "tool_request",
      timestamp: 1_001,
      payload: { toolName: "image_gen", args: { prompt: "cat" } },
    });
    store.appendEvent({
      conversationId,
      type: "tool_result",
      timestamp: 1_002,
      payload: { toolName: "image_gen" },
    });
    const assistantA = store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_003,
      payload: { text: "Here's the cat." },
    });

    const { messages } = store.listMessages(conversationId, {
      maxVisibleMessages: 10,
    });
    expect(messages.map((m) => m._id)).toEqual([userA._id, assistantA._id]);
    expect(messages[0]?.toolEvents).toEqual([]);
    expect(messages[1]?.toolEvents.map((e) => e.type)).toEqual([
      "tool_request",
      "tool_result",
    ]);
  });

  it("does not anchor tool outputs to hidden assistant messages", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    const userA = store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "show this in HTML" },
    });
    store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_001,
      payload: {
        text: "[TOOL CALL: html]",
        metadata: { ui: { visibility: "hidden" } },
      },
    });
    store.appendEvent({
      conversationId,
      type: "tool_request",
      timestamp: 1_002,
      payload: { toolName: "html" },
    });
    store.appendEvent({
      conversationId,
      type: "tool_result",
      timestamp: 1_003,
      payload: { toolName: "html" },
    });
    const assistantA = store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_004,
      payload: { text: "Done." },
    });

    const { messages } = store.listMessages(conversationId, {
      maxVisibleMessages: 10,
    });

    expect(messages.map((m) => m._id)).toEqual([userA._id, assistantA._id]);
    expect(messages[1]?.toolEvents.map((e) => e.type)).toEqual([
      "tool_request",
      "tool_result",
    ]);
  });

  it("reports visibleMessageCount excluding UI-hidden user messages", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "hi" },
    });
    store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_001,
      payload: { text: "hello" },
    });
    store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_002,
      payload: {
        text: "<reminder>",
        metadata: { ui: { visibility: "hidden" } },
      },
    });
    store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_003,
      payload: { text: "next prompt" },
    });

    const { messages, visibleMessageCount } = store.listMessages(
      conversationId,
      { maxVisibleMessages: 10 },
    );
    expect(messages).toHaveLength(3);
    // 3 visible (user, assistant, user) — the hidden reminder doesn't
    // count toward the chat's "how many visible messages do we have"
    // metric used for pagination.
    expect(visibleMessageCount).toBe(3);
  });

  it("listMessages caps the window by visible message count regardless of tool density", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    for (let i = 0; i < 5; i += 1) {
      const baseTs = 1_000 + i * 100;
      store.appendEvent({
        conversationId,
        type: "user_message",
        timestamp: baseTs,
        payload: { text: `user ${i}` },
      });
      store.appendEvent({
        conversationId,
        type: "assistant_message",
        timestamp: baseTs + 1,
        payload: { text: `asst ${i}` },
      });
      // 10 tool events per turn — would dominate a raw-event cap.
      for (let t = 0; t < 10; t += 1) {
        store.appendEvent({
          conversationId,
          type: "tool_request",
          timestamp: baseTs + 2 + t,
          requestId: `req-${i}-${t}`,
          payload: { toolName: "exec_command", args: { cmd: "echo" } },
        });
      }
    }

    const { messages } = store.listMessages(conversationId, {
      maxVisibleMessages: 4,
    });
    // 4 visible messages → 2 turns from the tail.
    expect(messages).toHaveLength(4);
    expect(messages.map((m) => m.payload?.text)).toEqual([
      "user 3",
      "asst 3",
      "user 4",
      "asst 4",
    ]);
    // Each assistant should keep its 10 turn tools (no raw-event cap
    // truncating them).
    expect(messages[1]?.toolEvents).toHaveLength(10);
    expect(messages[3]?.toolEvents).toHaveLength(10);
  });

  it("keeps tool events for the oldest assistant when the message window starts mid-turn", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "old setup" },
    });
    store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_001,
      payload: { text: "old reply" },
    });
    store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 2_000,
      payload: { text: "draw a chart" },
    });
    store.appendEvent({
      conversationId,
      type: "tool_request",
      timestamp: 2_001,
      requestId: "chart",
      payload: { toolName: "image_gen", args: { prompt: "chart" } },
    });
    store.appendEvent({
      conversationId,
      type: "tool_result",
      timestamp: 2_002,
      requestId: "chart",
      payload: { toolName: "image_gen", resultPreview: "[chart]" },
    });
    const cutoffAssistant = store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 2_003,
      payload: { text: "Here is the chart." },
    });
    const latestUser = store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 3_000,
      payload: { text: "thanks" },
    });

    const { messages, visibleMessageCount } = store.listMessages(
      conversationId,
      { maxVisibleMessages: 2 },
    );

    expect(visibleMessageCount).toBe(2);
    expect(messages.map((m) => m._id)).toEqual([
      cutoffAssistant._id,
      latestUser._id,
    ]);
    expect(messages[0]?.toolEvents.map((event) => event.type)).toEqual([
      "tool_request",
      "tool_result",
    ]);
  });

  it("listMessages skips UI-hidden user messages when computing the visible cutoff", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    // 3 visible turns, then 5 hidden system reminders, then 2 more
    // visible turns. With maxVisibleMessages=4 the cutoff must look
    // past the hidden block to include 2 user messages from earlier
    // turns rather than returning just the 2 latest visible ones.
    for (let i = 0; i < 3; i += 1) {
      store.appendEvent({
        conversationId,
        type: "user_message",
        timestamp: 1_000 + i * 10,
        payload: { text: `early user ${i}` },
      });
    }
    for (let i = 0; i < 5; i += 1) {
      store.appendEvent({
        conversationId,
        type: "user_message",
        timestamp: 2_000 + i,
        payload: {
          text: `hidden reminder ${i}`,
          metadata: { ui: { visibility: "hidden" } },
        },
      });
    }
    for (let i = 0; i < 2; i += 1) {
      store.appendEvent({
        conversationId,
        type: "user_message",
        timestamp: 3_000 + i * 10,
        payload: { text: `late user ${i}` },
      });
    }

    const { messages } = store.listMessages(conversationId, {
      maxVisibleMessages: 4,
    });
    // Window contains only the 4 most-recent visible messages. Hidden source
    // rows remain durable in SQLite but never inflate the eager IPC page.
    const visibleTexts = messages
      .filter((m) => {
        const visibility = (
          m.payload?.metadata as { ui?: { visibility?: string } } | undefined
        )?.ui?.visibility;
        return visibility !== "hidden";
      })
      .map((m) => m.payload?.text);
    expect(visibleTexts).toEqual([
      "early user 1",
      "early user 2",
      "late user 0",
      "late user 1",
    ]);
    expect(messages).toHaveLength(4);
  });

  it("listMessagesBefore pages strictly older messages using the oldest-message cursor", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    for (let i = 0; i < 6; i += 1) {
      const ts = 1_000 + i * 10;
      store.appendEvent({
        conversationId,
        type: "user_message",
        timestamp: ts,
        payload: { text: `user ${i}` },
      });
    }

    const { messages: latest } = store.listMessages(conversationId, {
      maxVisibleMessages: 3,
    });
    expect(latest.map((m) => m.payload?.text)).toEqual([
      "user 3",
      "user 4",
      "user 5",
    ]);

    const oldest = latest[0]!;
    const { messages: prior } = store.listMessagesBefore(conversationId, {
      beforeTimestampMs: oldest.timestamp,
      beforeId: oldest._id,
      maxVisibleMessages: 3,
    });
    expect(prior.map((m) => m.payload?.text)).toEqual([
      "user 0",
      "user 1",
      "user 2",
    ]);
  });

  it("listMessagesBefore resolves the source cursor onto sequence ordering", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();
    const timestamps = [6_000, 1_000, 5_000, 2_000, 4_000, 3_000];

    timestamps.forEach((timestamp, index) => {
      store.appendEvent({
        conversationId,
        type: "user_message",
        timestamp,
        payload: { text: `sequence user ${index}` },
      });
    });

    const { messages: latest } = store.listMessages(conversationId, {
      maxVisibleMessages: 3,
    });
    expect(latest.map((message) => message.payload?.text)).toEqual([
      "sequence user 3",
      "sequence user 4",
      "sequence user 5",
    ]);

    const oldest = latest[0]!;
    const { messages: prior } = store.listMessagesBefore(conversationId, {
      beforeTimestampMs: oldest.timestamp,
      beforeId: oldest._id,
      maxVisibleMessages: 3,
    });
    expect(prior.map((message) => message.payload?.text)).toEqual([
      "sequence user 0",
      "sequence user 1",
      "sequence user 2",
    ]);
  });

  it("bounds eager turn activity and pages complete detail on demand", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();
    store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "run a tool-heavy job" },
    });
    const eventIds: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      eventIds.push(
        store.appendEvent({
          conversationId,
          type: index % 2 === 0 ? "tool_request" : "tool_result",
          timestamp: 1_001 + index,
          payload: {
            toolName: "exec_command",
            index,
            output:
              `${index}:` +
              (index === 0 ? "😀".repeat(5_000) : "x".repeat(20_000)),
          },
        })._id,
      );
    }
    const assistant = store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_200,
      payload: { text: "done" },
    });

    const window = store.listMessages(conversationId, {
      maxVisibleMessages: 10,
    });
    const row = window.messages.find(
      (message) => message._id === assistant._id,
    )!;
    expect(row.toolEventSummary).toMatchObject({
      totalCount: 33,
      loadedCount: 32,
      truncated: true,
      totalCountIsLowerBound: true,
    });
    expect(row.toolEvents.map((event) => event._id)).toEqual([
      ...eventIds.slice(0, 16),
      ...eventIds.slice(-16),
    ]);
    expect(
      Math.max(
        ...row.toolEvents.map(
          (event) =>
            new TextEncoder().encode(JSON.stringify(event.payload)).byteLength,
        ),
      ),
    ).toBeLessThanOrEqual(4_096);

    const firstPage = store.listMessageToolEvents(conversationId, {
      messageId: assistant._id,
      messageTimestampMs: assistant.timestamp,
      limit: 25,
    });
    expect(firstPage.events).toHaveLength(25);
    expect(firstPage.hasMore).toBe(true);
    expect(
      new TextEncoder().encode(firstPage.events[0]?.payload?.output as string)
        .byteLength,
    ).toBeGreaterThan(20_000);
    const secondPage = store.listMessageToolEvents(conversationId, {
      messageId: assistant._id,
      messageTimestampMs: assistant.timestamp,
      limit: 25,
      afterId: firstPage.nextCursor!.id,
      afterTimestampMs: firstPage.nextCursor!.timestamp,
      afterSequence: firstPage.nextCursor!.sequence,
    });
    expect(secondPage.events.map((event) => event._id)).toEqual(
      eventIds.slice(25, 50),
    );
  });

  it("offers lazy full detail when a single eager tool payload is projected", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();
    store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "show one large result" },
    });
    store.appendEvent({
      conversationId,
      eventId: "large-single-tool-result",
      type: "tool_result",
      timestamp: 1_001,
      payload: { output: "x".repeat(10_000) },
    });
    const assistant = store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_002,
      payload: { text: "done" },
    });

    const row = store
      .listMessages(conversationId, { maxVisibleMessages: 10 })
      .messages.find((message) => message._id === assistant._id)!;
    expect(row.toolEventSummary).toMatchObject({
      totalCount: 1,
      loadedCount: 1,
      truncated: true,
    });
    expect(row.toolEventSummary).not.toHaveProperty("totalCountIsLowerBound");
    expect(row.toolEvents[0]?.payload?.__stellaEagerProjection).toEqual({
      truncated: true,
      fullDetailAvailable: true,
    });

    const detail = store.listMessageToolEvents(conversationId, {
      messageId: assistant._id,
      messageTimestampMs: assistant.timestamp,
      limit: 10,
    });
    expect(detail.hasMore).toBe(false);
    expect(detail.events[0]?.payload?.output).toBe("x".repeat(10_000));
  });

  it("bounds tool-event update pushes while preserving authored text", () => {
    const toolEvent = projectLocalChatUpdateEvent({
      _id: "large-tool",
      timestamp: 1,
      type: "tool_result",
      payload: { toolName: "exec_command", output: "😀".repeat(10_000) },
    });
    expect(
      new TextEncoder().encode(JSON.stringify(toolEvent)).byteLength,
    ).toBeLessThanOrEqual(4_300);
    expect(toolEvent.payload?.toolName).toBe("exec_command");

    const text = "a".repeat(10_000);
    const assistantEvent = {
      _id: "large-assistant",
      timestamp: 2,
      type: "assistant_message",
      payload: { text },
    };
    expect(projectLocalChatUpdateEvent(assistantEvent)).toBe(assistantEvent);
    expect(projectLocalChatUpdateEvent(assistantEvent).payload.text).toBe(text);
  });

  it("keeps structured arrays schema-valid when projecting tool payloads", () => {
    const fileChanges = Array.from({ length: 24 }, (_, index) => ({
      path: `/tmp/${"nested/".repeat(100)}file-${index}.txt`,
      kind: "created",
    }));
    const event = projectLocalChatUpdateEvent({
      _id: "large-file-event",
      timestamp: 1,
      type: "tool_result",
      payload: { fileChanges },
    });

    expect(event.payload.fileChanges.length).toBeGreaterThan(0);
    expect(event.payload.fileChanges.length).toBeLessThan(fileChanges.length);
    expect(event.payload.fileChanges).toEqual(
      fileChanges.slice(0, event.payload.fileChanges.length),
    );
    expect(
      event.payload.fileChanges.every(
        (entry: unknown) =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { path?: unknown }).path === "string",
      ),
    ).toBe(true);
    expect(event.payload.__stellaEagerProjection).toEqual({
      truncated: true,
      fullDetailAvailable: true,
    });
  });

  it("preserves artifact identity when the general eager projection cannot fit", () => {
    const fileChange = {
      path: `/tmp/${"deep/".repeat(150)}result.html`,
      kind: { type: "add" },
    };
    const event = projectLocalChatUpdateEvent({
      _id: "large-artifact-event",
      timestamp: 1,
      type: "tool_result",
      payload: {
        fileChanges: Array.from({ length: 10 }, () => fileChange),
        producedFiles: Array.from({ length: 10 }, () => fileChange),
        output: "x".repeat(100_000),
      },
    });

    expect(event.payload.fileChanges).toEqual([fileChange]);
    expect(event.payload.producedFiles).toEqual([fileChange]);
    expect(event.payload.__stellaEagerProjection).toEqual({
      truncated: true,
      fullDetailAvailable: true,
    });
    expect(
      new TextEncoder().encode(JSON.stringify(event.payload)).byteLength,
    ).toBeLessThanOrEqual(4_096);
  });

  it("keeps bounded and lazy tool detail owned by the correct assistant", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();
    store.appendEvent({
      conversationId,
      eventId: "user-anchor",
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "research this" },
    });
    const beforeFirst = store.appendEvent({
      conversationId,
      eventId: "tool-before-first",
      type: "tool_result",
      timestamp: 1_001,
      payload: { output: "before first" },
    });
    const first = store.appendEvent({
      conversationId,
      eventId: "assistant-first",
      type: "assistant_message",
      timestamp: 1_002,
      payload: { text: "I found one lead" },
    });
    const afterFirst = store.appendEvent({
      conversationId,
      eventId: "tool-after-first",
      type: "tool_result",
      timestamp: 1_003,
      payload: { output: "after first" },
    });
    store.appendEvent({
      conversationId,
      eventId: "assistant-hidden",
      type: "assistant_message",
      timestamp: 1_003.1,
      payload: {
        text: "internal reminder",
        metadata: { ui: { visibility: "hidden" } },
      },
    });
    const afterHidden = store.appendEvent({
      conversationId,
      eventId: "tool-after-hidden",
      type: "tool_result",
      timestamp: 1_003.2,
      payload: { output: "after hidden" },
    });
    const second = store.appendEvent({
      conversationId,
      eventId: "assistant-second",
      type: "assistant_message",
      timestamp: 1_004,
      payload: { text: "Here is the answer" },
    });
    const afterSecond = store.appendEvent({
      conversationId,
      eventId: "tool-after-second",
      type: "tool_result",
      timestamp: 1_005,
      payload: { output: "after second" },
    });

    const window = store.listMessages(conversationId, {
      maxVisibleMessages: 10,
    });
    expect(
      window.messages.find((message) => message._id === first._id)?.toolEvents,
    ).toEqual([beforeFirst, afterFirst, afterHidden]);
    expect(
      window.messages.find((message) => message._id === second._id)?.toolEvents,
    ).toEqual([afterSecond]);

    expect(
      store.listMessageToolEvents(conversationId, {
        messageId: first._id,
        messageTimestampMs: first.timestamp,
      }).events,
    ).toEqual([beforeFirst, afterFirst, afterHidden]);
    expect(
      store.listMessageToolEvents(conversationId, {
        messageId: second._id,
        messageTimestampMs: second.timestamp,
      }).events,
    ).toEqual([afterSecond]);
  });

  it("advances event cursors by sequence when timestamps and ids disagree", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();
    store.appendEvent({
      conversationId,
      eventId: "z-user",
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "go" },
    });
    store.appendEvent({
      conversationId,
      eventId: "z-assistant",
      type: "assistant_message",
      timestamp: 1_000,
      payload: { text: "working" },
    });
    const initial = store.listMessages(conversationId, {
      maxVisibleMessages: 10,
    });
    expect(initial.nextCursor?.sequence).toBeTypeOf("number");

    const later = store.appendEvent({
      conversationId,
      eventId: "a-later-tool",
      type: "tool_result",
      timestamp: 1_000,
      payload: { output: "done" },
    });
    const tail = store.listMessagesAfter(conversationId, {
      afterTimestampMs: initial.nextCursor!.timestamp,
      afterId: initial.nextCursor!.id,
      afterSequence: initial.nextCursor!.sequence,
      maxVisibleMessages: 10,
      includeSourceEvents: false,
    });
    expect(tail.nextCursor?.sequence).toBe(later.sequence);
    expect(tail.messages[0]?.toolEvents.at(-1)?._id).toBe(later._id);
  });

  it("listMessagesAfter returns only messages after the mobile cursor", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    const first = store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "already synced" },
    });
    store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_010,
      payload: { text: "new user" },
    });
    store.appendEvent({
      conversationId,
      type: "tool_result",
      timestamp: 1_011,
      payload: {
        toolName: "exec_command",
        producedFiles: [{ path: "/tmp/report.pdf", kind: { type: "add" } }],
      },
    });
    store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_012,
      payload: { text: "new assistant" },
    });

    const { messages, sourceEvents } = store.listMessagesAfter(conversationId, {
      afterTimestampMs: first.timestamp,
      afterId: first._id,
      maxVisibleMessages: 10,
    });

    expect(messages.map((m) => m.payload?.text)).toEqual([
      "new user",
      "new assistant",
    ]);
    expect(messages[1]?.toolEvents.map((event) => event.type)).toEqual([
      "tool_result",
    ]);
    expect(sourceEvents.map((event) => event.type)).toEqual([
      "user_message",
      "tool_result",
      "assistant_message",
    ]);
  });

  it("keeps middle-of-turn mobile artifacts before advancing the source cursor", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();
    const cursor = store.appendEvent({
      conversationId,
      eventId: "artifact-cursor",
      type: "assistant_message",
      timestamp: 1_000,
      payload: { text: "ready" },
    });
    store.appendEvent({
      conversationId,
      eventId: "artifact-turn",
      type: "user_message",
      timestamp: 1_001,
      payload: { text: "make a report" },
    });
    for (let index = 0; index < 41; index += 1) {
      store.appendEvent({
        conversationId,
        eventId: `artifact-event-${index}`,
        type: index === 20 ? "tool_result" : "agent-progress",
        timestamp: 1_002 + index,
        payload:
          index === 20
            ? {
                toolName: "exec_command",
                producedFiles: [
                  { path: "/tmp/middle.pdf", kind: { type: "add" } },
                ],
              }
            : { agentId: "noise", statusText: `step ${index}` },
      });
    }
    const last = store.appendEvent({
      conversationId,
      eventId: "artifact-finished",
      type: "assistant_message",
      timestamp: 1_100,
      payload: { text: "done" },
    });

    const delta = store.listMessagesAfter(conversationId, {
      afterTimestampMs: cursor.timestamp,
      afterId: cursor._id,
      afterSequence: cursor.sequence,
      maxVisibleMessages: 10,
    });

    expect(delta.nextCursor).toMatchObject({
      id: last._id,
      sequence: last.sequence,
    });
    expect(
      delta.messages
        .flatMap((message) => message.toolEvents)
        .find((event) => event._id === "artifact-event-20")?.payload
        ?.producedFiles,
    ).toEqual([{ path: "/tmp/middle.pdf", kind: { type: "add" } }]);
  });

  it("listMessagesAfter returns an existing assistant when its turn gets a new artifact", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "make a report" },
    });
    const assistant = store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_010,
      payload: { text: "Working on it." },
    });
    const artifact = store.appendEvent({
      conversationId,
      type: "tool_result",
      timestamp: 1_020,
      payload: {
        toolName: "html",
        filePath: "/Users/me/.stella/outputs/html/report.html",
      },
    });

    const { messages, sourceEvents } = store.listMessagesAfter(conversationId, {
      afterTimestampMs: assistant.timestamp,
      afterId: assistant._id,
      maxVisibleMessages: 10,
    });

    expect(messages.map((m) => m._id)).toEqual([assistant._id]);
    expect(messages[0]?.toolEvents.map((event) => event._id)).toEqual([
      artifact._id,
    ]);
    expect(sourceEvents.map((event) => event._id)).toEqual([artifact._id]);
  });

  it("listMessagesAfter returns existing rows when agent lifecycle state changes", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "run background work" },
    });
    const assistant = store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_010,
      payload: { text: "Working on it." },
    });
    const started = store.appendEvent({
      conversationId,
      type: "agent-started",
      timestamp: 1_020,
      payload: { agentId: "task-1", description: "Check docs" },
    });
    const progress = store.appendEvent({
      conversationId,
      type: "agent-progress",
      timestamp: 1_030,
      payload: { agentId: "task-1", statusText: "Reading docs" },
    });
    const failed = store.appendEvent({
      conversationId,
      type: "agent-failed",
      timestamp: 1_040,
      payload: { agentId: "task-1", error: "Timed out" },
    });

    const { messages, sourceEvents } = store.listMessagesAfter(conversationId, {
      afterTimestampMs: assistant.timestamp,
      afterId: assistant._id,
      maxVisibleMessages: 10,
    });

    expect(messages.map((message) => message._id)).toEqual([assistant._id]);
    expect(messages[0]?.toolEvents.map((event) => event._id)).toEqual([
      started._id,
      progress._id,
      failed._id,
    ]);
    expect(sourceEvents.map((event) => event._id)).toEqual([
      started._id,
      progress._id,
      failed._id,
    ]);
  });

  it("paginates mobile source events without skipping past the row budget", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();
    store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "large turn" },
    });
    const assistant = store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_001,
      payload: { text: "working" },
    });
    for (let index = 0; index < 4_005; index += 1) {
      store.appendEvent({
        conversationId,
        eventId: `mobile-tail-${index.toString().padStart(4, "0")}`,
        type: "tool_result",
        timestamp: 1_002 + index,
        payload: { output: `result ${index}` },
      });
    }

    const firstPage = store.listMessagesAfter(conversationId, {
      afterTimestampMs: assistant.timestamp,
      afterId: assistant._id,
      afterSequence: assistant.sequence,
      maxVisibleMessages: 10,
    });
    expect(firstPage.sourceEvents).toHaveLength(4_000);
    expect(firstPage.nextCursor?.id).toBe("mobile-tail-3999");
    expect(
      store.hasMobileSyncEventsAfter(
        conversationId,
        firstPage.nextCursor!.timestamp,
        firstPage.nextCursor!.id,
        firstPage.nextCursor!.sequence,
      ),
    ).toBe(true);

    const secondPage = store.listMessagesAfter(conversationId, {
      afterTimestampMs: firstPage.nextCursor!.timestamp,
      afterId: firstPage.nextCursor!.id,
      afterSequence: firstPage.nextCursor!.sequence,
      maxVisibleMessages: 10,
    });
    expect(secondPage.sourceEvents.map((event) => event._id)).toEqual([
      "mobile-tail-4000",
      "mobile-tail-4001",
      "mobile-tail-4002",
      "mobile-tail-4003",
      "mobile-tail-4004",
    ]);
    expect(secondPage.nextCursor?.id).toBe("mobile-tail-4004");
  });

  it("bounds listMessagesAfter storage work to the requested cursor page", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();
    const anchors = [];
    for (let index = 0; index < 500; index += 1) {
      anchors.push(
        store.appendEvent({
          conversationId,
          type: index % 2 === 0 ? "user_message" : "assistant_message",
          timestamp: 10_000 + index * 2,
          payload: { text: `message ${index}` },
        }),
      );
    }

    const fetchedRowCounts: number[] = [];
    const pageEnd = store.findVisibleMessagePageEndAfter(conversationId, 10, {
      timestamp: anchors[0]!.timestamp,
      id: anchors[0]!._id,
    });
    expect(pageEnd?.id).toBe(anchors[10]!._id);
    expect(
      store.findVisibleMessageCursorAfter(conversationId, pageEnd!)?.id,
    ).toBe(anchors[11]!._id);
    const originalFetch = store.fetchTimelineRows.bind(store);
    vi.spyOn(store, "fetchTimelineRows").mockImplementation((...args) => {
      const rows = originalFetch(...args);
      fetchedRowCounts.push(rows.length);
      return rows;
    });

    const { messages } = store.listMessagesAfter(conversationId, {
      afterTimestampMs: anchors[0]!.timestamp,
      afterId: anchors[0]!._id,
      maxVisibleMessages: 10,
    });

    expect(messages.map((message) => message.payload?.text)).toEqual(
      Array.from({ length: 10 }, (_, index) => `message ${index + 1}`),
    );
    expect(fetchedRowCounts).toEqual([11, 10]);
  });

  it("hard-caps oversized visible-window requests", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    for (let i = 0; i < 4_050; i += 1) {
      store.appendEvent({
        conversationId,
        type: "user_message",
        timestamp: 1_000 + i,
        payload: { text: `user ${i}` },
      });
    }

    const { messages, visibleMessageCount } = store.listMessages(
      conversationId,
      { maxVisibleMessages: 4_001 },
    );

    expect(visibleMessageCount).toBe(500);
    expect(messages).toHaveLength(500);
    expect(messages[0]?.payload?.text).toBe("user 3550");
    expect(messages.at(-1)?.payload?.text).toBe("user 4049");
  });

  it("finds visible history beyond more than 4,000 hidden successors", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();
    const visible = store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "still visible" },
    });
    for (let index = 0; index < 4_001; index += 1) {
      store.appendEvent({
        conversationId,
        type: "user_message",
        timestamp: 2_000 + index,
        payload: {
          text: `hidden ${index}`,
          metadata: { ui: { visibility: "hidden" } },
        },
      });
    }

    const page = store.listMessages(conversationId, { maxVisibleMessages: 80 });

    expect(page.visibleMessageCount).toBe(1);
    expect(page.messages.map((message) => message._id)).toEqual([visible._id]);
  });

  it("backfills and maintains the indexed visibility projection", () => {
    const { db, store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();
    const visible = store.appendEvent({
      conversationId,
      eventId: "visibility-visible",
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "visible" },
    });
    const hidden = store.appendEvent({
      conversationId,
      eventId: "visibility-hidden",
      type: "user_message",
      timestamp: 1_001,
      payload: {
        text: "hidden",
        metadata: { ui: { visibility: "hidden" } },
      },
    });
    db.exec(`
      DROP TRIGGER trg_message_ui_visible_insert;
      DROP TRIGGER trg_message_ui_visible_type_update;
      DROP TRIGGER trg_part_ui_visible_insert;
      DROP TRIGGER trg_part_ui_visible_update;
      DROP TRIGGER trg_part_ui_visible_delete;
      UPDATE message SET ui_visible = NULL
      WHERE id IN ('visibility-visible', 'visibility-hidden');
    `);

    initializeDesktopDatabase(db);

    const rows = db
      .prepare(
        `SELECT id, ui_visible AS visible FROM message
         WHERE id IN (?, ?) ORDER BY id`,
      )
      .all(hidden._id, visible._id) as Array<{ id: string; visible: number }>;
    expect(rows).toEqual([
      { id: hidden._id, visible: 0 },
      { id: visible._id, visible: 1 },
    ]);
    const queryPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM message
         WHERE session_id = ?
           AND type IN ('user_message', 'assistant_message')
           AND ui_visible = 1
         ORDER BY ordering_sequence DESC
         LIMIT 80`,
      )
      .all(conversationId) as Array<{ detail?: string }>;
    expect(queryPlan.map((step) => step.detail).join("\n")).toContain(
      "idx_message_session_visible_sequence",
    );

    db.prepare(
      `INSERT INTO part (
        id, session_id, message_id, ord, type, data_json, created_at
      ) VALUES (?, ?, ?, 1, 'payload', ?, ?)`,
    ).run(
      `${hidden._id}:secondary`,
      conversationId,
      hidden._id,
      JSON.stringify({ metadata: { ui: { visibility: "hidden" } } }),
      1_002,
    );
    db.prepare("UPDATE part SET data_json = ? WHERE id = ?").run(
      JSON.stringify({ text: "secondary edit" }),
      `${hidden._id}:secondary`,
    );
    expect(
      db
        .prepare("SELECT ui_visible AS visible FROM message WHERE id = ?")
        .get(hidden._id),
    ).toEqual({ visible: 0 });
    db.prepare("UPDATE message SET type = 'tool_result' WHERE id = ?").run(
      hidden._id,
    );
    db.prepare("UPDATE message SET type = 'user_message' WHERE id = ?").run(
      hidden._id,
    );
    expect(
      db
        .prepare("SELECT ui_visible AS visible FROM message WHERE id = ?")
        .get(hidden._id),
    ).toEqual({ visible: 0 });

    store.appendEvent({
      conversationId,
      eventId: hidden._id,
      type: "user_message",
      timestamp: 1_001,
      payload: { text: "now visible" },
    });
    expect(
      store
        .listMessages(conversationId, { maxVisibleMessages: 10 })
        .messages.map((message) => message._id),
    ).toEqual([visible._id, hidden._id]);
  });

  it("listActivity returns only lifecycle events", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "Plan a trip" },
    });
    store.appendEvent({
      conversationId,
      type: "agent-started",
      timestamp: 1_010,
      payload: {
        agentId: "general-1",
        description: "Researching destinations",
        agentType: "general",
      },
    });
    store.appendEvent({
      conversationId,
      type: "agent-progress",
      timestamp: 1_020,
      payload: { agentId: "general-1", statusText: "Reading guides" },
    });
    store.appendEvent({
      conversationId,
      type: "tool_request",
      timestamp: 1_021,
      requestId: "tool-1",
      payload: { toolName: "web", args: { query: "weather" } },
    });
    store.appendEvent({
      conversationId,
      type: "assistant_message",
      timestamp: 1_030,
      payload: { text: "Here you go." },
    });
    store.appendEvent({
      conversationId,
      type: "agent-completed",
      timestamp: 1_040,
      payload: { agentId: "general-1", result: "Done" },
    });

    const { activities } = store.listActivity(conversationId);

    expect(activities.map((event) => event.type)).toEqual([
      "agent-started",
      "agent-progress",
      "agent-completed",
    ]);
  });

  it("listActivity pages older activity via beforeTimestampMs/beforeId", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    for (let i = 0; i < 6; i += 1) {
      const ts = 1_000 + i * 10;
      store.appendEvent({
        conversationId,
        type: "agent-started",
        timestamp: ts,
        payload: {
          agentId: `agent-${i}`,
          description: `task ${i}`,
          agentType: "general",
        },
      });
    }

    const { activities: latest } = store.listActivity(conversationId, {
      limit: 3,
    });
    expect(
      latest.map((event) => (event.payload as { agentId: string })?.agentId),
    ).toEqual(["agent-3", "agent-4", "agent-5"]);

    const oldest = latest[0]!;
    const { activities: older } = store.listActivity(conversationId, {
      limit: 3,
      beforeTimestampMs: oldest.timestamp,
      beforeId: oldest._id,
    });
    expect(
      older.map((event) => (event.payload as { agentId: string })?.agentId),
    ).toEqual(["agent-0", "agent-1", "agent-2"]);
  });

  it("listFiles returns only events whose payload carries fileChanges or producedFiles", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    store.appendEvent({
      conversationId,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "Edit something" },
    });
    // tool_result without any file changes — should be excluded.
    store.appendEvent({
      conversationId,
      type: "tool_result",
      timestamp: 1_010,
      requestId: "tool-1",
      payload: { toolName: "web", result: "ok" },
    });
    // tool_result with fileChanges — should be included.
    store.appendEvent({
      conversationId,
      type: "tool_result",
      timestamp: 1_020,
      requestId: "tool-2",
      payload: {
        toolName: "apply_patch",
        fileChanges: [{ kind: { type: "create" }, path: "/repo/src/new.ts" }],
      },
    });
    // tool_result with empty fileChanges array — should be excluded.
    store.appendEvent({
      conversationId,
      type: "tool_result",
      timestamp: 1_025,
      requestId: "tool-3",
      payload: {
        toolName: "apply_patch",
        fileChanges: [],
        producedFiles: [],
      },
    });
    // agent-completed with producedFiles — should be included.
    store.appendEvent({
      conversationId,
      type: "agent-completed",
      timestamp: 1_030,
      payload: {
        agentId: "general-1",
        producedFiles: [
          { path: "/out/report.pdf", mimeType: "application/pdf" },
        ],
      },
    });
    // agent-completed without files — should be excluded.
    store.appendEvent({
      conversationId,
      type: "agent-completed",
      timestamp: 1_040,
      payload: { agentId: "general-2", result: "Done" },
    });

    const { files } = store.listFiles(conversationId);
    expect(files.map((event) => event._id)).toEqual(
      files.map((event) => event._id),
    );
    expect(files.map((event) => event.type)).toEqual([
      "tool_result",
      "agent-completed",
    ]);
    expect(files[0]?.timestamp).toBe(1_020);
    expect(files[1]?.timestamp).toBe(1_030);
  });

  it("listFiles pages older file events via beforeTimestampMs/beforeId", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    for (let i = 0; i < 6; i += 1) {
      const ts = 1_000 + i * 10;
      store.appendEvent({
        conversationId,
        type: "tool_result",
        timestamp: ts,
        requestId: `tool-${i}`,
        payload: {
          toolName: "apply_patch",
          fileChanges: [
            { kind: { type: "create" }, path: `/repo/file-${i}.ts` },
          ],
        },
      });
    }

    const { files: latest } = store.listFiles(conversationId, { limit: 3 });
    expect(latest.map((event) => event.timestamp)).toEqual([
      1_030, 1_040, 1_050,
    ]);

    const oldest = latest[0]!;
    const { files: older } = store.listFiles(conversationId, {
      limit: 3,
      beforeTimestampMs: oldest.timestamp,
      beforeId: oldest._id,
    });
    expect(older.map((event) => event.timestamp)).toEqual([
      1_000, 1_010, 1_020,
    ]);
  });

  it("upserts local chat events by explicit event id", () => {
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();

    store.appendEvent({
      conversationId,
      eventId: "assistant-for-user-1",
      type: "assistant_message",
      timestamp: 1_000,
      requestId: "user-1",
      payload: { text: "First draft", userMessageId: "user-1" },
    });
    store.appendEvent({
      conversationId,
      eventId: "assistant-for-user-1",
      type: "assistant_message",
      timestamp: 1_001,
      requestId: "user-1",
      payload: { text: "Final answer", userMessageId: "user-1" },
    });

    const events = store.listEvents(conversationId, 10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      _id: "assistant-for-user-1",
      type: "assistant_message",
      requestId: "user-1",
      payload: { text: "Final answer", userMessageId: "user-1" },
    });
  });

  it("keeps each assistant message in a single user turn as its own row", () => {
    // The worker writes one `assistant-msg-<runId>-<seq>` row per
    // assistant message in a run (preamble, post-tool answer, …) so
    // they render linearly in chronological order rather than
    // collapsing into a single overwriting row. Sanity-check that the
    // store happily round-trips two distinct rows that share the same
    // requestId/userMessageId.
    const { store } = createTestContext();
    const conversationId = store.getOrCreateDefaultConversationId();
    const userMessageId = "user-web-turn";

    store.appendEvent({
      conversationId,
      eventId: `assistant-msg-run-1-2`,
      type: "assistant_message",
      timestamp: 1_000,
      requestId: userMessageId,
      payload: {
        text: "Let me look that up.",
        userMessageId,
      },
    });
    store.appendEvent({
      conversationId,
      eventId: `assistant-msg-run-1-5`,
      type: "assistant_message",
      timestamp: 1_001,
      requestId: userMessageId,
      payload: {
        text: "Here is what I found from the web.",
        userMessageId,
      },
    });

    const events = store.listEvents(conversationId, 10);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.payload?.text)).toEqual([
      "Let me look that up.",
      "Here is what I found from the web.",
    ]);
  });

  it("loads runtime thread history from shared message parts", () => {
    const { db, store } = createTestContext();
    const conversationId = "conv-thread";
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "general",
    });

    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 2_000,
      role: "user",
      content: "Summarize this file",
      payload: {
        role: "user",
        content: "Summarize this file",
        timestamp: 2_000,
      },
    });

    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 2_001,
      role: "assistant",
      content: "Summary complete",
      payload: {
        role: "assistant",
        content: [{ type: "text", text: "Summary complete" }],
        api: "anthropic",
        provider: "anthropic",
        model: "claude-sonnet",
        usage: {
          input: 10,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 30,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: 2_001,
      },
    });

    const loaded = store.loadThreadMessages(threadId);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({
      role: "user",
      content: "Summarize this file",
    });
    expect(loaded[1]).toMatchObject({
      role: "assistant",
      content: "Summary complete",
    });
    expect(loaded[1]?.payload).toMatchObject({
      role: "assistant",
      model: "claude-sonnet",
    });

    const threadRows = db
      .prepare(
        `
      SELECT COUNT(*) AS count
      FROM runtime_thread_entries
      WHERE thread_key = ?
        AND entry_type = 'message'
    `,
      )
      .get(threadId) as { count: number };
    expect(threadRows.count).toBe(2);
  });

  it("keeps equal-timestamp thread entries linear and complete across a full reload", () => {
    const context = createTestContext();
    const { rootPath, db, store } = context;
    const frozenAt = 7_000;
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-frozen-agent",
      agentType: "general",
    });
    const messageCount = 80;
    for (let index = 0; index < messageCount; index += 1) {
      store.appendThreadMessage({
        threadKey: threadId,
        timestamp: frozenAt,
        role: "user",
        content: `Frozen message ${index}`,
        payload: {
          role: "user",
          content: `Frozen message ${index}`,
          timestamp: frozenAt,
        },
      });
    }

    const entryRows = db
      .prepare(
        `SELECT
           entry_id AS entryId,
           parent_entry_id AS parentEntryId,
           insertion_sequence AS insertionSequence
         FROM runtime_thread_entries
         WHERE thread_key = ?
         ORDER BY insertion_sequence ASC`,
      )
      .all(threadId) as Array<{
      entryId: string;
      parentEntryId: string | null;
      insertionSequence: number;
    }>;
    expect(entryRows).toHaveLength(messageCount);
    expect(new Set(entryRows.map((row) => row.insertionSequence)).size).toBe(
      messageCount,
    );
    for (let index = 1; index < entryRows.length; index += 1) {
      expect(entryRows[index]?.parentEntryId).toBe(
        entryRows[index - 1]?.entryId,
      );
    }

    db.close();
    activeContexts.delete(context);
    const reopenedDb = new DatabaseSync(getDesktopDatabasePath(rootPath), {
      timeout: 5000,
    }) as unknown as SqliteDatabase;
    initializeDesktopDatabase(reopenedDb);
    const reopened = {
      rootPath,
      db: reopenedDb,
      store: new SessionStore(reopenedDb),
    };
    activeContexts.add(reopened);

    expect(
      reopened.store.loadThreadMessages(threadId).map((entry) => entry.content),
    ).toEqual(
      Array.from(
        { length: messageCount },
        (_, index) => `Frozen message ${index}`,
      ),
    );
    expect(reopened.store.loadThreadMessages(threadId, 25)[0]?.content).toBe(
      "Frozen message 55",
    );
  });

  it("orders legacy branches by durable insertion sequence", () => {
    const { db, store } = createTestContext();
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-imported-thread",
      agentType: "general",
    });
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 8_000,
      role: "user",
      content: "Imported base",
      payload: { role: "user", content: "Imported base", timestamp: 8_000 },
    });
    const base = db
      .prepare(
        `SELECT entry_id AS entryId, session_id AS sessionId
         FROM runtime_thread_entries WHERE thread_key = ? LIMIT 1`,
      )
      .get(threadId) as { entryId: string; sessionId: string };
    const insertLegacy = db.prepare(`
      INSERT INTO runtime_thread_entries (
        entry_id, thread_key, session_id, parent_entry_id, entry_type,
        timestamp_iso, created_at, data_json
      ) VALUES (?, ?, ?, ?, 'message', ?, ?, ?)
    `);
    insertLegacy.run(
      "legacy-random-z",
      threadId,
      base.sessionId,
      base.entryId,
      new Date(8_000).toISOString(),
      8_000,
      JSON.stringify({
        message: { role: "user", content: "Imported second", timestamp: 8_000 },
      }),
    );
    insertLegacy.run(
      "legacy-random-a",
      threadId,
      base.sessionId,
      base.entryId,
      new Date(8_000).toISOString(),
      8_000,
      JSON.stringify({
        message: { role: "user", content: "Imported third", timestamp: 8_000 },
      }),
    );

    expect(
      store.loadThreadMessages(threadId).map((entry) => entry.content),
    ).toEqual(["Imported base", "Imported second", "Imported third"]);
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 8_000,
      role: "user",
      content: "Appended after import",
      payload: {
        role: "user",
        content: "Appended after import",
        timestamp: 8_000,
      },
    });
    expect(
      store.loadThreadMessages(threadId).map((entry) => entry.content),
    ).toEqual([
      "Imported base",
      "Imported second",
      "Imported third",
      "Appended after import",
    ]);
  });

  it("repairs rows inserted during the insertion-sequence migration window", () => {
    const { db, store } = createTestContext();
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-partial-sequence-migration",
      agentType: "general",
    });
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 8_000,
      role: "user",
      content: "Before migration window",
      payload: {
        role: "user",
        content: "Before migration window",
        timestamp: 8_000,
      },
    });
    const base = db
      .prepare(
        `SELECT entry_id AS entryId, session_id AS sessionId
         FROM runtime_thread_entries WHERE thread_key = ? LIMIT 1`,
      )
      .get(threadId) as { entryId: string; sessionId: string };
    const insertMessage = db.prepare(`
      INSERT INTO runtime_thread_entries (
        entry_id, thread_key, session_id, parent_entry_id, entry_type,
        timestamp_iso, created_at, data_json
      ) VALUES (?, ?, ?, ?, 'message', ?, ?, ?)
    `);

    db.exec("DROP TRIGGER trg_runtime_thread_entries_sequence;");
    insertMessage.run(
      "partial-migration-null",
      threadId,
      base.sessionId,
      base.entryId,
      new Date(8_001).toISOString(),
      8_001,
      JSON.stringify({
        message: {
          role: "user",
          content: "Inside migration window",
          timestamp: 8_001,
        },
      }),
    );
    db.exec(`
      CREATE TRIGGER trg_runtime_thread_entries_sequence
      AFTER INSERT ON runtime_thread_entries
      WHEN NEW.insertion_sequence IS NULL
      BEGIN
        UPDATE runtime_thread_entries
        SET insertion_sequence = (
          SELECT COALESCE(MAX(insertion_sequence), 0) + 1
          FROM runtime_thread_entries
        )
        WHERE rowid = NEW.rowid;
      END;
    `);
    insertMessage.run(
      "partial-migration-assigned",
      threadId,
      base.sessionId,
      "partial-migration-null",
      new Date(8_002).toISOString(),
      8_002,
      JSON.stringify({
        message: {
          role: "user",
          content: "After migration window",
          timestamp: 8_002,
        },
      }),
    );

    expect(() => initializeDesktopDatabase(db)).not.toThrow();
    expect(
      db
        .prepare(
          `SELECT insertion_sequence AS insertionSequence
           FROM runtime_thread_entries
           WHERE thread_key = ?
           ORDER BY rowid`,
        )
        .all(threadId),
    ).toEqual([
      { insertionSequence: 1 },
      { insertionSequence: 2 },
      { insertionSequence: 3 },
    ]);
    expect(
      store.loadThreadMessages(threadId).map((entry) => entry.content),
    ).toEqual([
      "Before migration window",
      "Inside migration window",
      "After migration window",
    ]);
  });

  it("recovers malformed imported parent graphs without losing entries", () => {
    const { db, store } = createTestContext();
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-malformed-graph",
      agentType: "general",
    });
    const messages = appendUserThreadMessages(store, threadId, 4);
    const previousId = messages[2]!.entryId!;
    const newestId = messages[3]!.entryId!;
    const updateParent = db.prepare(
      `UPDATE runtime_thread_entries SET parent_entry_id = ? WHERE entry_id = ?`,
    );
    updateParent.run(newestId, previousId);
    updateParent.run(previousId, newestId);

    expect(
      store.loadThreadMessages(threadId).map((entry) => entry.content),
    ).toEqual([
      "Graph message 0",
      "Graph message 1",
      "Graph message 2",
      "Graph message 3",
    ]);

    updateParent.run("missing-imported-parent", messages[1]!.entryId!);
    updateParent.run(messages[1]!.entryId!, previousId);
    expect(
      store.loadThreadMessages(threadId).map((entry) => entry.content),
    ).toEqual([
      "Graph message 0",
      "Graph message 1",
      "Graph message 2",
      "Graph message 3",
    ]);
  });

  it("preserves assistant thinking blocks in persisted thread payloads", () => {
    const { store } = createTestContext();
    const conversationId = "conv-thinking";
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "general",
    });

    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 3_000,
      role: "assistant",
      content: "Final answer",
      payload: {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Check the relevant files first.",
            thinkingSignature: '{"type":"reasoning","id":"rs_123"}',
          },
          { type: "text", text: "Final answer" },
        ],
        api: "openai-completions",
        provider: "stella",
        model: "openai/gpt-5.4",
        usage: {
          input: 10,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 30,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: 3_000,
      },
    });

    const loaded = store.loadThreadMessages(threadId);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.payload).toEqual({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "Check the relevant files first.",
          thinkingSignature: '{"type":"reasoning","id":"rs_123"}',
        },
        { type: "text", text: "Final answer" },
      ],
      api: "openai-completions",
      provider: "stella",
      model: "openai/gpt-5.4",
      usage: {
        input: 10,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 30,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 3_000,
    });
  });

  it("compacts thread history using append-only session entries", () => {
    const { db } = createTestContext();
    const onThreadTranscriptUpdate = vi.fn();
    const store = new SessionStore(db, { onThreadTranscriptUpdate });
    const conversationId = "conv-compact";
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "general",
    });

    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 4_000,
      role: "user",
      content: "First request",
      payload: {
        role: "user",
        content: "First request",
        timestamp: 4_000,
      },
    });
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 4_001,
      role: "assistant",
      content: "First answer",
      payload: {
        role: "assistant",
        content: [{ type: "text", text: "First answer" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.4",
        usage: {
          input: 10,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 30,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: 4_001,
      },
    });
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 4_002,
      role: "user",
      content: "Latest request",
      payload: {
        role: "user",
        content: "Latest request",
        timestamp: 4_002,
      },
    });

    const beforeCompaction = store.loadThreadMessages(threadId);
    expect(beforeCompaction).toHaveLength(3);
    onThreadTranscriptUpdate.mockClear();

    store.compactThread({
      threadKey: threadId,
      summary: "Condensed earlier work",
      fromEntryId: beforeCompaction[0]!.entryId!,
      toEntryId: beforeCompaction[1]!.entryId!,
      tokensBefore: 1234,
      timestamp: 4_100,
    });

    const afterCompaction = store.loadThreadMessages(threadId);
    expect(afterCompaction).toHaveLength(2);
    expect(afterCompaction[0]).toMatchObject({
      role: "assistant",
      content: expect.stringContaining("[[THREAD_CHECKPOINT]]"),
    });
    expect(afterCompaction[1]).toMatchObject({
      role: "user",
      content: "Latest request",
    });
    const rawAfterCompaction = store.loadRawThreadMessages(threadId);
    expect(rawAfterCompaction).toHaveLength(3);
    expect(rawAfterCompaction.map((message) => message.content)).toEqual([
      "First request",
      "First answer",
      "Latest request",
    ]);
    expect(JSON.stringify(rawAfterCompaction)).not.toContain(
      "[[THREAD_CHECKPOINT]]",
    );

    const compactionRows = db
      .prepare(
        `
      SELECT COUNT(*) AS count
      FROM runtime_thread_entries
      WHERE thread_key = ?
        AND entry_type = 'compaction'
    `,
      )
      .get(threadId) as { count: number };
    expect(compactionRows.count).toBe(1);
    expect(onThreadTranscriptUpdate).toHaveBeenCalledOnce();
    expect(onThreadTranscriptUpdate).toHaveBeenCalledWith({
      conversationId,
      transcriptUpdate: {
        source: "stella",
        threadId,
        entryId: afterCompaction[0]!.entryId,
        atMs: 4_100,
      },
    });
  });

  it("removes all retired automatic-memory docs from compaction overlays", () => {
    const { store } = createTestContext();
    const conversationId = "conv-retired-memory-overlay";
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "general",
    });
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 4_000,
      role: "user",
      content: "Keep working",
      payload: { role: "user", content: "Keep working", timestamp: 4_000 },
    });
    store.appendThreadCustomMessage({
      threadKey: threadId,
      timestamp: 4_001,
      customType: "bootstrap.startup_doc",
      content:
        '<startup_doc path="~/.stella/memories/memory_summary.md">\nLEGACY_RETIRED_SUMMARY\n</startup_doc>',
      display: false,
    });
    const beforeCompaction = store.loadThreadMessages(threadId);
    store.compactThread({
      threadKey: threadId,
      summary: "Continue from the checkpoint",
      fromEntryId: beforeCompaction[0]!.entryId!,
      toEntryId: beforeCompaction[0]!.entryId!,
      tokensBefore: 100,
      timestamp: 4_100,
      details: {
        residentFold: {
          docs: [
            {
              customType: "bootstrap.startup_doc",
              text: '<startup_doc path="~/.stella/memories/memory_summary.md">\nLEGACY_RETIRED_SUMMARY\n</startup_doc>',
            },
            {
              customType: "bootstrap.startup_doc",
              text: '<startup_doc path="~/.stella/memories/MEMORY.md">\nLEGACY_LEDGER\n</startup_doc>',
            },
            {
              customType: "bootstrap.startup_doc",
              text: '<startup_doc path="~/.stella/memories/profile.md">\ncurrent profile\n</startup_doc>',
            },
          ],
        },
      },
    });

    const compacted = JSON.stringify(store.loadThreadMessages(threadId));
    expect(compacted).not.toContain("LEGACY_RETIRED_SUMMARY");
    expect(compacted).not.toContain("LEGACY_LEDGER");
    expect(compacted).toContain("current profile");
  });

  it("sweeps stale rosters at compaction and retains only the next fresh snapshot", () => {
    const { store } = createTestContext();
    const conversationId = "conv-roster-overlay";
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "orchestrator",
    });
    store.appendThreadCustomMessage({
      threadKey: threadId,
      timestamp: 4_000,
      customType: "runtime.orchestrator_reminder",
      content: "STALE_ROSTER",
      display: false,
    });
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 4_001,
      role: "user",
      content: "Keep working",
      payload: { role: "user", content: "Keep working", timestamp: 4_001 },
    });
    store.appendThreadCustomMessage({
      threadKey: threadId,
      timestamp: 4_002,
      customType: "bootstrap.startup_doc",
      content:
        '<startup_doc path="~/.stella/memories/profile.md">\ncurrent profile\n</startup_doc>',
      display: false,
    });

    const beforeCompaction = store.loadThreadMessages(threadId);
    store.compactThread({
      threadKey: threadId,
      summary: "Continue without copying the roster",
      fromEntryId: beforeCompaction[0]!.entryId!,
      toEntryId: beforeCompaction[1]!.entryId!,
      tokensBefore: 100,
      timestamp: 4_100,
      details: {
        replaceDerivedContext: true,
      },
    });
    store.appendThreadCustomMessage({
      threadKey: threadId,
      timestamp: 4_101,
      customType: "runtime.orchestrator_reminder",
      content: "FRESH_ROSTER",
      display: false,
    });

    const messages = store.loadThreadMessages(threadId);
    const compacted = JSON.stringify(messages);
    expect(compacted).not.toContain("STALE_ROSTER");
    expect(compacted).toContain("FRESH_ROSTER");
    expect(
      messages.filter(
        (message) =>
          message.customMessage?.customType === "runtime.orchestrator_reminder",
      ),
    ).toHaveLength(1);
  });

  it("applies later compaction overlays over the same raw message range", () => {
    const { store } = createTestContext();
    const conversationId = "conv-compact-overlay";
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "general",
    });

    for (let index = 0; index < 4; index += 1) {
      store.appendThreadMessage({
        threadKey: threadId,
        timestamp: 5_000 + index,
        role: index % 2 === 0 ? "user" : "assistant",
        content: `Message ${index}`,
        payload:
          index % 2 === 0
            ? {
                role: "user",
                content: `Message ${index}`,
                timestamp: 5_000 + index,
              }
            : {
                role: "assistant",
                content: [{ type: "text", text: `Message ${index}` }],
                api: "openai-responses",
                provider: "openai",
                model: "gpt-5.4",
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                  },
                },
                stopReason: "stop",
                timestamp: 5_000 + index,
              },
      });
    }

    const initial = store.loadThreadMessages(threadId);
    store.compactThread({
      threadKey: threadId,
      summary: "Initial summary",
      fromEntryId: initial[0]!.entryId!,
      toEntryId: initial[1]!.entryId!,
      tokensBefore: 500,
      timestamp: 5_100,
    });

    const afterFirstCompaction = store.loadThreadMessages(threadId);
    expect(afterFirstCompaction.map((message) => message.content)).toEqual([
      expect.stringContaining("[[THREAD_CHECKPOINT]]"),
      "Message 2",
      "Message 3",
    ]);

    const secondPass = store.loadThreadMessages(threadId);
    store.compactThread({
      threadKey: threadId,
      summary: "Updated summary",
      fromEntryId: secondPass[1]!.entryId!,
      toEntryId: secondPass[2]!.entryId!,
      tokensBefore: 900,
      timestamp: 5_200,
    });

    const afterSecondCompaction = store.loadThreadMessages(threadId);
    expect(afterSecondCompaction).toHaveLength(1);
    expect(afterSecondCompaction[0]).toMatchObject({
      role: "assistant",
      content: expect.stringContaining("Updated summary"),
    });
  });

  it("re-emits a pinned latest user instruction right after the checkpoint", () => {
    const { store } = createTestContext();
    const conversationId = "conv-pinned-instruction";
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "general",
    });

    const turns = [
      { role: "user" as const, content: "Spawn prompt" },
      { role: "assistant" as const, content: "Working on it" },
      { role: "user" as const, content: "Task update: do the other thing" },
      { role: "assistant" as const, content: "Switching over" },
      { role: "assistant" as const, content: "Recent tail reply" },
    ];
    for (const [index, turn] of turns.entries()) {
      store.appendThreadMessage({
        threadKey: threadId,
        timestamp: 6_000 + index,
        role: turn.role,
        content: turn.content,
        payload:
          turn.role === "user"
            ? {
                role: "user",
                content: turn.content,
                timestamp: 6_000 + index,
              }
            : {
                role: "assistant",
                content: [{ type: "text", text: turn.content }],
                api: "openai-responses",
                provider: "openai",
                model: "gpt-5.4",
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                  },
                },
                stopReason: "stop",
                timestamp: 6_000 + index,
              },
      });
    }

    const before = store.loadThreadMessages(threadId);
    store.compactThread({
      threadKey: threadId,
      summary: "Condensed: task switched per the update",
      fromEntryId: before[1]!.entryId!,
      toEntryId: before[3]!.entryId!,
      tokensBefore: 400,
      timestamp: 6_100,
      details: {
        pinnedUserInstruction: {
          text: "Task update: do the other thing",
        },
        quarantinedToolResultKeys: ["6042:call-suspect"],
      },
    });

    const after = store.loadThreadMessages(threadId);
    // Order: protected head, checkpoint, pinned instruction copy, kept tail.
    expect(
      after.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ).toEqual([
      { role: "user", content: "Spawn prompt" },
      {
        role: "assistant",
        content: expect.stringContaining("[[THREAD_CHECKPOINT]]"),
      },
      { role: "user", content: "Task update: do the other thing" },
      { role: "assistant", content: "Recent tail reply" },
    ]);
    const pinned = after[2]!;
    expect(pinned.entryId).toContain("::pinned-instruction");
    expect(pinned.payload).toMatchObject({
      role: "user",
      content: "Task update: do the other thing",
    });
    expect(after[1]!.checkpointQuarantineKeys).toEqual(["6042:call-suspect"]);
    expect(after[1]!.content).not.toContain("6042:call-suspect");
  });

  it("truncates oversized persisted tool results to stay under SQLite row limits", () => {
    const { store } = createTestContext();
    const conversationId = "conv-big-tool-result";
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "general",
    });

    // Must exceed THREAD_ROW_MAX_BYTES (6 MB) to trigger the
    // "too large to persist" placeholder path. Multi-MB rows under the cap
    // are intentionally allowed (screenshot tool results land in this range).
    const largeOutput = "A".repeat(8_000_000);
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 6_000,
      role: "toolResult",
      content: largeOutput,
      toolCallId: "tool-call-1",
      payload: {
        role: "toolResult",
        toolCallId: "tool-call-1",
        toolName: "Read",
        content: [{ type: "text", text: largeOutput }],
        isError: false,
        timestamp: 6_000,
      },
    });

    const loaded = store.loadThreadMessages(threadId);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.payload).toMatchObject({
      role: "toolResult",
      toolCallId: "tool-call-1",
    });
    const persistedText =
      loaded[0]?.payload?.role === "toolResult"
        ? loaded[0].payload.content[0]
        : null;
    expect(persistedText).toMatchObject({
      type: "text",
      text: expect.stringContaining("too large to persist in storage"),
    });
  });

  it("automatically preserves exact oversized image rows for pressure accounting", () => {
    const { store } = createTestContext();
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-exact-image-auto",
      agentType: "general",
    });
    const imageData = "a".repeat(6_100_000);
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 6_020,
      role: "toolResult",
      content: "captured",
      toolCallId: "image-call",
      payload: {
        role: "toolResult",
        toolCallId: "image-call",
        toolName: "screenshot",
        content: [
          { type: "text", text: "captured" },
          { type: "image", mimeType: "image/png", data: imageData },
        ],
        isError: false,
        timestamp: 6_020,
      },
    });

    const loaded = store.loadThreadMessages(threadId);
    expect(loaded[0]?.payload).toMatchObject({
      role: "toolResult",
      content: [
        { type: "text", text: "captured" },
        { type: "image", mimeType: "image/png", data: imageData },
      ],
    });
    expect(getThreadImageHistoryStats(loaded)).toMatchObject({
      count: 1,
      decodedBytes: 4_575_000,
    });
    expect(store.getThreadContextPressureStats(threadId)).toMatchObject({
      complete: true,
      imageCount: 1,
      imageDecodedBytes: 4_575_000,
    });
  });

  it("uses narrow metadata for below-threshold compaction probes", async () => {
    const { store } = createTestContext();
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-narrow-pressure-probe",
      agentType: "orchestrator",
    });
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 6_025,
      role: "toolResult",
      content: "captured",
      toolCallId: "large-image-call",
      payload: {
        role: "toolResult",
        toolCallId: "large-image-call",
        toolName: "screenshot",
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: "a".repeat(6_100_000),
          },
        ],
        isError: false,
        timestamp: 6_025,
      },
    });
    const loadMessages = vi.spyOn(store, "loadThreadMessages");
    const loadExact = vi.spyOn(store, "loadExactThreadEntryData");

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: threadId,
      resolvedLlm: {
        route: "stella",
        model: { id: "test/model", contextWindow: 128_000 },
        getApiKey: async () => "unused",
      } as never,
      agentType: "orchestrator",
    });

    expect(result).toEqual({ compacted: false });
    expect(loadMessages).not.toHaveBeenCalled();
    expect(loadExact).not.toHaveBeenCalled();
  });

  it("ignores checkpoint-resolved quarantine without loading covered screenshot history", async () => {
    const { db, store } = createTestContext();
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-resolved-quarantine-narrow-probe",
      agentType: "orchestrator",
    });
    const quarantineKey = "6026:covered-image-call";
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 6_026,
      role: "toolResult",
      content: "covered screenshot",
      toolCallId: "covered-image-call",
      payload: {
        role: "toolResult",
        toolCallId: "covered-image-call",
        toolName: "screenshot",
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: "a".repeat(6_100_000),
          },
        ],
        isError: false,
        timestamp: 6_026,
      },
    });
    store.appendThreadCustomMessage({
      threadKey: threadId,
      timestamp: 6_027,
      customType: "containment.quarantine",
      content: JSON.stringify({
        key: quarantineKey,
        toolName: "screenshot",
        timestamp: 6_026,
      }),
      display: false,
    });
    const covered = store.loadRawThreadMessages(threadId);
    expect(covered).toHaveLength(2);
    store.compactThread({
      threadKey: threadId,
      summary: "The covered screenshot was safely masked.",
      fromEntryId: covered[0]!.entryId,
      toEntryId: covered[1]!.entryId,
      tokensBefore: 1_000,
      details: { quarantinedToolResultKeys: [quarantineKey] },
    });
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 6_028,
      role: "user",
      content: "continue",
      payload: { role: "user", content: "continue", timestamp: 6_028 },
    });
    const physicalChunks = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM runtime_thread_entry_payload_chunks
         WHERE thread_key = ?`,
      )
      .get(threadId) as { count: number };
    expect(physicalChunks.count).toBeGreaterThan(1);
    expect(store.getThreadContextPressureStats(threadId)).toMatchObject({
      complete: true,
      rowCount: 1,
      quarantineCount: 0,
      imageCount: 0,
      imageDecodedBytes: 0,
    });
    const loadMessages = vi.spyOn(store, "loadThreadMessages");
    const loadRawMessages = vi.spyOn(store, "loadRawThreadMessages");
    const loadExact = vi.spyOn(store, "loadExactThreadEntryData");

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: threadId,
      resolvedLlm: {
        route: "stella",
        model: { id: "test/model", contextWindow: 128_000 },
        getApiKey: async () => "unused",
      } as never,
      agentType: "orchestrator",
    });

    expect(result).toEqual({ compacted: false });
    expect(loadMessages).not.toHaveBeenCalled();
    expect(loadRawMessages).not.toHaveBeenCalled();
    expect(loadExact).not.toHaveBeenCalled();
  });

  it("checkpoints one ten-image message with deterministic durable receipts", async () => {
    const { db, rootPath, store } = createTestContext();
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-image-pressure-single-message",
      agentType: "orchestrator",
    });
    const images = Array.from({ length: 10 }, (_, index) => ({
      type: "image" as const,
      mimeType: "image/png",
      data: Buffer.from(`image-${index}`).toString("base64"),
      width: 1024,
      height: 768,
    }));
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 6_030,
      role: "toolResult",
      content: "captured batch",
      toolCallId: "batch-call",
      payload: {
        role: "toolResult",
        toolCallId: "batch-call",
        toolName: "screenshot",
        content: [{ type: "text", text: "captured batch" }, ...images],
        isError: false,
        timestamp: 6_030,
      },
    });
    const rawBefore = store.loadRawThreadMessages(threadId);
    expect(getThreadImageHistoryStats(rawBefore)).toMatchObject({
      count: 10,
      overBudget: true,
    });

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: threadId,
      resolvedLlm: {
        route: "stella",
        model: { id: "test/model", contextWindow: 128_000 },
        getApiKey: async () => "unused",
      } as never,
      agentType: "orchestrator",
      overrideSummary: "Captured a ten-image diagnostic batch.",
      stellaDataDir: rootPath,
    });

    expect(result).toEqual({ compacted: true });
    const effective = store.loadThreadMessages(threadId);
    expect(effective).toHaveLength(1);
    expect(getThreadImageHistoryStats(effective)).toMatchObject({
      count: 0,
      decodedBytes: 0,
      overBudget: false,
    });
    expect(parseThreadCheckpoint(effective[0]!.content)).toEqual({
      summary: "Captured a ten-image diagnostic batch.",
    });
    const receiptMatch = effective[0]!.content.match(
      /<image-receipts version="1">\n(.+)\n<\/image-receipts>/,
    );
    expect(receiptMatch).not.toBeNull();
    const receipts = JSON.parse(receiptMatch![1]!) as Array<{
      id: string;
      artifact: { durability: string; path: string };
    }>;
    expect(receipts).toHaveLength(10);
    for (const receipt of receipts) {
      expect(receipt.id).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(receipt.artifact.durability).toBe("durable");
      expect(receipt.artifact.path).toContain(
        path.join(rootPath, "artifacts", "thread-images"),
      );
      expect(existsSync(receipt.artifact.path)).toBe(true);
    }
    expect(store.loadRawThreadMessages(threadId)).toEqual(rawBefore);
    const compactionRows = db
      .prepare(
        `SELECT COUNT(*) AS count FROM runtime_thread_entries
         WHERE thread_key = ? AND entry_type = 'compaction'`,
      )
      .get(threadId) as { count: number };
    expect(compactionRows.count).toBe(1);

    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 6_040,
      role: "toolResult",
      content: "same image again",
      toolCallId: "duplicate-image-call",
      payload: {
        role: "toolResult",
        toolCallId: "duplicate-image-call",
        toolName: "screenshot",
        content: [images[0]!],
        isError: false,
        timestamp: 6_040,
      },
    });
    for (let index = 0; index < 3; index += 1) {
      store.appendThreadMessage({
        threadKey: threadId,
        timestamp: 6_041 + index,
        role: "user",
        content: `follow-up ${index}`,
        payload: {
          role: "user",
          content: `follow-up ${index}`,
          timestamp: 6_041 + index,
        },
      });
    }
    await withForcedThreadCompaction(threadId, () =>
      maybeCompactRuntimeThread({
        store,
        threadKey: threadId,
        resolvedLlm: {
          route: "stella",
          model: { id: "test/model", contextWindow: 128_000 },
          getApiKey: async () => "unused",
        } as never,
        agentType: "orchestrator",
        overrideSummary: "Successor checkpoint.",
        stellaDataDir: rootPath,
      }),
    );
    const successor = store.loadThreadMessages(threadId)[0]!;
    const successorMatch = successor.content.match(
      /<image-receipts version="1">\n(.+)\n<\/image-receipts>/,
    );
    const successorReceipts = JSON.parse(successorMatch![1]!) as Array<{
      id: string;
    }>;
    expect(successorReceipts).toHaveLength(10);
    expect(new Set(successorReceipts.map((receipt) => receipt.id)).size).toBe(
      10,
    );
  });

  it("preserves exact oversized payloads for an evictable working set", () => {
    const { db, store } = createTestContext();
    const conversationId = "conv-exact-big-tool-result";
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "orchestrator",
    });
    const largeOutput = "A".repeat(6_100_000);
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 6_049,
      role: "user",
      content: "old request",
    });
    const oldEntryId = store.loadThreadMessages(threadId)[0]?.entryId;

    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 6_050,
      role: "toolResult",
      content: largeOutput,
      toolCallId: "tool-call-exact",
      preservePayloadExactly: true,
      payload: {
        role: "toolResult",
        toolCallId: "tool-call-exact",
        toolName: "Read",
        content: [{ type: "text", text: largeOutput }],
        isError: false,
        timestamp: 6_050,
      },
    });

    const loaded = store.loadThreadMessages(threadId);
    expect(loaded[1]?.payload).toMatchObject({
      role: "toolResult",
      content: [{ type: "text", text: largeOutput }],
    });
    expect(oldEntryId).toBeTruthy();
    store.compactThread({
      threadKey: threadId,
      summary: "Old request summary",
      fromEntryId: oldEntryId,
      toEntryId: oldEntryId,
      tokensBefore: 10,
      timestamp: 6_051,
    });
    expect(
      store
        .loadThreadMessages(threadId)
        .find((message) => message.role === "toolResult")?.payload,
    ).toMatchObject({
      role: "toolResult",
      content: [{ type: "text", text: largeOutput }],
    });
    const physicalRows = db
      .prepare(
        `SELECT length(CAST(data_json AS BLOB)) AS bytes
         FROM runtime_thread_entries
         UNION ALL
         SELECT length(CAST(chunk_text AS BLOB)) AS bytes
         FROM runtime_thread_entry_payload_chunks`,
      )
      .all() as Array<{ bytes: number }>;
    expect(physicalRows.length).toBeGreaterThan(2);
    expect(
      Math.max(...physicalRows.map((row) => row.bytes)),
    ).toBeLessThanOrEqual(6_000_000);
  });

  it("preserves exact oversized runtime context for an evictable working set", () => {
    const { db, store } = createTestContext();
    const conversationId = "conv-exact-big-runtime-context";
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "orchestrator",
    });
    const largeContext = "C".repeat(6_100_000);

    store.appendThreadCustomMessage({
      threadKey: threadId,
      timestamp: 6_075,
      customType: "bootstrap.startup_doc",
      content: largeContext,
      display: false,
      preservePayloadExactly: true,
    });

    expect(store.loadThreadMessages(threadId)[0]?.customMessage).toMatchObject({
      content: largeContext,
      customType: "bootstrap.startup_doc",
    });
    const chunkRows = db
      .prepare(
        `SELECT length(CAST(chunk_text AS BLOB)) AS bytes
         FROM runtime_thread_entry_payload_chunks
         ORDER BY chunk_index ASC`,
      )
      .all() as Array<{ bytes: number }>;
    expect(chunkRows.length).toBeGreaterThan(1);
    expect(Math.max(...chunkRows.map((row) => row.bytes))).toBeLessThanOrEqual(
      6_000_000,
    );
  });

  it("does not split an exact payload surrogate pair across physical chunks", () => {
    const { store } = createTestContext();
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-exact-surrogate-boundary",
      agentType: "orchestrator",
    });
    const marker = "__SURROGATE_BOUNDARY__";
    const template = JSON.stringify({
      customType: "runtime.context_delta.test",
      content: marker,
      display: false,
    });
    const markerOffset = template.indexOf(marker);
    expect(markerOffset).toBeGreaterThan(0);
    const content =
      "x".repeat(1_000_000 - markerOffset - 1) + "😀" + "y".repeat(5_100_000);

    store.appendThreadCustomMessage({
      threadKey: threadId,
      timestamp: 6_075,
      customType: "runtime.context_delta.test",
      content,
      display: false,
      preservePayloadExactly: true,
    });

    expect(store.loadThreadMessages(threadId)[0]?.customMessage?.content).toBe(
      content,
    );
  });

  it("reconstructs explicit legacy tool errors without changing successful rows", () => {
    const { store } = createTestContext();
    const conversationId = "conv-legacy-tool-errors";
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "general",
    });

    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 6_100,
      role: "toolResult",
      content: "Error: [TOOL_ERROR] native command failed",
      toolCallId: "failed-call",
    });
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 6_200,
      role: "toolResult",
      content: "The Error: field was documented successfully",
      toolCallId: "successful-call",
    });

    const loaded = store.loadThreadMessages(threadId);
    expect(loaded[0]?.payload).toMatchObject({
      role: "toolResult",
      toolCallId: "failed-call",
      isError: true,
    });
    expect(loaded[1]?.payload).toMatchObject({
      role: "toolResult",
      toolCallId: "successful-call",
      isError: false,
    });
  });

  it("lazily registers implicit orchestrator thread keys", () => {
    const { db, store } = createTestContext();
    const conversationId = "01kp5755c8mz3dpc22zas71d97";

    store.appendThreadMessage({
      threadKey: conversationId,
      timestamp: 3_000,
      role: "user",
      content: "Hello from the orchestrator thread",
      payload: {
        role: "user",
        content: "Hello from the orchestrator thread",
        timestamp: 3_000,
      },
    });

    const loaded = store.loadThreadMessages(conversationId);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.content).toBe("Hello from the orchestrator thread");

    const runtimeThread = db
      .prepare(
        `
      SELECT
        conversation_id AS conversationId,
        agent_type AS agentType,
        status
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `,
      )
      .get(conversationId) as {
      conversationId: string;
      agentType: string;
      status: string;
    };
    expect(runtimeThread).toEqual({
      conversationId,
      agentType: "orchestrator",
      status: "evicted",
    });
  });
});

describe("thread activity rows", () => {
  it("rejects a stale attempt generation atomically", () => {
    const { store } = createTestContext();
    const current = {
      threadId: "generation-fence",
      conversationId: "conv-fence",
      agentType: "general",
      description: "Generation fence",
      agentDepth: 0,
      status: "completed" as const,
      startedAt: 1_000,
      completedAt: 2_000,
      result: "new result",
      updatedAt: 2_000,
      attemptGeneration: 3,
    };
    expect(store.saveAgentRecord(current)).toBe(1);

    expect(
      store.saveAgentRecord({
        ...current,
        status: "canceled",
        result: undefined,
        error: "stale cancellation",
        attemptGeneration: 1,
        updatedAt: 3_000,
      }),
    ).toBeNull();
    expect(store.getAgentRecord(current.threadId)).toMatchObject({
      status: "completed",
      result: "new result",
      attemptGeneration: 3,
      recordRevision: 1,
    });
  });

  it("never rebinds a persisted agent thread across owner generations", () => {
    const { store } = createTestContext();
    const current = {
      threadId: "owner-generation-fence",
      conversationId: "conv-owner-fence",
      storageMode: "cloud" as const,
      ownerGeneration: "owner-generation-2",
      agentType: "general",
      description: "Owner generation fence",
      agentDepth: 0,
      status: "running" as const,
      startedAt: 1_000,
      completedAt: null,
      updatedAt: 1_000,
      attemptGeneration: 3,
    };
    expect(store.saveAgentRecord(current)).toBe(1);

    expect(
      store.saveAgentRecord({
        ...current,
        ownerGeneration: "owner-generation-1",
        status: "canceled",
        error: "late equal-attempt owner write",
        updatedAt: 2_000,
      }),
    ).toBeNull();
    expect(
      store.saveAgentRecord({
        ...current,
        ownerGeneration: "owner-generation-3",
        attemptGeneration: 4,
        updatedAt: 3_000,
      }),
    ).toBeNull();
    expect(store.getAgentRecord(current.threadId)).toMatchObject({
      conversationId: current.conversationId,
      storageMode: "cloud",
      ownerGeneration: current.ownerGeneration,
      status: "running",
      attemptGeneration: current.attemptGeneration,
      recordRevision: 1,
    });

    expect(
      store.saveAgentRecord({
        ...current,
        status: "completed",
        completedAt: 4_000,
        updatedAt: 4_000,
      }),
    ).toBe(2);
  });

  it("bounds desktop hydration while retaining active work", () => {
    const { db, store } = createTestContext();
    for (let index = 0; index < 501; index += 1) {
      store.saveAgentRecord({
        threadId: `terminal-${String(index).padStart(3, "0")}`,
        conversationId: "conv-bounded-activity",
        agentType: "general",
        description: `Terminal ${index}`,
        agentDepth: 0,
        status: "completed",
        startedAt: index + 10,
        completedAt: index + 10,
        updatedAt: index + 10,
      });
    }
    store.saveAgentRecord({
      threadId: "old-active",
      conversationId: "conv-bounded-activity",
      agentType: "general",
      description: "Old but active",
      agentDepth: 0,
      status: "running",
      startedAt: 1,
      completedAt: null,
      updatedAt: 1,
    });

    const rows = store.listThreadActivity("conv-bounded-activity");

    expect(rows).toHaveLength(500);
    expect(rows.some((row) => row.threadId === "old-active")).toBe(true);
    expect(rows.some((row) => row.threadId === "terminal-000")).toBe(false);
    expect(rows.some((row) => row.threadId === "terminal-500")).toBe(true);
    const mobileRows = store.listThreadActivity("conv-bounded-activity", {
      view: "mobile-summary",
      maxItems: 500,
    });
    expect(mobileRows).toHaveLength(500);
    expect(mobileRows.some((row) => row.threadId === "old-active")).toBe(true);
    expect(mobileRows.some((row) => row.threadId === "terminal-000")).toBe(
      false,
    );
    expect(mobileRows.some((row) => row.threadId === "terminal-500")).toBe(
      true,
    );
    const activePlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT thread_id FROM runtime_agents
         WHERE conversation_id = ? AND status IN ('pending', 'running')
         ORDER BY updated_at DESC, thread_id ASC LIMIT 500`,
      )
      .all("conv-bounded-activity") as Array<{ detail?: string }>;
    const terminalPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT thread_id FROM runtime_agents
         WHERE conversation_id = ? AND status NOT IN ('pending', 'running')
         ORDER BY updated_at DESC, thread_id ASC LIMIT 500`,
      )
      .all("conv-bounded-activity") as Array<{ detail?: string }>;
    expect(activePlan.map((step) => step.detail).join("\n")).toContain(
      "idx_runtime_agents_active_updated",
    );
    expect(terminalPlan.map((step) => step.detail).join("\n")).toContain(
      "idx_runtime_agents_terminal_updated",
    );
  });

  it("persists workspace identity and increments a durable record revision", () => {
    const { store } = createTestContext();
    const base = {
      threadId: "durable-agent",
      conversationId: "conv-durable",
      agentType: "general",
      description: "Durable task",
      prompt: "Do durable work",
      promptCreatedAt: 1_000,
      agentDepth: 0,
      toolWorkspaceRoot: "/tmp/durable-workspace",
      status: "running" as const,
      startedAt: 1_000,
      completedAt: null,
      updatedAt: 1_000,
    };

    expect(store.saveAgentRecord(base)).toBe(1);
    expect(
      store.saveAgentRecord({
        ...base,
        status: "completed",
        completedAt: 2_000,
        updatedAt: 2_000,
      }),
    ).toBe(2);
    expect(store.getAgentRecord(base.threadId)).toMatchObject({
      status: "completed",
      toolWorkspaceRoot: "/tmp/durable-workspace",
      recordRevision: 2,
    });
    expect(store.listThreadActivity(base.conversationId)[0]).toMatchObject({
      threadId: base.threadId,
      recordRevision: 2,
    });
  });

  it("projects one authoritative row per thread, joined with group fields", () => {
    const { db, store } = createTestContext();
    store.saveAgentRecord({
      threadId: "research-flights",
      conversationId: "conv-1",
      agentType: "general",
      description: "Research flights",
      agentDepth: 0,
      status: "running",
      rootRunId: "root-1",
      startedAt: 1_000,
      completedAt: null,
      updatedAt: 1_500,
    });
    store.saveAgentRecord({
      threadId: "book-hotel",
      conversationId: "conv-1",
      agentType: "general",
      description: "Book the hotel",
      agentDepth: 0,
      status: "completed",
      rootRunId: "root-2",
      startedAt: 2_000,
      completedAt: 3_000,
      result: "Booked the Marriott",
      updatedAt: 3_000,
    });
    // Group fields ride the thread registry, joined by thread id.
    db.prepare(
      `INSERT INTO runtime_threads (
         thread_key, conversation_id, agent_type, name, status,
         created_at, last_used_at, group_key, group_label
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "book-hotel",
      "conv-1",
      "general",
      "Book the hotel",
      "active",
      2_000,
      3_000,
      "grp-trip",
      "Plan the trip",
    );
    // Other conversations stay out of the projection.
    store.saveAgentRecord({
      threadId: "other-thread",
      conversationId: "conv-2",
      agentType: "general",
      description: "Other work",
      agentDepth: 0,
      status: "running",
      startedAt: 500,
      completedAt: null,
      updatedAt: 500,
    });

    const rows = store.listThreadActivity("conv-1");
    expect(rows.map((row) => row.threadId)).toEqual([
      "research-flights",
      "book-hotel",
    ]);
    expect(rows[0]).toMatchObject({
      status: "running",
      description: "Research flights",
      rootRunId: "root-1",
      startedAt: 1_000,
    });
    expect(rows[1]).toMatchObject({
      status: "completed",
      completedAt: 3_000,
      result: "Booked the Marriott",
      groupKey: "grp-trip",
      groupLabel: "Plan the trip",
    });
    expect(store.getThreadActivityMetadata("book-hotel")).toEqual({
      groupKey: "grp-trip",
      groupLabel: "Plan the trip",
    });
  });

  it("reflects the latest upsert — a follow-up's re-description and rebind win", () => {
    const { store } = createTestContext();
    const base = {
      threadId: "research-flights",
      conversationId: "conv-1",
      agentType: "general",
      description: "Research flights",
      agentDepth: 0,
      status: "running" as const,
      rootRunId: "root-1",
      startedAt: 1_000,
      completedAt: null,
      updatedAt: 1_000,
    };
    store.saveAgentRecord(base);
    store.saveAgentRecord({
      ...base,
      description: "Search for the itinerary email",
      rootRunId: "root-2",
      updatedAt: 2_000,
    });
    store.saveAgentRecord({
      ...base,
      description: "Search for the itinerary email",
      rootRunId: "root-2",
      status: "completed",
      completedAt: 3_000,
      result: "Found it",
      updatedAt: 3_000,
    });

    const rows = store.listThreadActivity("conv-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      description: "Search for the itinerary email",
      rootRunId: "root-2",
      status: "completed",
      completedAt: 3_000,
      result: "Found it",
    });
  });
});
