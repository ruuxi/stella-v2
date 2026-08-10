import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "@stella/runtime/kernel/storage/database-init";
import { SessionStore } from "@stella/runtime/kernel/storage/session-store";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";

type TestContext = {
  rootPath: string;
  db: SqliteDatabase;
};

const activeContexts = new Set<TestContext>();

const createStore = (onThreadAssistantUpdate?: (payload: unknown) => void) => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-agent-messages-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
    timeout: 5000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  activeContexts.add({ rootPath, db });
  return new SessionStore(db, { onThreadAssistantUpdate });
};

afterEach(async () => {
  for (const context of activeContexts) {
    context.db.close();
    await rm(context.rootPath, { recursive: true, force: true });
  }
  activeContexts.clear();
});

const saveRunningAgent = (store: SessionStore, attemptGeneration = 0) => {
  store.saveAgentRecord({
    threadId: "agent-1",
    conversationId: "conv-1",
    agentType: "general",
    description: "Inspect the routes",
    agentDepth: 0,
    status: "running",
    attemptGeneration,
    startedAt: 1_000,
    completedAt: null,
    updatedAt: 1_000,
  });
};

const appendAssistant = (
  store: SessionStore,
  text: string,
  timestamp: number,
  attemptGeneration = 0,
) => {
  store.appendThreadMessage({
    threadKey: "agent-1",
    timestamp,
    role: "assistant",
    content: text,
    payload: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "codex",
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
      timestamp,
      stellaAttemptGeneration: attemptGeneration,
    } as never,
  });
};

describe("agent-authored assistant updates", () => {
  it("projects recent assistant prose verbatim and emits an incremental update", () => {
    const onUpdate = vi.fn();
    const store = createStore(onUpdate);
    saveRunningAgent(store);

    appendAssistant(store, "I checked the exact route.", 1_001);
    appendAssistant(store, "The focused tests now pass — 12/12.", 1_002);

    expect(store.listAgentAssistantMessages("agent-1")).toEqual([
      { text: "I checked the exact route.", atMs: 1_001 },
      { text: "The focused tests now pass — 12/12.", atMs: 1_002 },
    ]);
    expect(store.listThreadActivity("conv-1")[0]).toMatchObject({
      source: "stella",
      assistantMessages: [
        "I checked the exact route.",
        "The focused tests now pass — 12/12.",
      ],
    });
    expect(onUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        conversationId: "conv-1",
        assistantUpdate: expect.objectContaining({
          threadId: "agent-1",
          latestMessage: "The focused tests now pass — 12/12.",
        }),
      }),
    );
  });

  it("does not leak assistant text from a prior attempt generation", () => {
    const store = createStore();
    saveRunningAgent(store, 0);
    appendAssistant(store, "Old attempt", 1_001, 0);
    saveRunningAgent(store, 1);
    appendAssistant(store, "New attempt", 1_002, 1);

    expect(store.listAgentAssistantMessages("agent-1")).toEqual([
      { text: "New attempt", atMs: 1_002 },
    ]);
  });
});
