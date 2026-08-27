/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);

const appendEvent = makeFunctionReference<"mutation", any, any>(
  "cloud_apps:appendEventInternal",
);
const sweepDream = makeFunctionReference<"mutation", any, any>(
  "cloud_dream:sweepAutomaticDreamDispatchesInternal",
);
const beginPurge = makeFunctionReference<"mutation", any, any>(
  "owner_lifecycle:beginOwnerDataPurgeInternal",
);

const OWNER_ID = "automatic-dream-owner";
const GENERATION = "automatic-dream-generation";
const CONVERSATION_ID = "conversation-automatic-dream";
const TURN_ID = "turn-automatic-dream";
const SESSION_ID = "session-automatic-dream";

const originalBuilderUrl = process.env.CLOUD_BUILDER_URL;
const originalBuilderSecret = process.env.BUILDER_SERVICE_SECRET;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalBuilderUrl === undefined) delete process.env.CLOUD_BUILDER_URL;
  else process.env.CLOUD_BUILDER_URL = originalBuilderUrl;
  if (originalBuilderSecret === undefined)
    delete process.env.BUILDER_SERVICE_SECRET;
  else process.env.BUILDER_SERVICE_SECRET = originalBuilderSecret;
});

const insertCompletedTurnSource = async (
  t: ReturnType<typeof createTest>,
  suffix = "",
) => {
  const conversationId = `${CONVERSATION_ID}${suffix}`;
  const turnId = `${TURN_ID}${suffix}`;
  const sessionId = `${SESSION_ID}${suffix}`;
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId: OWNER_ID,
      generation: GENERATION,
      state: "open",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("cloud_conversations", {
      conversationId,
      ownerId: OWNER_ID,
      title: "Durable Dream",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("agent_turns", {
      turnId,
      sessionId,
      ownerId: OWNER_ID,
      ownerGeneration: GENERATION,
      conversationId,
      prompt: "Remember that the launch requires exact restart receipts.",
      status: "running",
      lane: "chat",
      kind: "chat",
      agentType: "orchestrator",
      createdAt: 1,
      updatedAt: 1,
    });
  });
  return { conversationId, turnId, sessionId };
};

const acceptCompletion = async (
  t: ReturnType<typeof createTest>,
  source: Awaited<ReturnType<typeof insertCompletedTurnSource>>,
  seq = 0,
) =>
  await t.mutation(appendEvent, {
    ownerId: OWNER_ID,
    ownerGeneration: GENERATION,
    turnId: source.turnId,
    sessionId: source.sessionId,
    seq,
    kind: "completed",
    payloadJson: JSON.stringify({
      text: "The rollout will retain a restart-safe receipt and verify it.",
      wallClockMs: 25,
    }),
    terminal: true,
    now: 10,
  });

const successfulWorker = () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ path, body });
      if (path === "/internal/cloud-home/dream/enqueue") {
        return Response.json({
          inboxId: "dream-inbox-automatic",
          kind: "thread_summary",
          sourceKey: body.sourceKey,
          sourceRevision: body.sourceRevision,
          sha256: "1".repeat(64),
          sizeBytes: 1,
          priority: 0,
          usageCount: 0,
          updatedAt: 10,
        });
      }
      if (path === "/internal/cloud-home/dream/run") {
        return Response.json({
          processedCount: 1,
          supersededCount: 0,
          memoryVersionId: "memory-version-1",
          memoryMapVersionId: "memory-map-version-1",
          archiveVersionIds: [],
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    }),
  );
  return calls;
};

const dispatchRows = async (t: ReturnType<typeof createTest>) =>
  await t.run(
    async (ctx) => await ctx.db.query("cloud_dream_dispatches").collect(),
  );

describe("automatic cloud Dream", () => {
  it("atomically triggers from an accepted completed chat event and deduplicates replay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(10_000));
    process.env.CLOUD_BUILDER_URL = "https://builder.example.test";
    process.env.BUILDER_SERVICE_SECRET = "builder-secret";
    const t = createTest();
    const source = await insertCompletedTurnSource(t);
    const calls = successfulWorker();

    expect(await acceptCompletion(t, source)).toEqual({
      inserted: true,
      terminalAccepted: true,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers, 10);

    const [dispatch] = await dispatchRows(t);
    expect(dispatch).toMatchObject({
      ownerId: OWNER_ID,
      ownerGeneration: GENERATION,
      conversationId: source.conversationId,
      turnId: source.turnId,
      sourceRevision: 1,
      status: "completed",
      attemptCount: 1,
      processedCount: 1,
    });
    expect(dispatch?.lastErrorCode).toBeUndefined();
    expect(dispatch?.sourceKey).toBe(
      `conversation:${source.conversationId}:turn:${source.turnId}`,
    );
    expect(JSON.parse(dispatch!.payloadJson)).toMatchObject({
      schemaVersion: 1,
      kind: "completed_conversation_turn",
      conversationId: source.conversationId,
      turnId: source.turnId,
    });
    expect(dispatch?.payloadJson).toContain("restart-safe receipt");
    expect(calls.map((call) => call.path)).toEqual([
      "/internal/cloud-home/dream/enqueue",
      "/internal/cloud-home/dream/run",
    ]);

    expect(await acceptCompletion(t, source, 1)).toEqual({
      inserted: false,
      terminalAccepted: false,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers, 10);
    expect(await dispatchRows(t)).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("recovers a killed running action after restart without duplicating source identity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(20_000));
    process.env.CLOUD_BUILDER_URL = "https://builder.example.test";
    process.env.BUILDER_SERVICE_SECRET = "builder-secret";
    const t = createTest();
    const source = await insertCompletedTurnSource(t, "-restart");
    await acceptCompletion(t, source);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("cloud_dream_dispatches")
        .withIndex("by_ownerId_and_turnId", (q) =>
          q.eq("ownerId", OWNER_ID).eq("turnId", source.turnId),
        )
        .unique();
      if (!row) throw new Error("dispatch missing");
      await ctx.db.patch(row._id, {
        status: "running",
        attemptCount: 1,
        leaseId: "lost-isolate-lease",
        leaseExpiresAt: 19_000,
        nextAttemptAt: 10,
        updatedAt: 19_000,
      });
    });
    const calls = successfulWorker();
    expect(await t.mutation(sweepDream, { now: 20_000, limit: 20 })).toEqual({
      scheduled: 1,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers, 10);

    const rows = await dispatchRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "completed",
      attemptCount: 2,
      sourceRevision: 1,
      processedCount: 1,
    });
    // Both the pre-crash immediate callback and the cron wake may run, but the
    // same-row lease lets only one perform the two external Worker requests.
    expect(calls.map((call) => call.path)).toEqual([
      "/internal/cloud-home/dream/enqueue",
      "/internal/cloud-home/dream/run",
    ]);
  });

  it("performs no Worker I/O when reset wins before the scheduled action", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(30_000));
    process.env.CLOUD_BUILDER_URL = "https://builder.example.test";
    process.env.BUILDER_SERVICE_SECRET = "builder-secret";
    const scheduledError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fetchSpy = vi.fn(async () => {
      throw new Error("Worker I/O must not begin after the reset fence.");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const t = createTest();
    const source = await insertCompletedTurnSource(t, "-reset");
    await acceptCompletion(t, source);
    await t.mutation(beginPurge, {
      ownerId: OWNER_ID,
      operationId: "automatic-dream-reset",
      mode: "reset",
      now: 29_000,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers, 10);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(scheduledError).toHaveBeenCalled();
    expect((await dispatchRows(t))[0]).toMatchObject({ status: "pending" });
  });

  it("abandons an already-scheduled dispatch when memory is disabled before claim", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(40_000));
    process.env.CLOUD_BUILDER_URL = "https://builder.example.test";
    process.env.BUILDER_SERVICE_SECRET = "builder-secret";
    const fetchSpy = vi.fn(async () => {
      throw new Error("Memory-off Dream must not reach the Worker.");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const t = createTest();
    const source = await insertCompletedTurnSource(t, "-disabled-race");
    await acceptCompletion(t, source);
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_agent_home_preferences", {
        ownerId: OWNER_ID,
        ownerGeneration: GENERATION,
        memoryEnabled: false,
        revision: 1,
        lastRequestId: "automatic-dream-disabled-race",
        lastRequestExpectedRevision: 0,
        lastRequestMemoryEnabled: false,
        createdAt: 39_000,
        updatedAt: 39_000,
      });
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers, 10);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await dispatchRows(t))[0]).toMatchObject({
      status: "abandoned",
      attemptCount: 0,
      lastErrorCode: "CLOUD_MEMORY_DISABLED",
      completedAt: 40_000,
    });
  });
});
