/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import { AGENT_EVENT_UNATTRIBUTED_GC_MIN_AGE_MS } from "./agent_event_ownership";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);

const repairOwnership = makeFunctionReference<"mutation", any, any>(
  "agent_event_ownership:repairAgentEventOwnershipBatchInternal",
);
const gcUnattributed = makeFunctionReference<"mutation", any, any>(
  "agent_event_ownership:gcUnattributedAgentEventsBatchInternal",
);
const maintainOwnership = makeFunctionReference<"action", any, any>(
  "agent_event_ownership:maintainAgentEventOwnershipInternal",
);
const deleteOwnerEvents = makeFunctionReference<"mutation", any, any>(
  "agent_event_ownership:deleteOwnerAgentEventsBatchInternal",
);
const hasOwnerEvents = makeFunctionReference<"query", any, any>(
  "agent_event_ownership:hasOwnerAgentEventsInternal",
);
const hasUnattributedEvents = makeFunctionReference<"query", any, any>(
  "agent_event_ownership:hasUnattributedAgentEventsInternal",
);
const appendEvent = makeFunctionReference<"mutation", any, any>(
  "cloud_apps:appendEventInternal",
);
const beginPurge = makeFunctionReference<"mutation", any, any>(
  "owner_lifecycle:beginOwnerDataPurgeInternal",
);

type RepairBatchResult = {
  scanned: number;
  repairedFromTurn: number;
  repairedFromThread: number;
  conflicts: number;
  unresolved: number;
  cursor: string | null;
  done: boolean;
};

type GcBatchResult = {
  scanned: number;
  deleted: number;
  repairedFromTurn: number;
  repairedFromThread: number;
  protectedByConflict: number;
  protectedByLiveSession: number;
  cursor: string | null;
  done: boolean;
};

const insertTurn = async (
  t: ReturnType<typeof createTest>,
  args: {
    ownerId: string;
    ownerGeneration?: string;
    turnId: string;
    sessionId: string;
    createdAt?: number;
  },
) => {
  await t.run(async (ctx) => {
    await ctx.db.insert("agent_turns", {
      ownerId: args.ownerId,
      ...(args.ownerGeneration
        ? { ownerGeneration: args.ownerGeneration }
        : {}),
      turnId: args.turnId,
      sessionId: args.sessionId,
      prompt: "test",
      status: "running",
      createdAt: args.createdAt ?? 1,
      updatedAt: args.createdAt ?? 1,
    });
  });
};

const insertThread = async (
  t: ReturnType<typeof createTest>,
  args: { ownerId: string; threadId: string; createdAt?: number },
) => {
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_agent_threads", {
      threadId: args.threadId,
      ownerId: args.ownerId,
      conversationId: "conversation-1",
      description: "test",
      workspace: "computer",
      agentType: "general",
      status: "running",
      createdAt: args.createdAt ?? 1,
      updatedAt: args.createdAt ?? 1,
    });
  });
};

const insertEvent = async (
  t: ReturnType<typeof createTest>,
  args: {
    turnId: string;
    sessionId: string;
    createdAt: number;
    ownerId?: string;
  },
) => {
  await t.run(async (ctx) => {
    await ctx.db.insert("agent_events", {
      ...(args.ownerId ? { ownerId: args.ownerId } : {}),
      turnId: args.turnId,
      sessionId: args.sessionId,
      seq: 0,
      kind: "progress",
      payloadJson: JSON.stringify({ turnId: args.turnId }),
      createdAt: args.createdAt,
    });
  });
};

describe("agent event ownership", () => {
  it("writes the authoritative turn owner and session on every appended event", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId: "owner-a",
        generation: "generation-a",
        state: "open",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    await insertTurn(t, {
      ownerId: "owner-a",
      ownerGeneration: "generation-a",
      turnId: "turn-a",
      sessionId: "canonical-session",
    });

    await expect(
      t.mutation(appendEvent, {
        ownerId: "owner-a",
        ownerGeneration: "generation-a",
        turnId: "turn-a",
        sessionId: "caller-supplied-session",
        seq: 0,
        kind: "progress",
        payloadJson: "{}",
        terminal: false,
        now: 2,
      }),
    ).rejects.toThrow("Unknown cloud turn");

    await t.mutation(appendEvent, {
      ownerId: "owner-a",
      ownerGeneration: "generation-a",
      turnId: "turn-a",
      sessionId: "canonical-session",
      seq: 0,
      kind: "progress",
      payloadJson: "{}",
      terminal: false,
      now: 2,
    });

    const event = await t.run(
      async (ctx) =>
        await ctx.db
          .query("agent_events")
          .withIndex("by_turnId_and_seq", (q) => q.eq("turnId", "turn-a"))
          .unique(),
    );
    expect(event).toMatchObject({
      ownerId: "owner-a",
      sessionId: "canonical-session",
    });
  });

  it("backfills legacy rows only from an exact turn or durable thread", async () => {
    const t = createTest();
    await insertTurn(t, {
      ownerId: "owner-turn",
      turnId: "turn-parent",
      sessionId: "session-parent",
    });
    await insertThread(t, {
      ownerId: "owner-thread",
      threadId: "thread-parent",
    });
    await insertTurn(t, {
      ownerId: "owner-conflict",
      turnId: "turn-conflict",
      sessionId: "session-authoritative",
    });
    await insertEvent(t, {
      turnId: "turn-parent",
      sessionId: "session-parent",
      createdAt: 1,
    });
    await insertEvent(t, {
      turnId: "missing-thread-turn",
      sessionId: "thread-parent",
      createdAt: 2,
    });
    await insertEvent(t, {
      turnId: "turn-conflict",
      sessionId: "session-conflict",
      createdAt: 3,
    });
    await insertEvent(t, {
      turnId: "missing-turn",
      sessionId: "missing-session",
      createdAt: 4,
    });

    expect(await t.query(hasUnattributedEvents, {})).toBe(true);
    const total = {
      scanned: 0,
      repairedFromTurn: 0,
      repairedFromThread: 0,
      conflicts: 0,
      unresolved: 0,
    };
    let cursor: string | null = null;
    let done = false;
    for (let pass = 0; pass < 10 && !done; pass += 1) {
      const result: RepairBatchResult = await t.mutation(repairOwnership, {
        cursor,
        limit: 1,
      });
      total.scanned += result.scanned;
      total.repairedFromTurn += result.repairedFromTurn;
      total.repairedFromThread += result.repairedFromThread;
      total.conflicts += result.conflicts;
      total.unresolved += result.unresolved;
      cursor = result.cursor;
      done = result.done;
    }
    expect(done).toBe(true);
    expect(total).toEqual({
      scanned: 4,
      repairedFromTurn: 1,
      repairedFromThread: 1,
      conflicts: 1,
      unresolved: 1,
    });

    const events = await t.run(
      async (ctx) => await ctx.db.query("agent_events").collect(),
    );
    expect(
      events.find((event) => event.turnId === "turn-parent")?.ownerId,
    ).toBe("owner-turn");
    expect(
      events.find((event) => event.turnId === "missing-thread-turn")?.ownerId,
    ).toBe("owner-thread");
    expect(
      events.find((event) => event.turnId === "turn-conflict")?.ownerId,
    ).toBeUndefined();
    expect(
      events.find((event) => event.turnId === "missing-turn")?.ownerId,
    ).toBeUndefined();
  });

  it("garbage-collects only old rows with no live turn, session, or thread", async () => {
    const t = createTest();
    const now = Date.now();
    const old = now - AGENT_EVENT_UNATTRIBUTED_GC_MIN_AGE_MS - 1;
    await insertTurn(t, {
      ownerId: "owner-turn",
      turnId: "turn-parent",
      sessionId: "session-parent",
      createdAt: old,
    });
    await insertThread(t, {
      ownerId: "owner-thread",
      threadId: "thread-parent",
      createdAt: old,
    });
    await insertTurn(t, {
      ownerId: "owner-session",
      turnId: "different-turn",
      sessionId: "live-session",
      createdAt: old,
    });
    await insertTurn(t, {
      ownerId: "owner-conflict",
      turnId: "turn-conflict",
      sessionId: "canonical-session",
      createdAt: old,
    });
    await insertEvent(t, {
      turnId: "orphan-old",
      sessionId: "orphan-session",
      createdAt: old,
    });
    await insertEvent(t, {
      turnId: "turn-parent",
      sessionId: "session-parent",
      createdAt: old,
    });
    await insertEvent(t, {
      turnId: "missing-thread-turn",
      sessionId: "thread-parent",
      createdAt: old,
    });
    await insertEvent(t, {
      turnId: "missing-session-turn",
      sessionId: "live-session",
      createdAt: old,
    });
    await insertEvent(t, {
      turnId: "turn-conflict",
      sessionId: "conflicting-session",
      createdAt: old,
    });
    await insertEvent(t, {
      turnId: "orphan-young",
      sessionId: "young-session",
      createdAt: now - 1,
    });

    const total = {
      scanned: 0,
      deleted: 0,
      repairedFromTurn: 0,
      repairedFromThread: 0,
      protectedByConflict: 0,
      protectedByLiveSession: 0,
    };
    let cursor: string | null = null;
    let done = false;
    for (let pass = 0; pass < 10 && !done; pass += 1) {
      const result: GcBatchResult = await t.mutation(gcUnattributed, {
        cursor,
        limit: 1,
      });
      total.scanned += result.scanned;
      total.deleted += result.deleted;
      total.repairedFromTurn += result.repairedFromTurn;
      total.repairedFromThread += result.repairedFromThread;
      total.protectedByConflict += result.protectedByConflict;
      total.protectedByLiveSession += result.protectedByLiveSession;
      cursor = result.cursor;
      done = result.done;
    }
    expect(done).toBe(true);
    expect(total).toEqual({
      scanned: 5,
      deleted: 1,
      repairedFromTurn: 1,
      repairedFromThread: 1,
      protectedByConflict: 1,
      protectedByLiveSession: 1,
    });

    const remaining = await t.run(
      async (ctx) => await ctx.db.query("agent_events").collect(),
    );
    expect(remaining.some((event) => event.turnId === "orphan-old")).toBe(
      false,
    );
    expect(remaining.some((event) => event.turnId === "orphan-young")).toBe(
      true,
    );
    expect(
      remaining.find((event) => event.turnId === "turn-parent")?.ownerId,
    ).toBe("owner-turn");
    expect(
      remaining.find((event) => event.turnId === "missing-thread-turn")
        ?.ownerId,
    ).toBe("owner-thread");
  });

  it("exposes owner-indexed purge and strict readback seams", async () => {
    const t = createTest();
    await insertEvent(t, {
      ownerId: "owner-a",
      turnId: "turn-a-1",
      sessionId: "session-a",
      createdAt: 1,
    });
    await insertEvent(t, {
      ownerId: "owner-a",
      turnId: "turn-a-2",
      sessionId: "session-a",
      createdAt: 2,
    });
    await insertEvent(t, {
      ownerId: "owner-b",
      turnId: "turn-b",
      sessionId: "session-b",
      createdAt: 3,
    });
    expect(await t.query(hasOwnerEvents, { ownerId: "owner-a" })).toBe(true);

    const fence = await t.mutation(beginPurge, {
      ownerId: "owner-a",
      operationId: "purge-owner-a",
      mode: "delete",
      now: 4,
    });
    const result = await t.mutation(deleteOwnerEvents, {
      ownerId: "owner-a",
      operationId: fence.operationId,
      generation: fence.generation,
      limit: 100,
    });
    expect(result).toEqual({ deleted: 2, hasMore: false });
    expect(await t.query(hasOwnerEvents, { ownerId: "owner-a" })).toBe(false);
    expect(await t.query(hasOwnerEvents, { ownerId: "owner-b" })).toBe(true);
  });

  it("persists the maintenance cursor so unresolved prefixes cannot starve later rows", async () => {
    const t = createTest();
    const now = Date.now();
    for (let index = 0; index < 25; index += 1) {
      await insertEvent(t, {
        turnId: `unresolved-turn-${index}`,
        sessionId: `unresolved-session-${index}`,
        createdAt: now + index,
      });
    }
    await insertTurn(t, {
      ownerId: "owner-tail",
      turnId: "repairable-tail-turn",
      sessionId: "repairable-tail-session",
      createdAt: now + 100,
    });
    await insertEvent(t, {
      turnId: "repairable-tail-turn",
      sessionId: "repairable-tail-session",
      createdAt: now + 100,
    });

    const first = await t.action(maintainOwnership, { maxBatches: 1 });
    expect(first).toMatchObject({
      claimed: true,
      batches: 1,
      nextPhase: "repair",
      repairScanned: 25,
      repairUnresolved: 25,
      repairedFromTurn: 0,
    });
    expect(first.nextCursor).not.toBeNull();

    const second = await t.action(maintainOwnership, { maxBatches: 1 });
    expect(second).toMatchObject({
      claimed: true,
      batches: 1,
      nextPhase: "gc",
      repairScanned: 1,
      repairedFromTurn: 1,
    });
    expect(second.nextCursor).toBeNull();

    const repaired = await t.run(
      async (ctx) =>
        await ctx.db
          .query("agent_events")
          .withIndex("by_turnId_and_seq", (q) =>
            q.eq("turnId", "repairable-tail-turn"),
          )
          .unique(),
    );
    expect(repaired?.ownerId).toBe("owner-tail");
  });
});
