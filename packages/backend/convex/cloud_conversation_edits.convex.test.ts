/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);

const reserveFork = makeFunctionReference<"mutation", any, any>(
  "cloud_conversation_edits:reserveForkInternal",
);
const reserveRewind = makeFunctionReference<"mutation", any, any>(
  "cloud_conversation_edits:reserveRewindInternal",
);
const commitFork = makeFunctionReference<"mutation", any, any>(
  "cloud_conversation_edits:commitForkInternal",
);
const commitRewind = makeFunctionReference<"mutation", any, any>(
  "cloud_conversation_edits:commitRewindInternal",
);
const staleIndexFlush = makeFunctionReference<"mutation", any, any>(
  "cloud_apps:upsertConversationIndexInternal",
);

const insertConversation = async (
  t: ReturnType<typeof createTest>,
  ownerId: string,
  conversationId = "conversation-1",
) => {
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_conversations", {
      ownerId,
      conversationId,
      title: "Conversation",
      createdAt: 1,
      updatedAt: 1,
      epoch: 1,
      lastSeq: 3,
    });
  });
};

describe("cloud conversation edit control plane", () => {
  it("never reveals or edits a cross-owner source", async () => {
    const t = createTest();
    await insertConversation(t, "owner-a");
    await expect(
      t.mutation(reserveFork, {
        ownerId: "owner-b",
        ownerGeneration: "legacy",
        requestId: "request-1",
        fingerprint: "fingerprint-1",
        sourceConversationId: "conversation-1",
        throughSeq: 1,
        expectedEpoch: 1,
        expectedLastSeq: 3,
        now: 2,
      }),
    ).rejects.toThrow("Conversation not found");
    expect(
      await t.run(
        async (ctx) => await ctx.db.query("cloud_conversation_edits").collect(),
      ),
    ).toHaveLength(0);
  });

  it("replays one request id exactly and rejects a changed payload", async () => {
    const t = createTest();
    await insertConversation(t, "owner-a");
    const args = {
      ownerId: "owner-a",
      ownerGeneration: "legacy",
      requestId: "request-1",
      fingerprint: "fingerprint-1",
      sourceConversationId: "conversation-1",
      throughSeq: 1,
      expectedEpoch: 1,
      expectedLastSeq: 3,
      now: 2,
    };
    const first = await t.mutation(reserveFork, args);
    const replay = await t.mutation(reserveFork, { ...args, now: 3 });
    expect(replay.operationId).toBe(first.operationId);
    expect(replay.targetConversationId).toBe(first.targetConversationId);
    await expect(
      t.mutation(reserveFork, {
        ...args,
        fingerprint: "fingerprint-changed",
      }),
    ).rejects.toThrow("requestId was already used");
  });

  it("publishes a fork identity only after the worker reports a complete journal", async () => {
    const t = createTest();
    await insertConversation(t, "owner-a");
    const operation = await t.mutation(reserveFork, {
      ownerId: "owner-a",
      ownerGeneration: "legacy",
      requestId: "request-1",
      fingerprint: "fingerprint-1",
      sourceConversationId: "conversation-1",
      throughSeq: 1,
      expectedEpoch: 1,
      expectedLastSeq: 3,
      now: 2,
    });
    expect(
      await t.run(
        async (ctx) =>
          await ctx.db
            .query("cloud_conversations")
            .withIndex("by_conversationId", (q) =>
              q.eq("conversationId", operation.targetConversationId),
            )
            .unique(),
      ),
    ).toBeNull();

    const committed = await t.mutation(commitFork, {
      ownerId: "owner-a",
      ownerGeneration: "legacy",
      operationId: operation.operationId,
      result: {
        complete: true,
        kind: "fork",
        operationId: operation.operationId,
        sourceConversationId: "conversation-1",
        targetConversationId: operation.targetConversationId,
        sourceEpoch: 1,
        throughSeq: 1,
        targetEpoch: 1,
        lastSeq: 1,
      },
      now: 4,
    });
    expect(committed).toMatchObject({
      conversationId: operation.targetConversationId,
      lastSeq: 1,
      replayed: false,
    });
    expect(
      await t.run(
        async (ctx) =>
          await ctx.db
            .query("cloud_conversations")
            .withIndex("by_conversationId", (q) =>
              q.eq("conversationId", operation.targetConversationId),
            )
            .unique(),
      ),
    ).toMatchObject({ ownerId: "owner-a", epoch: 1, lastSeq: 1 });
  });

  it("rewinds the projection and rejects stale epoch rebuilds", async () => {
    const t = createTest();
    await insertConversation(t, "owner-a");
    const operation = await t.mutation(reserveRewind, {
      ownerId: "owner-a",
      ownerGeneration: "legacy",
      requestId: "request-1",
      fingerprint: "fingerprint-1",
      conversationId: "conversation-1",
      throughSeq: 0,
      expectedEpoch: 1,
      expectedLastSeq: 3,
      activeTurnPolicy: "conflict",
      now: 3,
    });
    await t.mutation(commitRewind, {
      ownerId: "owner-a",
      ownerGeneration: "legacy",
      operationId: operation.operationId,
      result: {
        complete: true,
        kind: "rewind",
        operationId: operation.operationId,
        conversationId: "conversation-1",
        previousEpoch: 1,
        nextEpoch: 2,
        lastSeq: 0,
      },
      now: 4,
    });
    const stale = await t.mutation(staleIndexFlush, {
      conversationId: "conversation-1",
      ownerId: "owner-a",
      ownerGeneration: "legacy",
      epoch: 1,
      lastSeq: 99,
      updatedAt: 5,
      force: true,
    });
    expect(stale).toMatchObject({
      accepted: false,
      reason: "stale_epoch",
      epoch: 2,
      lastSeq: 0,
    });
    const conversation = await t.run(
      async (ctx) =>
        await ctx.db
          .query("cloud_conversations")
          .withIndex("by_conversationId", (q) =>
            q.eq("conversationId", "conversation-1"),
          )
          .unique(),
    );
    expect(conversation).toMatchObject({ epoch: 2, lastSeq: 0 });
  });
});
