import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const completeSimpleMock = vi.fn();

vi.mock("@stella/runtime/ai/stream", () => ({
  completeSimple: (...args: unknown[]) => completeSimpleMock(...args),
  readAssistantText: (message: {
    content: Array<{ type: string; text?: string }>;
  }): string =>
    message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("")
      .trim(),
}));

import { runCompactionWithHooks } from "@stella/runtime/kernel/agent-runtime/run-completion";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "@stella/runtime/kernel/storage/database-init";
import { SessionStore } from "@stella/runtime/kernel/storage/session-store";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";
import type { Model } from "@stella/runtime/ai/types";

const roots = new Set<string>();
const databases = new Set<SqliteDatabase>();

afterEach(() => {
  for (const db of databases) {
    try {
      db.close();
    } catch {
      // Already closed for the reload assertion.
    }
  }
  databases.clear();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

const validSummary = (detail: string): string =>
  [
    "## Topic",
    "Compaction durability metadata.",
    "",
    "## Key Points",
    `${detail} The raw thread remains durable behind the checkpoint overlay.`,
    "",
    "## Current State",
    "The accepted summary and its provenance are ready for reload.",
    "",
    "## Open Items",
    "Complete independent review of the persisted metadata.",
  ].join("\n");

const model: Model<"openai-completions"> = {
  id: "summary-test",
  name: "Summary Test",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://summary.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 80_000,
  maxTokens: 4_096,
};

const createStore = () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "stella-compaction-real-"),
  );
  roots.add(root);
  const db = new DatabaseSync(getDesktopDatabasePath(root), {
    timeout: 5_000,
  }) as unknown as SqliteDatabase;
  databases.add(db);
  initializeDesktopDatabase(db);
  const store = new SessionStore(db);
  const conversationId = `conversation-${Math.random().toString(36).slice(2)}`;
  const { threadId } = store.resolveOrCreateActiveThread({
    conversationId,
    agentType: "orchestrator",
  });
  for (let index = 0; index < 60; index += 1) {
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 1_000 + index,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index + 1} ${"x".repeat(10_000)}`,
    });
  }
  return { root, db, store, conversationId, threadId };
};

const reloadCompaction = (args: {
  root: string;
  db: SqliteDatabase;
  threadId: string;
}) => {
  args.db.close();
  databases.delete(args.db);
  const reloadedDb = new DatabaseSync(getDesktopDatabasePath(args.root), {
    timeout: 5_000,
  }) as unknown as SqliteDatabase;
  databases.add(reloadedDb);
  initializeDesktopDatabase(reloadedDb);
  const reloadedStore = new SessionStore(reloadedDb);
  const row = reloadedDb
    .prepare(
      `SELECT data_json AS dataJson
       FROM runtime_thread_entries
       WHERE thread_key = ? AND entry_type = 'compaction'
       ORDER BY insertion_sequence DESC
       LIMIT 1`,
    )
    .get(args.threadId) as { dataJson: string };
  return {
    data: JSON.parse(row.dataJson) as Record<string, unknown>,
    messages: reloadedStore.loadThreadMessages(args.threadId),
  };
};

describe("real-store compaction provenance", () => {
  beforeEach(() => {
    completeSimpleMock.mockReset();
  });

  it("reloads an accepted override with fromHook true and matching emitted metadata", async () => {
    const context = createStore();
    const overrideSummary = validSummary("The hook supplied this checkpoint.");
    const emitted: Array<Record<string, unknown>> = [];
    const hookEmitter = {
      emit: vi.fn(async (event: string, payload: Record<string, unknown>) => {
        if (event === "before_compact") {
          return { compaction: { summary: overrideSummary } };
        }
        if (event === "session_compact") emitted.push(payload);
        return undefined;
      }),
    };

    const result = await runCompactionWithHooks({
      opts: {
        agentType: "orchestrator",
        conversationId: context.conversationId,
        resolvedLlm: {
          model,
          route: "direct-provider",
          getApiKey: () => "auth-token",
        },
        store: context.store,
        hookEmitter: hookEmitter as never,
      },
      threadKey: context.threadId,
      runId: "accepted-run",
      messageCount: 60,
    });
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    expect(result).toEqual({
      compacted: true,
      summary: overrideSummary,
      fromOverride: true,
    });
    expect(completeSimpleMock).not.toHaveBeenCalled();
    expect(emitted[0]).toMatchObject({
      summary: overrideSummary,
      fromHook: true,
    });
    const reloaded = reloadCompaction(context);
    expect(reloaded.data.fromHook).toBe(true);
    expect(reloaded.messages[0]?.content).toContain(overrideSummary);
  });

  it("reloads a generated replacement without hook provenance and emits that replacement", async () => {
    const context = createStore();
    const generatedSummary = validSummary(
      "The provider replaced a rejected hook checkpoint.",
    );
    completeSimpleMock.mockResolvedValue({
      content: [{ type: "text", text: generatedSummary }],
      stopReason: "stop",
    });
    const emitted: Array<Record<string, unknown>> = [];
    const hookEmitter = {
      emit: vi.fn(async (event: string, payload: Record<string, unknown>) => {
        if (event === "before_compact") {
          return {
            compaction: { summary: "## Topic\nRejected hook fragment" },
          };
        }
        if (event === "session_compact") emitted.push(payload);
        return undefined;
      }),
    };

    const result = await runCompactionWithHooks({
      opts: {
        agentType: "orchestrator",
        conversationId: context.conversationId,
        resolvedLlm: {
          model,
          route: "direct-provider",
          getApiKey: () => "auth-token",
        },
        store: context.store,
        hookEmitter: hookEmitter as never,
      },
      threadKey: context.threadId,
      runId: "replacement-run",
      messageCount: 60,
    });
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    expect(result).toEqual({
      compacted: true,
      summary: generatedSummary,
      fromOverride: false,
    });
    expect(emitted[0]).toMatchObject({
      summary: generatedSummary,
      fromHook: false,
    });
    const reloaded = reloadCompaction(context);
    expect(reloaded.data.fromHook).toBeUndefined();
    expect(reloaded.data.summary).toBe(generatedSummary);
    expect(reloaded.messages[0]?.content).toContain(generatedSummary);
  });
});
