import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types";
import { BackgroundCompactionScheduler } from "@stella/runtime/kernel/agent-runtime/compaction-scheduler";
import {
  runExternalOrchestratorTurn,
  runExternalSubagentTurn,
} from "@stella/runtime/kernel/agent-runtime/external-engines";
import type {
  OrchestratorRunOptions,
  RuntimeAssistantMessageEvent,
  RuntimeExecutionSessionHandle,
  SubagentRunOptions,
} from "@stella/runtime/kernel/agent-runtime/types";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "@stella/runtime/kernel/storage/database-init";
import { SessionStore } from "@stella/runtime/kernel/storage/session-store";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";
import {
  getPersistedAssistantSlots,
  mergeConversationDisplayMessageSources,
} from "@/features/chat/hooks/use-conversation-display-messages";

const { runClaudeCodeTurnMock } = vi.hoisted(() => ({
  runClaudeCodeTurnMock: vi.fn(),
}));

vi.mock(
  "../../../../../runtime/kernel/integrations/claude-code-session-runtime.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../../runtime/kernel/integrations/claude-code-session-runtime.js")
      >();
    return {
      ...actual,
      runClaudeCodeTurn: runClaudeCodeTurnMock,
      shutdownClaudeCodeRuntime: vi.fn(),
    };
  },
);

const FIRST_REPLY =
  "Mockups are in the canvas. My take: Option A — the fill grid plus one muted tally line.";
const MANAGER_UPDATE =
  "[Milestone] Design phase complete — three independent proposals are ready for the memory-system review.";
const SECOND_REPLY =
  "Design phase is in, and the striking part is that all three proposals converge on the same core shape.";

const model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.test",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 128_000,
  maxTokens: 4_096,
} as const;

describe("external-engine queued root replies", () => {
  beforeEach(() => {
    runClaudeCodeTurnMock.mockReset();
  });

  it("persists and displays the user reply before a concurrent manager-update reply after reload", async () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-external-queued-replies-"),
    );
    const dbPath = getDesktopDatabasePath(dataDir);
    let db = new DatabaseSync(dbPath, {
      timeout: 5_000,
    }) as unknown as SqliteDatabase;
    initializeDesktopDatabase(db);
    let store = new SessionStore(db);
    const conversationId = "conversation-concurrent-root";
    const userMessageId = "user-screenshot-turn";
    const runId = "run-concurrent-root";
    const scheduler = new BackgroundCompactionScheduler();
    let liveSession: RuntimeExecutionSessionHandle | undefined;
    const assistantEvents: RuntimeAssistantMessageEvent[] = [];
    let releaseFirstTurn: (() => void) | undefined;
    const firstTurnMayFinish = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });
    let markFirstTurnStarted: (() => void) | undefined;
    const firstTurnStarted = new Promise<void>((resolve) => {
      markFirstTurnStarted = resolve;
    });

    try {
      store.appendEvent({
        conversationId,
        eventId: userMessageId,
        timestamp: 10_000,
        type: "user_message",
        payload: {
          text: "Here is a screenshot of the Activity tray. Suggest a better manager row and make the HTML mockup.",
        },
      });

      runClaudeCodeTurnMock
        .mockImplementationOnce(
          async (request: { onStream?: (chunk: string) => void }) => {
            request.onStream?.("Mockups are in the canvas. ");
            markFirstTurnStarted?.();
            await firstTurnMayFinish;
            request.onStream?.("My take: Option A.");
            return {
              text: FIRST_REPLY,
              sessionId: "claude-session-root",
              fileChanges: [],
            };
          },
        )
        .mockImplementationOnce(
          async (request: {
            prompt: string;
            onStream?: (chunk: string) => void;
          }) => {
            expect(request.prompt).toContain(MANAGER_UPDATE);
            request.onStream?.(SECOND_REPLY);
            return {
              text: SECOND_REPLY,
              sessionId: "claude-session-root",
              fileChanges: [],
            };
          },
        );

      const appendAssistantMessage = (event: RuntimeAssistantMessageEvent) => {
        assistantEvents.push(event);
        store.appendEvent({
          conversationId,
          eventId: `assistant-msg-${event.runId}-${event.seq}`,
          // Deliberately use the same millisecond for both rows: durable
          // sequence/id ordering must remain deterministic under the live race.
          timestamp: 20_000,
          type: "assistant_message",
          requestId: event.userMessageId,
          payload: {
            text: event.text,
            userMessageId: event.userMessageId,
          },
        });
      };
      const opts: OrchestratorRunOptions = {
        runId,
        conversationId,
        userMessageId,
        agentType: "orchestrator",
        userPrompt:
          "Here is a screenshot of the Activity tray. Suggest a better manager row and make the HTML mockup.",
        agentContext: {
          systemPrompt: "You are Stella's orchestrator.",
          dynamicContext: "",
          maxAgentDepth: 1,
          reasoningEffort: "high",
          agentEngine: "claude_code_local",
          threadHistory: [],
        },
        toolCatalog: [],
        toolExecutor: vi.fn(async () => ({ result: "ok" })),
        deviceId: "device-test",
        stellaDataDir: dataDir,
        stellaAppDir: dataDir,
        resolvedLlm: {
          model,
          route: "direct-provider",
          getApiKey: () => undefined,
        },
        store,
        callbacks: {
          onAssistantMessage: appendAssistantMessage,
          onStream: vi.fn(),
          onToolStart: vi.fn(),
          onToolEnd: vi.fn(),
          onError: vi.fn(),
          onEnd: vi.fn(),
        },
        compactionScheduler: scheduler,
        onExecutionSessionCreated: (session) => {
          liveSession = session;
        },
      };

      const run = runExternalOrchestratorTurn(opts);
      await firstTurnStarted;
      expect(liveSession?.agent.state.isStreaming).toBe(true);

      // Match production ordering: the report is durable on the root thread
      // before the runner delivers the hidden follow-up into the active turn.
      store.appendThreadCustomMessage({
        threadKey: conversationId,
        timestamp: 15_000,
        customType: "runtime.task_update",
        content: [{ type: "text", text: MANAGER_UPDATE }],
        display: false,
        eventId: "manager-thread:9:report:1",
      });
      const managerMessage: AgentMessage = {
        role: "runtimeInternal",
        content: [{ type: "text", text: MANAGER_UPDATE }],
        timestamp: 15_000,
        customType: "runtime.task_update",
        display: false,
      };
      liveSession!.agent.followUp(managerMessage);
      releaseFirstTurn?.();

      await run;
      await scheduler.drain();

      expect(runClaudeCodeTurnMock).toHaveBeenCalledTimes(2);
      expect(liveSession?.agent.state.isStreaming).toBe(false);
      expect(assistantEvents.map((event) => event.text)).toEqual([
        FIRST_REPLY,
        SECOND_REPLY,
      ]);
      expect(new Set(assistantEvents.map((event) => event.seq)).size).toBe(2);

      const durableBeforeReload = store
        .loadRawThreadMessagesWithEntryTypes(conversationId)
        .filter((message) => message.role === "assistant");
      expect(durableBeforeReload.map((message) => message.content)).toEqual([
        FIRST_REPLY,
        SECOND_REPLY,
      ]);
      expect(
        new Set(durableBeforeReload.map((message) => message.entryId)).size,
      ).toBe(2);
      const deliveredCursorBeforeReload =
        store.getThreadExternalDeliveredEntryId(conversationId);
      expect(deliveredCursorBeforeReload).toMatch(/^claude_code_local:/);

      (db as unknown as { close: () => void }).close();
      db = new DatabaseSync(dbPath, {
        timeout: 5_000,
      }) as unknown as SqliteDatabase;
      initializeDesktopDatabase(db);
      store = new SessionStore(db);
      expect(store.getThreadExternalDeliveredEntryId(conversationId)).toBe(
        deliveredCursorBeforeReload,
      );

      const persistedMessages = store.listMessages(conversationId).messages;
      const visibleAfterReload = mergeConversationDisplayMessageSources({
        persistedMessages,
        overlayMessages: [],
        streamingAssistants: [],
        persistedAssistantSlots: getPersistedAssistantSlots(persistedMessages),
      }).filter((message) => message.type === "assistant_message");

      expect(
        visibleAfterReload.map((message) => message.payload?.text),
      ).toEqual([FIRST_REPLY, SECOND_REPLY]);
      expect(
        new Set(visibleAfterReload.map((message) => message._id)).size,
      ).toBe(2);
    } finally {
      await scheduler.drain();
      try {
        (db as unknown as { close: () => void }).close();
      } catch {
        // The test may have closed the first handle immediately before a
        // reopen failure. Cleanup still removes the isolated data directory.
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("fences a stale external completion across SQLite reload and persists only the latest attempt", async () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-external-attempt-fence-"),
    );
    const dbPath = getDesktopDatabasePath(dataDir);
    let db = new DatabaseSync(dbPath, {
      timeout: 5_000,
    }) as unknown as SqliteDatabase;
    initializeDesktopDatabase(db);
    let store = new SessionStore(db);
    const scheduler = new BackgroundCompactionScheduler();
    const threadId = "manager-attempt-fence";
    const conversationId = "conversation-attempt-fence";
    const assistantEvents: RuntimeAssistantMessageEvent[] = [];
    const onEnd = vi.fn();
    let releaseStale!: () => void;
    const staleMayFinish = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    let staleStarted!: () => void;
    const staleDidStart = new Promise<void>((resolve) => {
      staleStarted = resolve;
    });

    const saveAttempt = (attemptGeneration: number) => {
      store.saveAgentRecord({
        threadId,
        conversationId,
        agentType: "manager",
        description: "Fence stale external completion",
        agentDepth: 1,
        status: "running",
        attemptGeneration,
        startedAt: attemptGeneration * 1_000,
        completedAt: null,
        updatedAt: attemptGeneration * 1_000,
      });
    };
    const makeOpts = (attemptGeneration: number): SubagentRunOptions => ({
      runId: `run-attempt-${attemptGeneration}`,
      rootRunId: `root-attempt-${attemptGeneration}`,
      agentId: threadId,
      conversationId,
      userMessageId: `user-attempt-${attemptGeneration}`,
      agentType: "manager",
      userPrompt: `Complete attempt ${attemptGeneration}.`,
      agentContext: {
        systemPrompt: "You are a Manager.",
        dynamicContext: "",
        maxAgentDepth: 2,
        agentDepth: 1,
        agentEngine: "claude_code_local",
        activeThreadId: threadId,
        attemptGeneration,
        threadHistory: [],
      },
      toolCatalog: [],
      toolExecutor: vi.fn(async () => ({ result: "ok" })),
      deviceId: "device-attempt-fence",
      stellaDataDir: dataDir,
      stellaAppDir: dataDir,
      resolvedLlm: {
        model,
        route: "direct-provider",
        getApiKey: () => undefined,
      },
      store,
      callbacks: {
        onAssistantMessage: (event) => assistantEvents.push(event),
        onEnd,
      },
      compactionScheduler: scheduler,
    });

    try {
      saveAttempt(1);
      runClaudeCodeTurnMock
        .mockImplementationOnce(async () => {
          staleStarted();
          await staleMayFinish;
          return {
            text: "STALE-ATTEMPT-RESULT",
            sessionId: "claude-stale-attempt",
            fileChanges: [],
          };
        })
        .mockResolvedValueOnce({
          text: "LATEST-ATTEMPT-RESULT",
          sessionId: "claude-latest-attempt",
          fileChanges: [],
        });

      const staleRun = runExternalSubagentTurn(makeOpts(1));
      await staleDidStart;
      saveAttempt(2);
      releaseStale();
      expect(await staleRun).toMatchObject({ interrupted: true, result: "" });
      expect(assistantEvents).toHaveLength(0);
      expect(onEnd).not.toHaveBeenCalled();
      expect(store.getThreadExternalSessionId(threadId)).toBeUndefined();

      (db as unknown as { close: () => void }).close();
      db = new DatabaseSync(dbPath, {
        timeout: 5_000,
      }) as unknown as SqliteDatabase;
      initializeDesktopDatabase(db);
      store = new SessionStore(db);

      expect(await runExternalSubagentTurn(makeOpts(2))).toMatchObject({
        result: "LATEST-ATTEMPT-RESULT",
      });
      await scheduler.drain();

      const durableAssistantRows = store
        .loadRawThreadMessagesWithEntryTypes(threadId)
        .filter((message) => message.role === "assistant");
      expect(durableAssistantRows.map((message) => message.content)).toEqual([
        "LATEST-ATTEMPT-RESULT",
      ]);
      expect(durableAssistantRows[0]?.payload).toMatchObject({
        stellaRunId: "run-attempt-2",
        stellaAttemptGeneration: 2,
      });
      expect(store.getThreadExternalSessionId(threadId)).toBe(
        "claude_code_local:claude-latest-attempt",
      );
      expect(assistantEvents.map((event) => event.text)).toEqual([
        "LATEST-ATTEMPT-RESULT",
      ]);
      expect(onEnd).toHaveBeenCalledTimes(1);
    } finally {
      await scheduler.drain();
      try {
        (db as unknown as { close: () => void }).close();
      } catch {
        // Already closed before a failed reopen.
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("delivers only new durable child-report deltas to a resumed Manager across reload", async () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-external-manager-delta-"),
    );
    const dbPath = getDesktopDatabasePath(dataDir);
    let db = new DatabaseSync(dbPath, {
      timeout: 5_000,
    }) as unknown as SqliteDatabase;
    initializeDesktopDatabase(db);
    let store = new SessionStore(db);
    const scheduler = new BackgroundCompactionScheduler();
    const threadId = "manager-delta-reload";
    const conversationId = "conversation-manager-delta-reload";

    const saveAttempt = (attemptGeneration: number) => {
      store.saveAgentRecord({
        threadId,
        conversationId,
        agentType: "manager",
        description: "Coordinate durable child reports",
        agentDepth: 1,
        status: "running",
        attemptGeneration,
        startedAt: attemptGeneration * 1_000,
        completedAt: null,
        updatedAt: attemptGeneration * 1_000,
      });
    };
    const appendReport = (at: number, marker: string) => {
      store.appendThreadCustomMessage({
        threadKey: threadId,
        timestamp: at,
        customType: "runtime.task_lifecycle",
        content: [{ type: "text", text: `[Agent report] ${marker}` }],
        display: false,
        eventId: `${threadId}:${at}:agent-completed`,
      });
      return store.loadRawThreadMessagesWithEntryTypes(threadId).at(-1)!
        .entryId;
    };
    const makeOpts = (attemptGeneration: number): SubagentRunOptions => ({
      runId: `run-manager-delta-${attemptGeneration}`,
      rootRunId: `root-manager-delta-${attemptGeneration}`,
      agentId: threadId,
      conversationId,
      userMessageId: `wake-manager-${attemptGeneration}`,
      agentType: "manager",
      userPrompt:
        "Review the newly persisted managed-child event in this thread and continue the instructed process.",
      promptMessages: [
        {
          text: "Review the newly persisted managed-child event in this thread and continue the instructed process.",
          messageType: "message",
          uiVisibility: "hidden",
          customType: "runtime.task_lifecycle_wake",
        },
      ],
      agentContext: {
        systemPrompt: "You are a Manager.",
        dynamicContext: "",
        maxAgentDepth: 2,
        agentDepth: 1,
        agentEngine: "claude_code_local",
        activeThreadId: threadId,
        attemptGeneration,
        threadHistory: [],
      },
      toolCatalog: [],
      toolExecutor: vi.fn(async () => ({ result: "ok" })),
      deviceId: "device-manager-delta",
      stellaDataDir: dataDir,
      stellaAppDir: dataDir,
      resolvedLlm: {
        model,
        route: "direct-provider",
        getApiKey: () => undefined,
      },
      store,
      compactionScheduler: scheduler,
    });

    try {
      saveAttempt(1);
      store.setThreadExternalSessionId(
        threadId,
        "claude_code_local:manager-delta-session",
      );
      const firstEntryId = appendReport(1_100, "CHILD-ONE-COMPLETE");
      runClaudeCodeTurnMock
        .mockImplementationOnce(async (request: { prompt: string }) => {
          expect(request.prompt).toContain("CHILD-ONE-COMPLETE");
          return {
            text: "FIRST-MANAGER-RESPONSE",
            sessionId: "manager-delta-session",
            fileChanges: [],
          };
        })
        .mockImplementationOnce(async (request: { prompt: string }) => {
          expect(request.prompt).toContain("CHILD-TWO-COMPLETE");
          expect(request.prompt).not.toContain("CHILD-ONE-COMPLETE");
          return {
            text: "SECOND-MANAGER-RESPONSE",
            sessionId: "manager-delta-session",
            fileChanges: [],
          };
        });

      expect(await runExternalSubagentTurn(makeOpts(1))).toMatchObject({
        result: "FIRST-MANAGER-RESPONSE",
      });
      await scheduler.drain();
      expect(store.getThreadExternalDeliveredEntryId(threadId)).toBe(
        `claude_code_local:${firstEntryId}`,
      );

      (db as unknown as { close: () => void }).close();
      db = new DatabaseSync(dbPath, {
        timeout: 5_000,
      }) as unknown as SqliteDatabase;
      initializeDesktopDatabase(db);
      store = new SessionStore(db);

      saveAttempt(2);
      const secondEntryId = appendReport(2_100, "CHILD-TWO-COMPLETE");
      expect(await runExternalSubagentTurn(makeOpts(2))).toMatchObject({
        result: "SECOND-MANAGER-RESPONSE",
      });
      await scheduler.drain();
      expect(store.getThreadExternalDeliveredEntryId(threadId)).toBe(
        `claude_code_local:${secondEntryId}`,
      );
      expect(
        store
          .loadRawThreadMessagesWithEntryTypes(threadId)
          .filter((message) => message.role === "assistant")
          .map((message) => message.content),
      ).toEqual(["FIRST-MANAGER-RESPONSE", "SECOND-MANAGER-RESPONSE"]);
      expect(runClaudeCodeTurnMock).toHaveBeenCalledTimes(2);
    } finally {
      await scheduler.drain();
      try {
        (db as unknown as { close: () => void }).close();
      } catch {
        // Already closed before a failed reopen.
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
