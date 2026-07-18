import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "@stella/runtime/kernel/storage/database-init";
import {
  AGENT_ASSISTANT_UPDATE_LIMITS,
  SessionStore,
  type PersistedAgentRecord,
} from "@stella/runtime/kernel/storage/session-store";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";
import type {
  ThreadActivityUpdatedPayload,
  ThreadTranscriptUpdatedPayload,
} from "@stella/contracts/local-chat";

type TestContext = {
  rootPath: string;
  db: SqliteDatabase;
  store: SessionStore;
};

const activeContexts = new Set<TestContext>();

const createTestContext = (
  onThreadAssistantUpdate?: (payload: ThreadActivityUpdatedPayload) => void,
  onThreadTranscriptUpdate?: (payload: ThreadTranscriptUpdatedPayload) => void,
): TestContext => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-agent-messages-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const dbPath = getDesktopDatabasePath(rootPath);
  const db = new DatabaseSync(dbPath, {
    timeout: 5000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const context = {
    rootPath,
    db,
    store: new SessionStore(db, {
      onThreadAssistantUpdate,
      onThreadTranscriptUpdate,
    }),
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

const EMPTY_USAGE = {
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
};

const appendAssistant = (
  store: SessionStore,
  args: {
    threadId: string;
    timestamp: number;
    text: string;
    stopReason?: "toolUse" | "stop";
    attemptGeneration?: number;
  },
) => {
  const stopReason = args.stopReason ?? "toolUse";
  store.appendThreadMessage({
    threadKey: args.threadId,
    timestamp: args.timestamp,
    role: "assistant",
    content: args.text,
    payload: {
      role: "assistant",
      content: args.text ? [{ type: "text", text: args.text }] : [],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "codex",
      usage: EMPTY_USAGE,
      stopReason,
      timestamp: args.timestamp,
      stellaAttemptGeneration: args.attemptGeneration ?? 0,
    } as never,
  });
};

const saveRunningAgent = (
  store: SessionStore,
  args: {
    threadId: string;
    conversationId?: string;
    startedAt: number;
    attemptGeneration?: number;
    agentType?: string;
    updatedAt?: number;
    modelConfigSnapshot?: PersistedAgentRecord["modelConfigSnapshot"];
  },
) => {
  store.saveAgentRecord({
    threadId: args.threadId,
    conversationId: args.conversationId ?? "conv-1",
    agentType: args.agentType ?? "general",
    description: `Work for ${args.threadId}`,
    agentDepth: 0,
    status: "running",
    attemptGeneration: args.attemptGeneration ?? 0,
    ...(args.modelConfigSnapshot
      ? { modelConfigSnapshot: args.modelConfigSnapshot }
      : {}),
    startedAt: args.startedAt,
    completedAt: null,
    updatedAt: args.updatedAt ?? args.startedAt,
  });
};

describe("agent-authored assistant updates", () => {
  it("reads recent assistant messages verbatim and ignores legacy generated rows", () => {
    const { db, store } = createTestContext();
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-1",
      agentType: "general",
      threadId: "agent-1",
      nameHint: "Inspect the routes",
    });
    saveRunningAgent(store, { threadId, startedAt: 1_000 });

    for (const [index, content] of [
      "Oldest update",
      "I checked the route.\n\nIt already redirects safely.",
      "I removed the stale action.",
      "The focused tests pass.",
    ].entries()) {
      appendAssistant(store, {
        threadId,
        timestamp: 1_000 + index,
        text: content,
      });
    }
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 2_000,
      role: "toolResult",
      toolCallId: "tool-1",
      content: "tool output must not become an agent update",
    });
    db.prepare(
      `INSERT INTO agent_progress_summaries (agent_id, text, created_at)
       VALUES (?, ?, ?)`,
    ).run(threadId, "old generated summary", 3_000);

    expect(store.listAgentAssistantMessages(threadId, 3)).toEqual([
      {
        text: "I checked the route.\n\nIt already redirects safely.",
        atMs: 1_001,
      },
      { text: "I removed the stale action.", atMs: 1_002 },
      { text: "The focused tests pass.", atMs: 1_003 },
    ]);
  });

  it("projects the same assistant messages into Activity rows", () => {
    const { store } = createTestContext();
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-1",
      agentType: "general",
      threadId: "agent-1",
      nameHint: "Inspect the routes",
    });
    saveRunningAgent(store, { threadId, startedAt: 1_000 });
    appendAssistant(store, {
      threadId,
      timestamp: 1_001,
      text: "I found the stale navigation path.",
    });

    expect(store.listThreadActivity("conv-1")[0]).toEqual(
      expect.objectContaining({
        assistantMessages: ["I found the stale navigation path."],
        assistantMessagesUpdatedAt: 1_001,
      }),
    );
  });

  it("orders and fences authored messages written in the same millisecond", () => {
    const onThreadAssistantUpdate = vi.fn();
    const { store } = createTestContext(onThreadAssistantUpdate);
    saveRunningAgent(store, {
      threadId: "same-ms-agent",
      startedAt: 1_000,
      attemptGeneration: 3,
    });
    appendAssistant(store, {
      threadId: "same-ms-agent",
      timestamp: 1_001,
      text: "First same-millisecond update",
      attemptGeneration: 3,
    });
    appendAssistant(store, {
      threadId: "same-ms-agent",
      timestamp: 1_001,
      text: "Second same-millisecond update",
      attemptGeneration: 3,
    });

    const updates = onThreadAssistantUpdate.mock.calls.map(
      ([payload]) => payload.assistantUpdate!,
    );
    expect(updates).toHaveLength(2);
    expect(updates[1]!.atMs).toBe(updates[0]!.atMs);
    expect(updates[1]!.entrySequence).toBeGreaterThan(
      updates[0]!.entrySequence,
    );
    expect(updates[1]!.assistantMessages).toEqual([
      "First same-millisecond update",
      "Second same-millisecond update",
    ]);
    expect(store.listThreadActivity("conv-1")[0]).toMatchObject({
      assistantMessages: [
        "First same-millisecond update",
        "Second same-millisecond update",
      ],
      assistantMessagesUpdatedAt: 1_001,
      assistantMessagesEntrySequence: updates[1]!.entrySequence,
    });
  });

  it("projects a bounded exact-agent transcript and rejects root threads", () => {
    const { store } = createTestContext();
    saveRunningAgent(store, {
      threadId: "manager-thread",
      startedAt: 1_000,
      attemptGeneration: 1,
      agentType: "manager",
    });
    store.appendThreadMessage({
      threadKey: "manager-thread",
      timestamp: 1_001,
      role: "user",
      content: "Coordinate the check.",
    });
    store.appendThreadMessage({
      threadKey: "manager-thread",
      timestamp: 1_002,
      role: "assistant",
      content: "I inspected the ancestry.",
      payload: {
        role: "assistant",
        content: [
          { type: "text", text: "I inspected the ancestry." },
          {
            type: "toolCall",
            id: "tool-1",
            name: "exec_command",
            arguments: { cmd: "git status --short" },
          },
        ],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "codex",
        usage: EMPTY_USAGE,
        stopReason: "toolUse",
        timestamp: 1_002,
        stellaAttemptGeneration: 1,
      } as never,
    });
    store.appendThreadMessage({
      threadKey: "manager-thread",
      timestamp: 1_003,
      role: "toolResult",
      toolCallId: "tool-1",
      content: "clean",
      payload: {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "exec_command",
        content: [{ type: "text", text: "clean" }],
        isError: false,
        timestamp: 1_003,
      } as never,
    });

    expect(store.listThreadTranscript("manager-thread")).toMatchObject({
      threadId: "manager-thread",
      agentType: "manager",
      status: "running",
      truncated: false,
      entries: [
        { kind: "user", text: "Coordinate the check." },
        {
          kind: "assistant",
          text: "I inspected the ancestry.",
        },
      ],
    });

    saveRunningAgent(store, {
      threadId: "root-thread",
      startedAt: 1_000,
      agentType: "orchestrator",
    });
    expect(store.listThreadTranscript("root-thread")).toBeNull();
  });

  it.each(["general", "manager"])(
    "invalidates a %s transcript for tool-only durable entries without authored updates",
    (agentType) => {
      const onThreadAssistantUpdate = vi.fn();
      const onThreadTranscriptUpdate = vi.fn();
      const { store } = createTestContext(
        onThreadAssistantUpdate,
        onThreadTranscriptUpdate,
      );
      const threadId = `${agentType}-tool-only`;
      store.resolveOrCreateActiveThread({
        conversationId: "conv-tool-only",
        agentType,
        threadId,
        nameHint: "Tool-only transcript",
      });
      saveRunningAgent(store, {
        threadId,
        conversationId: "conv-tool-only",
        startedAt: 1_000,
        attemptGeneration: 2,
        agentType,
      });
      store.appendThreadMessage({
        threadKey: threadId,
        timestamp: 1_001,
        role: "assistant",
        content: "",
        payload: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-only-1",
              name: "exec_command",
              arguments: { cmd: "git status --short" },
            },
          ],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "codex",
          usage: EMPTY_USAGE,
          stopReason: "toolUse",
          timestamp: 1_001,
          stellaAttemptGeneration: 2,
        } as never,
      });
      store.appendThreadMessage({
        threadKey: threadId,
        timestamp: 1_002,
        role: "toolResult",
        toolCallId: "tool-only-1",
        content: "clean",
        payload: {
          role: "toolResult",
          toolCallId: "tool-only-1",
          toolName: "exec_command",
          content: [{ type: "text", text: "clean" }],
          isError: false,
          timestamp: 1_002,
        } as never,
      });
      store.appendEvent({
        conversationId: "conv-tool-only",
        eventId: `${threadId}:2:agent-started`,
        timestamp: 1_003,
        type: "agent-started",
        payload: {
          agentId: `${threadId}-child`,
          agentType: "general",
          description: "Inspect child ownership",
          attemptGeneration: 1,
        },
      });
      store.appendThreadCustomMessage({
        threadKey: threadId,
        timestamp: 1_003,
        customType: "runtime.task_lifecycle",
        content: [
          {
            type: "text",
            text: "<system_reminder> managed child started with raw details",
          },
        ],
        display: true,
        eventId: `${threadId}:2:agent-started`,
      });

      expect(onThreadAssistantUpdate).not.toHaveBeenCalled();
      expect(onThreadTranscriptUpdate).toHaveBeenCalledTimes(3);
      expect(
        onThreadTranscriptUpdate.mock.calls.map(([payload]) => payload),
      ).toEqual([
        expect.objectContaining({
          threadId,
          conversationId: "conv-tool-only",
          entryType: "message",
          atMs: 1_001,
        }),
        expect.objectContaining({
          threadId,
          conversationId: "conv-tool-only",
          entryType: "message",
          atMs: 1_002,
        }),
        expect.objectContaining({
          threadId,
          conversationId: "conv-tool-only",
          entryType: "custom_message",
          atMs: 1_003,
        }),
      ]);
      const entryIds = onThreadTranscriptUpdate.mock.calls.map(
        ([payload]) => payload.entryId,
      );
      expect(entryIds.every(Boolean)).toBe(true);
      expect(new Set(entryIds).size).toBe(3);
      expect(store.listThreadTranscript(threadId)?.entries).toMatchObject([
        {
          kind: "lifecycle",
          lifecycleEvent: {
            _id: `${threadId}:2:agent-started`,
            type: "agent-started",
            payload: {
              agentId: `${threadId}-child`,
              description: "Inspect child ownership",
            },
          },
        },
      ]);
      expect(JSON.stringify(store.listThreadTranscript(threadId))).not.toMatch(
        /exec_command|git status|\[Tool call\]|\[Tool result\]|managed child started/,
      );
    },
  );

  it.each([
    {
      engine: "Stella-native",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
    },
    {
      engine: "Codex",
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "codex",
    },
    {
      engine: "Claude Code",
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-code",
    },
  ])(
    "projects $engine assistant prose while suppressing structured tool noise",
    ({ engine, api, provider, model }) => {
      const { store } = createTestContext();
      const threadId = `engine-${engine.toLowerCase().replaceAll(" ", "-")}`;
      store.resolveOrCreateActiveThread({
        conversationId: "conv-engine-projection",
        agentType: "general",
        threadId,
      });
      saveRunningAgent(store, {
        threadId,
        conversationId: "conv-engine-projection",
        startedAt: 2_000,
        attemptGeneration: 1,
      });
      store.appendThreadMessage({
        threadKey: threadId,
        timestamp: 2_001,
        role: "assistant",
        content: "",
        payload: {
          role: "assistant",
          content: [
            { type: "text", text: `${engine} preamble` },
            {
              type: "toolCall",
              id: `${threadId}-spawn`,
              name: "spawn_agent",
              arguments: {
                description: "Raw child task must stay hidden",
                prompt: "Sensitive transport payload",
              },
            },
            { type: "text", text: `${engine} authored continuation` },
          ],
          api,
          provider,
          model,
          usage: EMPTY_USAGE,
          stopReason: "toolUse",
          timestamp: 2_001,
          stellaAttemptGeneration: 1,
        } as never,
      });
      store.appendThreadMessage({
        threadKey: threadId,
        timestamp: 2_002,
        role: "toolResult",
        toolCallId: `${threadId}-spawn`,
        content: '{"childThreadId":"internal-child"}',
      });

      const projected = store.listThreadTranscript(threadId);
      expect(projected?.entries).toEqual([
        expect.objectContaining({
          kind: "assistant",
          text: `${engine} preamble\n\n${engine} authored continuation`,
        }),
      ]);
      expect(JSON.stringify(projected)).not.toMatch(
        /spawn_agent|Raw child task|Sensitive transport|childThreadId|\[Tool call\]|\[Tool result\]/,
      );
    },
  );

  it.each([
    {
      engine: "Stella",
      runtimeEngine: "default" as const,
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
    },
    {
      engine: "Codex",
      runtimeEngine: "codex_cli" as const,
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "codex",
    },
  ])(
    "keeps $engine authored prose and suppresses generic tool transport after compaction and reload",
    ({ engine, runtimeEngine, api, provider, model }) => {
      const context = createTestContext();
      const threadId = `compacted-${engine.toLowerCase()}-thread`;
      const conversationId = `conv-compacted-${engine.toLowerCase()}`;
      context.store.resolveOrCreateActiveThread({
        conversationId,
        agentType: "general",
        threadId,
      });
      saveRunningAgent(context.store, {
        threadId,
        conversationId,
        startedAt: 2_100,
        attemptGeneration: 1,
        modelConfigSnapshot: {
          engine: runtimeEngine,
          routeModel:
            runtimeEngine === "codex_cli"
              ? "stella/openai/gpt-5.6-sol"
              : "stella/openai/gpt-5.4",
          ...(runtimeEngine === "codex_cli"
            ? { engineModel: "gpt-5.6-codex" }
            : {}),
        },
      });
      const toolCallId = `${threadId}-exec`;
      const secretCommand = `printf ${engine.toLowerCase()}-transport-secret`;
      const secretResult = `${engine.toLowerCase()}-transport-result`;
      context.store.appendThreadMessage({
        threadKey: threadId,
        timestamp: 2_101,
        role: "assistant",
        content: "",
        payload: {
          role: "assistant",
          content: [
            { type: "text", text: `${engine} authored preamble.` },
            {
              type: "toolCall",
              id: toolCallId,
              name: "exec_command",
              arguments: { cmd: secretCommand },
            },
            { type: "text", text: `${engine} authored conclusion.` },
          ],
          api,
          provider,
          model,
          usage: EMPTY_USAGE,
          stopReason: "toolUse",
          timestamp: 2_101,
          stellaAttemptGeneration: 1,
        } as never,
      });
      context.store.appendThreadMessage({
        threadKey: threadId,
        timestamp: 2_102,
        role: "toolResult",
        toolCallId,
        content: secretResult,
        payload: {
          role: "toolResult",
          toolCallId,
          toolName: "exec_command",
          content: [{ type: "text", text: secretResult }],
          isError: false,
          timestamp: 2_102,
        } as never,
      });
      const compactedEntries = context.store.loadThreadMessages(threadId);
      context.store.compactThread({
        threadKey: threadId,
        summary: `[Tool call] exec_command\nargs: ${JSON.stringify({ cmd: secretCommand })}\n\n[Tool result] exec_command\n${secretResult}`,
        fromEntryId: compactedEntries[0]!.entryId!,
        toEntryId: compactedEntries[1]!.entryId!,
        tokensBefore: 300,
        timestamp: 2_103,
      });

      const beforeReload = context.store.listThreadTranscript(threadId);
      expect(beforeReload?.entries).toEqual([
        expect.objectContaining({
          kind: "assistant",
          text: `${engine} authored preamble.\n\n${engine} authored conclusion.`,
        }),
      ]);
      expect(JSON.stringify(beforeReload)).not.toMatch(
        new RegExp(
          `exec_command|${engine.toLowerCase()}-transport-secret|${engine.toLowerCase()}-transport-result|\\[Tool call\\]|\\[Tool result\\]`,
        ),
      );

      context.db.close();
      const reopenedDb = new DatabaseSync(
        getDesktopDatabasePath(context.rootPath),
        { timeout: 5000 },
      ) as unknown as SqliteDatabase;
      context.db = reopenedDb;
      context.store = new SessionStore(reopenedDb);
      expect(context.store.listThreadTranscript(threadId)).toEqual(
        beforeReload,
      );
    },
  );

  it("projects the captured Claude Code spawn, prose, follow-up, and completion shapes after compaction and reload", () => {
    const context = createTestContext();
    const threadId = "coordinate-milestone-m5-of-stella-v2-phase-1";
    const childId = "m5-surface-1-rearchitect-worker-server-ts-into";
    const conversationId = "conv-claude-native";
    context.store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "manager",
      threadId,
    });
    saveRunningAgent(context.store, {
      threadId,
      conversationId,
      startedAt: 3_000,
      attemptGeneration: 1,
      agentType: "manager",
      modelConfigSnapshot: {
        engine: "claude_code_local",
        routeModel: "stella/anthropic/claude-fable-5",
        engineModel: "fable",
        reasoningEffort: "high",
      },
    });
    context.store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "general",
      threadId: childId,
    });
    context.store.saveAgentRecord({
      threadId: childId,
      conversationId,
      agentType: "general",
      description:
        "M5 Surface 1: rearchitect worker/server.ts into Effect services/Layers (Fable 5)",
      agentDepth: 2,
      parentAgentId: threadId,
      status: "completed",
      attemptGeneration: 3,
      startedAt: 3_001,
      completedAt: 3_007,
      result: "Surface 1 follow-up confirmed clean.",
      updatedAt: 3_007,
    });
    context.store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 3_001,
      role: "assistant",
      content: "",
      payload: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "mcp:7f64f4df-aba5-40c6-a131-92f5e00451eb:2",
            name: "spawn_agent",
            arguments: {
              description:
                "M5 Surface 1: rearchitect worker/server.ts into Effect services/Layers (Fable 5)",
              prompt: "Raw implementation brief must remain hidden.",
            },
          },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-code",
        usage: EMPTY_USAGE,
        stopReason: "toolUse",
        timestamp: 3_001,
        stellaAttemptGeneration: 1,
      } as never,
    });
    context.store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 3_002,
      role: "toolResult",
      toolCallId: "mcp:7f64f4df-aba5-40c6-a131-92f5e00451eb:2",
      content: JSON.stringify({
        thread_id: childId,
        created: true,
        running_in_background: true,
        follow_up_on_completion: true,
      }),
      payload: {
        role: "toolResult",
        toolCallId: "mcp:7f64f4df-aba5-40c6-a131-92f5e00451eb:2",
        toolName: "spawn_agent",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              thread_id: childId,
              created: true,
              running_in_background: true,
              follow_up_on_completion: true,
            }),
          },
        ],
        isError: false,
        timestamp: 3_002,
      } as never,
    });
    context.store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 3_003,
      role: "assistant",
      content:
        "Surface 1 is underway. I passed the implementation agent the scoped brief.",
      payload: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Surface 1 is underway. I passed the implementation agent the scoped brief.",
          },
        ],
        api: "openai-completions",
        provider: "stella",
        model: "history",
        usage: EMPTY_USAGE,
        stopReason: "stop",
        timestamp: 3_003,
      } as never,
    });
    const compactedEntries = context.store.loadThreadMessages(threadId);
    context.store.compactThread({
      threadKey: threadId,
      summary:
        '[Tool call] spawn_agent\nargs: {"prompt":"Raw implementation brief"}\n\n[Tool result] spawn_agent\n{"running_in_background":true}',
      fromEntryId: compactedEntries[0]!.entryId!,
      toEntryId: compactedEntries[2]!.entryId!,
      tokensBefore: 500,
      timestamp: 3_004,
    });
    const firstCompletionId = `${childId}:1:agent-completed`;
    context.store.appendThreadCustomMessage({
      threadKey: threadId,
      timestamp: 3_005,
      customType: "runtime.task_lifecycle",
      content: [
        {
          type: "text",
          text: "[Agent completed]\nraw routing reminder must stay hidden",
        },
      ],
      display: false,
      eventId: firstCompletionId,
      lifecycleEvent: {
        type: "agent-completed",
        payload: {
          agentId: childId,
          attemptGeneration: 1,
          result: "Surface 1 implementation completed cleanly.",
        },
      },
    });
    context.store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 3_006,
      role: "assistant",
      content: "",
      payload: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "mcp:7f64f4df-aba5-40c6-a131-92f5e00451eb:3",
            name: "send_input",
            arguments: {
              thread_id: childId,
              description: "Confirm Surface 1 completion state",
              message: "Raw follow-up message must remain hidden.",
            },
          },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-code",
        usage: EMPTY_USAGE,
        stopReason: "toolUse",
        timestamp: 3_006,
        stellaAttemptGeneration: 1,
      } as never,
    });
    context.store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 3_007,
      role: "toolResult",
      toolCallId: "mcp:7f64f4df-aba5-40c6-a131-92f5e00451eb:3",
      content: JSON.stringify({
        thread_id: childId,
        status: "updated",
        delivered: true,
      }),
      payload: {
        role: "toolResult",
        toolCallId: "mcp:7f64f4df-aba5-40c6-a131-92f5e00451eb:3",
        toolName: "send_input",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              thread_id: childId,
              status: "updated",
              delivered: true,
            }),
          },
        ],
        isError: false,
        timestamp: 3_007,
      } as never,
    });
    const followUpCompletionId = `${childId}:3:agent-completed`;
    context.store.appendThreadCustomMessage({
      threadKey: threadId,
      timestamp: 3_008,
      customType: "runtime.task_lifecycle",
      content: "[Agent completed] raw follow-up routing reminder",
      display: false,
      eventId: followUpCompletionId,
      lifecycleEvent: {
        type: "agent-completed",
        payload: {
          agentId: childId,
          attemptGeneration: 3,
          result: "Surface 1 follow-up confirmed clean.",
        },
      },
    });

    const beforeReload = context.store.listThreadTranscript(threadId);
    expect(beforeReload?.entries).toMatchObject([
      {
        kind: "lifecycle",
        lifecycleEvent: {
          type: "agent-started",
          payload: {
            agentId: childId,
            description:
              "M5 Surface 1: rearchitect worker/server.ts into Effect services/Layers (Fable 5)",
          },
        },
      },
      {
        kind: "assistant",
        text: "Surface 1 is underway. I passed the implementation agent the scoped brief.",
      },
      {
        kind: "lifecycle",
        lifecycleEvent: {
          _id: firstCompletionId,
          type: "agent-completed",
          payload: { agentId: childId },
        },
      },
      {
        kind: "lifecycle",
        lifecycleEvent: {
          type: "agent-started",
          payload: {
            agentId: childId,
            description: "Confirm Surface 1 completion state",
            isFollowUp: true,
          },
        },
      },
      {
        kind: "lifecycle",
        lifecycleEvent: {
          _id: followUpCompletionId,
          type: "agent-completed",
          payload: { agentId: childId },
        },
      },
    ]);
    expect(JSON.stringify(beforeReload)).not.toMatch(
      /spawn_agent|send_input|running_in_background|Raw implementation brief|Raw follow-up|raw routing reminder|\[Tool call\]|\[Tool result\]/,
    );

    context.db.close();
    const reopenedDb = new DatabaseSync(
      getDesktopDatabasePath(context.rootPath),
      {
        timeout: 5000,
      },
    ) as unknown as SqliteDatabase;
    context.db = reopenedDb;
    context.store = new SessionStore(reopenedDb);
    const reloaded = context.store.listThreadTranscript(threadId);
    expect(reloaded).toEqual(beforeReload);
  });

  it("never projects finalized Manager replies into Activity", () => {
    const { store } = createTestContext();
    store.saveAgentRecord({
      threadId: "manager-activity",
      conversationId: "conv-1",
      agentType: "manager",
      description: "Coordinate private work",
      agentDepth: 1,
      status: "running",
      attemptGeneration: 2,
      startedAt: 1_000,
      completedAt: null,
      updatedAt: 1_100,
    });
    appendAssistant(store, {
      threadId: "manager-activity",
      timestamp: 1_001,
      text: "Internal child synthesis",
      stopReason: "stop",
      attemptGeneration: 2,
    });
    expect(
      store.listThreadActivity("conv-1")[0]?.assistantMessages,
    ).toBeUndefined();

    appendAssistant(store, {
      threadId: "manager-activity",
      timestamp: 1_002,
      text: "Another private Manager final response",
      stopReason: "stop",
      attemptGeneration: 2,
    });
    expect(
      store.listThreadActivity("conv-1")[0]?.assistantMessages,
    ).toBeUndefined();
  });

  it("scopes updates to the current attempt and excludes terminal answers", () => {
    const { store } = createTestContext();
    const threadId = "agent-reused";
    saveRunningAgent(store, { threadId, startedAt: 1_000 });
    appendAssistant(store, {
      threadId,
      timestamp: 1_100,
      text: "Old attempt preamble",
    });
    appendAssistant(store, {
      threadId,
      timestamp: 1_200,
      text: "Old final answer",
      stopReason: "stop",
    });

    saveRunningAgent(store, {
      threadId,
      startedAt: 2_000,
      attemptGeneration: 1,
    });
    appendAssistant(store, {
      threadId,
      timestamp: 2_001,
      text: "Current attempt preamble",
      attemptGeneration: 1,
    });
    // A superseded attempt can finish unwinding after the new start time. Its
    // durable attempt tag, not text or timestamp guessing, keeps it out.
    appendAssistant(store, {
      threadId,
      timestamp: 2_002,
      text: "Late write from old attempt",
      attemptGeneration: 0,
    });
    appendAssistant(store, {
      threadId,
      timestamp: 2_003,
      text: "Current final answer",
      stopReason: "stop",
      attemptGeneration: 1,
    });

    expect(store.listAgentAssistantMessages(threadId)).toEqual([
      { text: "Current attempt preamble", atMs: 2_001 },
    ]);
  });

  it("emits a bounded incremental mobile-compatible update only after persistence", () => {
    const onThreadAssistantUpdate = vi.fn();
    const { store } = createTestContext(onThreadAssistantUpdate);
    saveRunningAgent(store, {
      threadId: "agent-1",
      startedAt: 1_000,
      attemptGeneration: 4,
    });

    appendAssistant(store, {
      threadId: "agent-1",
      timestamp: 1_001,
      text: "I am checking the live route.",
      attemptGeneration: 4,
    });
    expect(onThreadAssistantUpdate).toHaveBeenCalledOnce();
    expect(onThreadAssistantUpdate).toHaveBeenLastCalledWith({
      conversationId: "conv-1",
      assistantUpdate: expect.objectContaining({
        threadId: "agent-1",
        assistantMessages: ["I am checking the live route."],
        reasoningSummaries: ["I am checking the live route."],
        latestMessage: "I am checking the live route.",
        atMs: 1_001,
        attemptGeneration: 4,
      }),
    });

    appendAssistant(store, {
      threadId: "agent-1",
      timestamp: 1_002,
      text: "The final answer",
      stopReason: "stop",
      attemptGeneration: 4,
    });
    expect(onThreadAssistantUpdate).toHaveBeenCalledOnce();
  });

  it("bounds active visible task queries per thread and overall", () => {
    const { store } = createTestContext();
    const oversized = "🧭".repeat(
      AGENT_ASSISTANT_UPDATE_LIMITS.messageChars * 2,
    );
    const totalAgents = AGENT_ASSISTANT_UPDATE_LIMITS.activeThreads + 3;
    for (let agentIndex = 0; agentIndex < totalAgents; agentIndex += 1) {
      const threadId = `agent-${agentIndex}`;
      saveRunningAgent(store, {
        threadId,
        startedAt: 1_000,
        updatedAt: 10_000 - agentIndex,
      });
      for (let messageIndex = 0; messageIndex < 5; messageIndex += 1) {
        appendAssistant(store, {
          threadId,
          timestamp: 1_100 + messageIndex,
          text: `${agentIndex}:${messageIndex}:${oversized}`,
        });
      }
    }
    saveRunningAgent(store, {
      threadId: "internal-agent",
      startedAt: 1_000,
      agentType: "recall",
      updatedAt: 20_000,
    });
    appendAssistant(store, {
      threadId: "internal-agent",
      timestamp: 1_100,
      text: "Internal update",
    });

    const projected = store
      .listThreadActivity("conv-1")
      .flatMap((record) => record.assistantMessages ?? []);
    const recordsWithUpdates = store
      .listThreadActivity("conv-1")
      .filter((record) => record.assistantMessages?.length);
    expect(recordsWithUpdates).toHaveLength(
      AGENT_ASSISTANT_UPDATE_LIMITS.activeThreads,
    );
    expect(
      recordsWithUpdates.every(
        (record) =>
          (record.assistantMessages?.length ?? 0) <=
          AGENT_ASSISTANT_UPDATE_LIMITS.messagesPerThread,
      ),
    ).toBe(true);
    expect(
      recordsWithUpdates.every(
        (record) =>
          (record.assistantMessages ?? []).reduce(
            (sum, message) => sum + [...message].length,
            0,
          ) <= AGENT_ASSISTANT_UPDATE_LIMITS.threadChars &&
          (record.assistantMessages ?? []).reduce(
            (sum, message) => sum + Buffer.byteLength(message, "utf8"),
            0,
          ) <= AGENT_ASSISTANT_UPDATE_LIMITS.threadBytes,
      ),
    ).toBe(true);
    expect(
      projected.every(
        (message) =>
          [...message].length <= AGENT_ASSISTANT_UPDATE_LIMITS.messageChars &&
          Buffer.byteLength(message, "utf8") <=
            AGENT_ASSISTANT_UPDATE_LIMITS.messageBytes,
      ),
    ).toBe(true);
    expect(
      projected.reduce((sum, message) => sum + [...message].length, 0),
    ).toBeLessThanOrEqual(AGENT_ASSISTANT_UPDATE_LIMITS.totalChars);
    expect(
      projected.reduce(
        (sum, message) => sum + Buffer.byteLength(message, "utf8"),
        0,
      ),
    ).toBeLessThanOrEqual(AGENT_ASSISTANT_UPDATE_LIMITS.totalBytes);
    expect(
      recordsWithUpdates.every((record) =>
        record.assistantMessages?.at(-1)?.includes(":4:"),
      ),
    ).toBe(true);
    expect(
      recordsWithUpdates.every(
        (record) => typeof record.assistantMessagesUpdatedAt === "number",
      ),
    ).toBe(true);
    expect(
      store
        .listThreadActivity("conv-1")
        .find((record) => record.threadId === "internal-agent")
        ?.assistantMessages,
    ).toBeUndefined();
  });
});
