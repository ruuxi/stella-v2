/**
 * Reply references on a real SQLite database: the `entry_ref` index is
 * written with the entry, citations resolve against the conversation, reply
 * counts aggregate per target, and the lineage query returns exactly the
 * rows a focus view needs — including the lifecycle events that make the
 * spawn and completion cards render.
 */
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "@stella/runtime/kernel/storage/database-init";
import { SCHEMA_VERSION } from "@stella/runtime/kernel/storage/schema";
import { SessionStore } from "../../../../../runtime/kernel/storage/session-store.js";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";

type TestContext = {
  rootPath: string;
  db: SqliteDatabase;
  store: SessionStore;
};

const activeContexts = new Set<TestContext>();
const CONVERSATION = `${"0".repeat(25)}A`;

const createContext = (): TestContext => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-reply-refs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
    timeout: 5_000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const context = { rootPath, db, store: new SessionStore(db) };
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

const seedAgent = (
  store: SessionStore,
  threadId: string,
  description: string,
) =>
  store.saveAgentRecord({
    threadId,
    conversationId: CONVERSATION,
    agentType: "general",
    description,
    agentDepth: 0,
    status: "completed",
    attemptGeneration: 1,
    startedAt: 1_000,
    completedAt: 5_000,
    result: "Full report: **three** vendors publish rates; two need a call.",
    updatedAt: 5_000,
  });

const countRefs = (db: SqliteDatabase) =>
  (
    db.prepare("SELECT COUNT(*) AS count FROM entry_ref").get() as {
      count: number;
    }
  ).count;

describe("reply reference storage", () => {
  it("bumps the schema and creates the entry_ref index", () => {
    const { db } = createContext();
    expect(SCHEMA_VERSION).toBe(2);
    const version = db.prepare("PRAGMA user_version;").get() as {
      user_version: number;
    };
    expect(version.user_version).toBe(2);
    expect(countRefs(db)).toBe(0);
  });

  it("migrates an existing v1 database forward without losing rows", async () => {
    const rootPath = path.join(
      os.tmpdir(),
      `stella-reply-refs-v1-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
      timeout: 5_000,
    }) as unknown as SqliteDatabase;
    initializeDesktopDatabase(db);
    const store = new SessionStore(db);
    store.appendEvent({
      conversationId: CONVERSATION,
      type: "user_message",
      payload: { text: "kept" },
    });
    // Pretend this database predates the index: drop it and pin v1, then
    // reopen — the v2 migration must recreate it without touching rows.
    db.exec("DROP TABLE entry_ref;");
    db.exec("PRAGMA user_version = 1;");
    initializeDesktopDatabase(db);
    const version = db.prepare("PRAGMA user_version;").get() as {
      user_version: number;
    };
    expect(version.user_version).toBe(2);
    expect(countRefs(db)).toBe(0);
    expect(store.listMessages(CONVERSATION).messages).toHaveLength(1);
    db.close();
    await rm(rootPath, { recursive: true, force: true });
  });

  it("resolves citations against the conversation and drops unknown targets", () => {
    const { store } = createContext();
    seedAgent(store, "pricing-research", "Pricing research");
    const user = store.appendEvent({
      conversationId: CONVERSATION,
      type: "user_message",
      payload: { text: "Compare **vendor** pricing for me" },
    });
    const hidden = store.appendEvent({
      conversationId: CONVERSATION,
      type: "user_message",
      payload: { text: "hidden", metadata: { ui: { visibility: "hidden" } } },
    });
    expect(typeof user.sequence).toBe("number");
    const resolved = store.resolveReplyRefs(CONVERSATION, [
      { kind: "message", sequence: user.sequence! },
      { kind: "message", sequence: hidden.sequence! },
      { kind: "message", sequence: 9_999 },
      { kind: "agent", threadId: "pricing-research" },
      { kind: "agent", threadId: "not-a-thread" },
    ]);
    expect(resolved).toEqual([
      {
        kind: "message",
        sequence: user.sequence,
        id: user._id,
        role: "user",
        preview: "Compare vendor pricing for me",
      },
      {
        kind: "agent",
        threadId: "pricing-research",
        title: "Pricing research",
      },
    ]);
  });

  it("drops the message directly above and falls back to the lifecycle agent", () => {
    const { store } = createContext();
    seedAgent(store, "task-1", "Summarize the report");
    const user = store.appendEvent({
      conversationId: CONVERSATION,
      type: "user_message",
      payload: { text: "Summarize it" },
    });
    expect(
      store.resolveReplyRefs(
        CONVERSATION,
        [{ kind: "message", sequence: user.sequence! }],
        { excludeMessageId: user._id },
      ),
    ).toEqual([]);
    expect(
      store.resolveReplyRefs(CONVERSATION, [], { fallbackAgentId: "task-1" }),
    ).toEqual([
      { kind: "agent", threadId: "task-1", title: "Summarize the report" },
    ]);
  });

  it("indexes refs with the entry, rewrites them on update, and counts replies", () => {
    const { store, db } = createContext();
    seedAgent(store, "task-1", "Summarize the report");
    const user = store.appendEvent({
      conversationId: CONVERSATION,
      type: "user_message",
      payload: { text: "Summarize it" },
    });
    const refs = store.resolveReplyRefs(CONVERSATION, [
      { kind: "message", sequence: user.sequence! },
      { kind: "agent", threadId: "task-1" },
    ]);
    const reply = store.appendEvent({
      conversationId: CONVERSATION,
      eventId: "assistant-1",
      type: "assistant_message",
      payload: {
        text: "Done.",
        userMessageId: user._id,
        metadata: { runtime: { replyRefs: refs } },
      },
    });
    expect(countRefs(db)).toBe(2);
    expect(store.listReplyCounts(CONVERSATION)).toEqual({
      messages: { [user._id]: 1 },
      agents: { "task-1": 1 },
    });
    // A rewritten row (same id) replaces its refs instead of accumulating.
    store.appendEvent({
      conversationId: CONVERSATION,
      eventId: reply._id,
      type: "assistant_message",
      payload: {
        text: "Done.",
        userMessageId: user._id,
        metadata: {
          runtime: { replyRefs: refs.filter((r) => r.kind === "agent") },
        },
      },
    });
    expect(countRefs(db)).toBe(1);
    expect(store.listReplyCounts(CONVERSATION)).toEqual({
      messages: {},
      agents: { "task-1": 1 },
    });
    // A second reply citing the agent bumps the count.
    store.appendEvent({
      conversationId: CONVERSATION,
      type: "assistant_message",
      payload: {
        text: "Also done.",
        metadata: {
          runtime: { replyRefs: refs.filter((r) => r.kind === "agent") },
        },
      },
    });
    expect(store.listReplyCounts(CONVERSATION).agents["task-1"]).toBe(2);
  });

  it("returns a message lineage: the root and every reply citing it", () => {
    const { store } = createContext();
    const asked = store.appendEvent({
      conversationId: CONVERSATION,
      type: "user_message",
      payload: { text: "What about the Arch package?" },
    });
    store.appendEvent({
      conversationId: CONVERSATION,
      type: "assistant_message",
      payload: { text: "Looking into it.", userMessageId: asked._id },
    });
    const unrelatedUser = store.appendEvent({
      conversationId: CONVERSATION,
      type: "user_message",
      payload: { text: "Unrelated question" },
    });
    store.appendEvent({
      conversationId: CONVERSATION,
      type: "assistant_message",
      payload: { text: "Unrelated answer", userMessageId: unrelatedUser._id },
    });
    const later = store.appendEvent({
      conversationId: CONVERSATION,
      type: "user_message",
      payload: { text: "Any news?" },
    });
    const refs = store.resolveReplyRefs(CONVERSATION, [
      { kind: "message", sequence: asked.sequence! },
    ]);
    const answer = store.appendEvent({
      conversationId: CONVERSATION,
      type: "assistant_message",
      payload: {
        text: "Yes: pacman only.",
        userMessageId: later._id,
        metadata: { runtime: { replyRefs: refs } },
      },
    });
    const lineage = store.listLineageMessages(CONVERSATION, {
      root: { kind: "message", id: asked._id },
    });
    expect(lineage.hasOlder).toBe(false);
    expect(lineage.messages.map((message) => message._id)).toEqual([
      asked._id,
      answer._id,
    ]);
  });

  it("pages a lineage newest-first on beforeSequence", () => {
    const { store } = createContext();
    const asked = store.appendEvent({
      conversationId: CONVERSATION,
      type: "user_message",
      payload: { text: "root" },
    });
    const refs = store.resolveReplyRefs(CONVERSATION, [
      { kind: "message", sequence: asked.sequence! },
    ]);
    const replies: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      replies.push(
        store.appendEvent({
          conversationId: CONVERSATION,
          type: "assistant_message",
          payload: {
            text: `reply ${index}`,
            metadata: { runtime: { replyRefs: refs } },
          },
        })._id,
      );
    }
    const first = store.listLineageMessages(CONVERSATION, {
      root: { kind: "message", id: asked._id },
      limit: 2,
    });
    expect(first.hasOlder).toBe(true);
    expect(first.messages.map((m) => m._id)).toEqual(replies.slice(3));
    const older = store.listLineageMessages(CONVERSATION, {
      root: { kind: "message", id: asked._id },
      limit: 3,
      beforeSequence: first.messages[0]!.sequence,
    });
    expect(older.hasOlder).toBe(true);
    expect(older.messages.map((m) => m._id)).toEqual(replies.slice(0, 3));
    const rest = store.listLineageMessages(CONVERSATION, {
      root: { kind: "message", id: asked._id },
      limit: 3,
      beforeSequence: older.messages[0]!.sequence,
    });
    expect(rest.hasOlder).toBe(false);
    expect(rest.messages.map((m) => m._id)).toEqual([asked._id]);
  });

  it("returns an agent lineage with the spawn turn, cards, and citing replies", () => {
    const { store } = createContext();
    seedAgent(store, "pricing-research", "Pricing research");
    const asked = store.appendEvent({
      conversationId: CONVERSATION,
      type: "user_message",
      payload: { text: "Compare vendor pricing" },
    });
    const spawnReply = store.appendEvent({
      conversationId: CONVERSATION,
      type: "assistant_message",
      payload: { text: "On it.", userMessageId: asked._id },
    });
    const started = store.appendEvent({
      conversationId: CONVERSATION,
      type: "agent-started",
      payload: {
        agentId: "pricing-research",
        description: "Pricing research",
        agentType: "general",
        rootRunId: "run-1",
      },
    });
    const unrelatedUser = store.appendEvent({
      conversationId: CONVERSATION,
      type: "user_message",
      payload: { text: "Something else" },
    });
    const unrelatedReply = store.appendEvent({
      conversationId: CONVERSATION,
      type: "assistant_message",
      payload: { text: "Sure.", userMessageId: unrelatedUser._id },
    });
    const completed = store.appendEvent({
      conversationId: CONVERSATION,
      type: "agent-completed",
      payload: {
        agentId: "pricing-research",
        rootRunId: "run-1",
        result: "ok",
      },
    });
    const refs = store.resolveReplyRefs(CONVERSATION, [], {
      fallbackAgentId: "pricing-research",
    });
    const completionReply = store.appendEvent({
      conversationId: CONVERSATION,
      type: "assistant_message",
      payload: {
        text: "Pricing research is done.",
        metadata: {
          runtime: {
            responseTarget: {
              type: "agent_terminal_notice",
              agentId: "pricing-research",
              terminalState: "completed",
            },
            replyRefs: refs,
          },
        },
      },
    });
    const lineage = store.listLineageMessages(CONVERSATION, {
      root: { kind: "agent", threadId: "pricing-research" },
    });
    expect(lineage.messages.map((m) => m._id)).toEqual([
      asked._id,
      spawnReply._id,
      completionReply._id,
    ]);
    expect(lineage.messages.map((m) => m._id)).not.toContain(
      unrelatedReply._id,
    );
    // Both lifecycle packets ride the lineage so the spawn card settles:
    // the start on its own turn, the completion on the nearest preceding
    // lineage row (the unrelated row it followed in the full timeline is
    // not part of the focus view).
    const spawnRow = lineage.messages[1]!;
    const spawnRowEventIds = spawnRow.toolEvents.map((event) => event._id);
    expect(spawnRowEventIds).toContain(started._id);
    expect(spawnRowEventIds).toContain(completed._id);
    const allEventIds = lineage.messages.flatMap((message) =>
      message.toolEvents.map((event) => event._id),
    );
    expect(allEventIds.filter((id) => id === completed._id)).toHaveLength(1);
    // The agent's report is readable in full for the reply preview.
    expect(store.getAgentRecord("pricing-research")?.result).toContain("three");
  });

  it("returns nothing for an unknown root", () => {
    const { store } = createContext();
    expect(
      store.listLineageMessages(CONVERSATION, {
        root: { kind: "message", id: "missing" },
      }),
    ).toEqual({ messages: [], visibleMessageCount: 0, hasOlder: false });
    expect(
      store.listLineageMessages(CONVERSATION, {
        root: { kind: "agent", threadId: "missing" },
      }),
    ).toEqual({ messages: [], visibleMessageCount: 0, hasOlder: false });
  });
});
