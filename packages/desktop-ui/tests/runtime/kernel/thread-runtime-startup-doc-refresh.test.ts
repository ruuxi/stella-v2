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

import {
  buildStartupPromptMessages,
  persistThreadCustomMessage,
} from "@stella/runtime/kernel/agent-runtime/thread-memory";
import type { ResolvedLlmRoute } from "@stella/runtime/kernel/model-routing";
import {
  buildStartupDocMessage,
  LIFE_MEMORY_MAP_DISPLAY_PATH,
  LIFE_USER_PROFILE_DISPLAY_PATH,
  planResidentStartupDocRefresh,
} from "@stella/runtime/kernel/memory/resident-docs";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "@stella/runtime/kernel/storage/database-init";
import { SessionStore } from "@stella/runtime/kernel/storage/session-store";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";
import {
  maybeCompactRuntimeThread,
  resetThreadSummaryFailureTracking,
} from "@stella/runtime/kernel/thread-runtime";
import {
  readMemoryMapDoc,
  readUserProfileDoc,
} from "@stella/runtime/kernel/runner/shared";

const RETIRED_SUMMARY_PATH = "~/.stella/memories/memory_summary.md";
const RETIRED_INDEX_PATH = "~/.stella/memories/memory_index.md";
const THREAD_KEY = "resident-refresh-thread";

const VALID_SUMMARY = [
  "## Topic",
  "Resident memory cache epoch and compaction refresh validation.",
  "## Key Points",
  "The full compacted conversation was reviewed and its durable decisions were retained.",
  "The pinned startup documents remain unique and preserve their insertion positions.",
  "## Current State",
  "The new cache epoch begins with refreshed resident bytes from durable storage.",
  "## Open Items",
  "None beyond the recent uncompacted tail that remains visible after this checkpoint.",
].join("\n");

const createRoute = (): ResolvedLlmRoute =>
  ({
    route: "stella",
    model: { id: "stella/max", contextWindow: 80_000 },
    getApiKey: async () => "auth-token",
  }) as unknown as ResolvedLlmRoute;

type TestContext = {
  rootPath: string;
  dbPath: string;
  db: SqliteDatabase;
  store: SessionStore;
};

let context: TestContext;

const writeResidentDocs = (profile: string, memoryMap: string): void => {
  const memoriesDir = path.join(context.rootPath, "memories");
  fs.mkdirSync(memoriesDir, { recursive: true });
  fs.writeFileSync(path.join(memoriesDir, "profile.md"), profile);
  fs.writeFileSync(path.join(memoriesDir, "memory_map.md"), memoryMap);
};

const buildContextFromStore = () => ({
  systemPrompt: "system",
  dynamicContext: "",
  maxAgentDepth: 1,
  threadHistory: context.store.loadThreadMessages(THREAD_KEY),
  userProfile: readUserProfileDoc(context.rootPath),
  memoryMap: readMemoryMapDoc(context.rootPath),
});

const persistStartupDocsFromPrompt = async (): Promise<number> => {
  const messages = await buildStartupPromptMessages({
    context: buildContextFromStore(),
    stellaDataDir: context.rootPath,
  });
  for (const message of messages) {
    persistThreadCustomMessage(context.store, {
      threadKey: THREAD_KEY,
      customType: message.customType!,
      content: [{ type: "text", text: message.text }],
      display: false,
    });
  }
  return messages.length;
};

const persistStartupDoc = (displayPath: string, body: string): void => {
  persistThreadCustomMessage(context.store, {
    threadKey: THREAD_KEY,
    customType: "bootstrap.startup_doc",
    content: [
      { type: "text", text: buildStartupDocMessage(displayPath, body) },
    ],
    display: false,
  });
};

const loadStartupDocs = () =>
  context.store
    .loadThreadMessages(THREAD_KEY)
    .filter(
      (message) =>
        message.customMessage?.customType === "bootstrap.startup_doc",
    )
    .map((message) => ({
      entryId: message.entryId,
      text:
        typeof message.customMessage!.content === "string"
          ? message.customMessage!.content
          : message
              .customMessage!.content.map((block) =>
                block.type === "text" ? block.text : "",
              )
              .join("\n"),
    }));

const appendLargeConversation = (): void => {
  for (let index = 0; index < 40; index += 1) {
    context.store.appendThreadMessage({
      timestamp: 10_000 + index,
      threadKey: THREAD_KEY,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index + 1} ${"x".repeat(10_000)}`,
    });
  }
};

describe("resident startup-doc cache epochs", () => {
  beforeEach(() => {
    completeSimpleMock.mockReset();
    resetThreadSummaryFailureTracking();
    const rootPath = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-resident-refresh-"),
    );
    const dbPath = getDesktopDatabasePath(rootPath);
    const db = new DatabaseSync(dbPath, {
      timeout: 5000,
    }) as unknown as SqliteDatabase;
    initializeDesktopDatabase(db);
    context = { rootPath, dbPath, db, store: new SessionStore(db) };
  });

  afterEach(() => {
    context.db.close();
    fs.rmSync(context.rootPath, { recursive: true, force: true });
  });

  it("freezes one copy mid-epoch, refreshes changed bytes at compaction, and reloads cleanly", async () => {
    writeResidentDocs(
      "# User Profile\n\n- The user goes by Bob",
      "# Memory map\n\n- routing snapshot v1",
    );
    expect(await persistStartupDocsFromPrompt()).toBe(2);
    const docsBefore = loadStartupDocs();

    expect(
      planResidentStartupDocRefresh({
        store: context.store,
        threadKey: THREAD_KEY,
        stellaDataDir: context.rootPath,
      }),
    ).toEqual({ refreshedDocs: 0, removedDocs: 0, mutations: [] });
    expect(loadStartupDocs()).toEqual(docsBefore);

    appendLargeConversation();
    writeResidentDocs(
      "# User Profile\n\n- The user goes by Robert",
      "# Memory map\n\n- routing snapshot v2",
    );
    expect(
      await buildStartupPromptMessages({
        context: buildContextFromStore(),
        stellaDataDir: context.rootPath,
      }),
    ).toEqual([]);
    expect(loadStartupDocs()).toEqual(docsBefore);

    completeSimpleMock.mockResolvedValue({
      content: [{ type: "text", text: VALID_SUMMARY }],
      stopReason: "stop",
    });
    const result = await maybeCompactRuntimeThread({
      store: context.store,
      threadKey: THREAD_KEY,
      resolvedLlm: createRoute(),
      agentType: "orchestrator",
      stellaDataDir: context.rootPath,
    });
    expect(result).toMatchObject({ compacted: true, summary: VALID_SUMMARY });

    const docsAfter = loadStartupDocs();
    expect(docsAfter.map((doc) => doc.entryId)).toEqual(
      docsBefore.map((doc) => doc.entryId),
    );
    expect(
      docsAfter.find((doc) => doc.text.includes(LIFE_USER_PROFILE_DISPLAY_PATH))
        ?.text,
    ).toContain("goes by Robert");
    expect(
      docsAfter.find((doc) => doc.text.includes(LIFE_MEMORY_MAP_DISPLAY_PATH))
        ?.text,
    ).toContain("routing snapshot v2");

    context.db.close();
    context.db = new DatabaseSync(context.dbPath, {
      timeout: 5000,
    }) as unknown as SqliteDatabase;
    initializeDesktopDatabase(context.db);
    context.store = new SessionStore(context.db);
    expect(loadStartupDocs()).toEqual(docsAfter);
    expect(
      await buildStartupPromptMessages({
        context: buildContextFromStore(),
        stellaDataDir: context.rootPath,
      }),
    ).toEqual([]);
  });

  it("converts retired pinned docs into one map copy only at the boundary", async () => {
    persistStartupDoc(
      RETIRED_SUMMARY_PATH,
      "# Memory summary\n\n- frozen focus",
    );
    persistStartupDoc(RETIRED_INDEX_PATH, "# Memory index\n\n- frozen route");
    fs.mkdirSync(path.join(context.rootPath, "memories"), { recursive: true });
    fs.writeFileSync(
      path.join(context.rootPath, "memories", "memory_map.md"),
      "# Memory map\n\n- canonical route",
    );
    const docsBefore = loadStartupDocs();
    expect(
      await buildStartupPromptMessages({
        context: buildContextFromStore(),
        stellaDataDir: context.rootPath,
      }),
    ).toEqual([]);

    appendLargeConversation();
    completeSimpleMock.mockResolvedValue({
      content: [{ type: "text", text: VALID_SUMMARY }],
      stopReason: "stop",
    });
    await maybeCompactRuntimeThread({
      store: context.store,
      threadKey: THREAD_KEY,
      resolvedLlm: createRoute(),
      agentType: "orchestrator",
      stellaDataDir: context.rootPath,
    });
    const docsAfter = loadStartupDocs();
    expect(docsAfter).toHaveLength(1);
    expect(docsAfter[0]?.entryId).toBe(docsBefore[0]?.entryId);
    expect(docsAfter[0]?.text).toBe(
      buildStartupDocMessage(
        LIFE_MEMORY_MAP_DISPLAY_PATH,
        "# Memory map\n\n- canonical route",
      ),
    );
    const danglingParentCount = context.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM runtime_thread_entries child
         LEFT JOIN runtime_thread_entries parent
           ON parent.entry_id = child.parent_entry_id
         WHERE child.thread_key = ?
           AND child.parent_entry_id IS NOT NULL
           AND parent.entry_id IS NULL`,
      )
      .get(THREAD_KEY) as { count: number };
    expect(danglingParentCount.count).toBe(0);
  });

  it("scrubs retired HTML comments without deleting ordinary history", async () => {
    fs.mkdirSync(path.join(context.rootPath, "memories"), { recursive: true });
    fs.writeFileSync(
      path.join(context.rootPath, "memories", "memory_map.md"),
      "# Memory map\n\n- live route\n<!-- retired route -->",
    );
    persistStartupDoc(
      LIFE_MEMORY_MAP_DISPLAY_PATH,
      "# Memory map\n\n- live route\n<!-- retired route -->",
    );
    context.store.appendThreadMessage({
      timestamp: 20_000,
      threadKey: THREAD_KEY,
      role: "user",
      content: "ordinary durable message",
    });
    const ordinaryEntry = context.store
      .loadThreadMessages(THREAD_KEY)
      .find((message) => message.role === "user")?.entryId;

    appendLargeConversation();
    completeSimpleMock.mockResolvedValue({
      content: [{ type: "text", text: VALID_SUMMARY }],
      stopReason: "stop",
    });
    await maybeCompactRuntimeThread({
      store: context.store,
      threadKey: THREAD_KEY,
      resolvedLlm: createRoute(),
      agentType: "orchestrator",
      stellaDataDir: context.rootPath,
    });
    expect(loadStartupDocs()[0]?.text).not.toContain("retired route");
    const ordinaryRow = context.db
      .prepare(
        `SELECT entry_type AS entryType
         FROM runtime_thread_entries
         WHERE entry_id = ?`,
      )
      .get(ordinaryEntry!) as { entryType?: string } | undefined;
    expect(ordinaryRow?.entryType).toBe("message");
  });

  it("rolls back the overlay and every resident mutation when the second update fails, then retries after restart", async () => {
    writeResidentDocs(
      "# User Profile\n\n- profile epoch one",
      "# Memory map\n\n- map epoch one",
    );
    expect(await persistStartupDocsFromPrompt()).toBe(2);
    const docsBefore = loadStartupDocs();
    appendLargeConversation();
    writeResidentDocs(
      "# User Profile\n\n- profile epoch two",
      "# Memory map\n\n- map epoch two",
    );
    const mapEntryId = docsBefore.find((doc) =>
      doc.text.includes(LIFE_MEMORY_MAP_DISPLAY_PATH),
    )?.entryId;
    expect(mapEntryId).toBeTruthy();
    const quotedMapEntryId = mapEntryId!.replaceAll("'", "''");
    context.db.exec(`
      CREATE TRIGGER fail_second_resident_update
      BEFORE UPDATE ON runtime_thread_entries
      WHEN OLD.entry_id = '${quotedMapEntryId}'
      BEGIN
        SELECT RAISE(ABORT, 'forced second resident mutation failure');
      END;
    `);
    completeSimpleMock.mockResolvedValue({
      content: [{ type: "text", text: VALID_SUMMARY }],
      stopReason: "stop",
    });

    await expect(
      maybeCompactRuntimeThread({
        store: context.store,
        threadKey: THREAD_KEY,
        resolvedLlm: createRoute(),
        agentType: "orchestrator",
        stellaDataDir: context.rootPath,
      }),
    ).rejects.toThrow("forced second resident mutation failure");
    expect(loadStartupDocs()).toEqual(docsBefore);
    const failedOverlayCount = context.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM runtime_thread_entries
         WHERE thread_key = ? AND entry_type = 'compaction'`,
      )
      .get(THREAD_KEY) as { count: number };
    expect(failedOverlayCount.count).toBe(0);

    context.db.close();
    context.db = new DatabaseSync(context.dbPath, {
      timeout: 5000,
    }) as unknown as SqliteDatabase;
    initializeDesktopDatabase(context.db);
    context.store = new SessionStore(context.db);
    expect(loadStartupDocs()).toEqual(docsBefore);
    context.db.exec("DROP TRIGGER fail_second_resident_update");

    completeSimpleMock.mockResolvedValue({
      content: [{ type: "text", text: VALID_SUMMARY }],
      stopReason: "stop",
    });
    await expect(
      maybeCompactRuntimeThread({
        store: context.store,
        threadKey: THREAD_KEY,
        resolvedLlm: createRoute(),
        agentType: "orchestrator",
        stellaDataDir: context.rootPath,
      }),
    ).resolves.toMatchObject({ compacted: true });
    const docsAfterRetry = loadStartupDocs();
    expect(docsAfterRetry).toHaveLength(2);
    expect(docsAfterRetry.map((doc) => doc.entryId)).toEqual(
      docsBefore.map((doc) => doc.entryId),
    );
    expect(docsAfterRetry.map((doc) => doc.text).join("\n")).toContain(
      "profile epoch two",
    );
    expect(docsAfterRetry.map((doc) => doc.text).join("\n")).toContain(
      "map epoch two",
    );
  });
});
