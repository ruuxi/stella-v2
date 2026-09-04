/// <reference types="vite/client" />

import { createHash } from "node:crypto";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DispatchSummary } from "@stella/contracts/turn-plane/placement";
import {
  CONVEX_OUTBOX_PATH,
  type OutboxBatchResult,
  type OutboxEvent,
} from "@stella/contracts/turn-plane/outbox";
import { components } from "./_generated/api";
import betterAuthSchema from "./betterAuth/schema";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.ts");

const SECRET = "outbox-builder-secret";
const OWNER_ID = "https://issuer.test|outbox-owner";
const OTHER_OWNER_ID = "https://issuer.test|outbox-other";
const GENERATION = "generation-outbox";
const CONVERSATION_ID = "5d0f5c8e-6f4a-4b8b-9a9c-0f1e2d3c4b5a";
const EXECUTION = {
  engine: "stella" as const,
  provider: "stella" as const,
  model: "stella/default",
  reasoningEffort: "default" as const,
};

beforeAll(() => {
  process.env.BUILDER_SERVICE_SECRET = SECRET;
});

afterEach(() => {
  process.env.BUILDER_SERVICE_SECRET = SECRET;
});

const createTest = async () => {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  rateLimiterTest.register(t);
  await t.run(async (ctx) => {
    for (const ownerId of [OWNER_ID, OTHER_OWNER_ID]) {
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId,
        generation: GENERATION,
        state: "open",
        createdAt: 1,
        updatedAt: 1,
      });
    }
  });
  return t;
};

type Harness = Awaited<ReturnType<typeof createTest>>;

let keyCounter = 0;
const event = <K extends OutboxEvent["kind"]>(
  kind: K,
  fields: Omit<
    Extract<OutboxEvent, { kind: K }>,
    "v" | "kind" | "key" | "ownerId" | "ownerGeneration" | "emittedAt"
  > &
    Partial<Pick<OutboxEvent, "key" | "ownerId" | "ownerGeneration">>,
): Extract<OutboxEvent, { kind: K }> =>
  ({
    v: 1,
    kind,
    key: `${kind}:${(keyCounter += 1)}`,
    ownerId: OWNER_ID,
    ownerGeneration: GENERATION,
    emittedAt: 1_000,
    ...fields,
  }) as Extract<OutboxEvent, { kind: K }>;

const post = async (
  t: Harness,
  events: unknown[],
  headers: Record<string, string> = { authorization: `Bearer ${SECRET}` },
) =>
  await t.fetch(CONVEX_OUTBOX_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ v: 1, events }),
  });

const ingest = async (
  t: Harness,
  events: unknown[],
): Promise<OutboxBatchResult> => {
  const response = await post(t, events);
  expect(response.status).toBe(200);
  return (await response.json()) as OutboxBatchResult;
};

const created = (
  overrides: Partial<Parameters<typeof event<"conversation.created">>[1]> = {},
) =>
  event("conversation.created", {
    conversationId: CONVERSATION_ID,
    createdAt: 10,
    title: "Outbox conversation",
    execution: EXECUTION,
    ...overrides,
  });

const turnStarted = (turnId: string, overrides: Record<string, unknown> = {}) =>
  event("turn.started", {
    turnId,
    turnKind: "chat",
    conversationId: CONVERSATION_ID,
    sessionId: `chat-${CONVERSATION_ID.slice(0, 8)}`,
    lane: "chat",
    source: "desktop",
    clientMsgId: `msg:${turnId}`,
    agentType: "orchestrator",
    execution: EXECUTION,
    prompt: "hello",
    createdAt: 20,
    ...overrides,
  });

const turnEvent = (
  turnId: string,
  eventSeq: number,
  overrides: Record<string, unknown> = {},
) =>
  event("turn.event", {
    turnId,
    sessionId: `chat-${CONVERSATION_ID.slice(0, 8)}`,
    eventSeq,
    eventKind: "progress",
    payload: { message: `step ${eventSeq}` },
    terminal: false,
    createdAt: 30 + eventSeq,
    ...overrides,
  });

describe("POST /api/cloud/outbox authentication", () => {
  it("requires the builder service secret and disables itself without one", async () => {
    const t = await createTest();
    expect((await post(t, [], {})).status).toBe(401);
    expect(
      (await post(t, [], { authorization: "Bearer not-the-secret" })).status,
    ).toBe(401);
    delete process.env.BUILDER_SERVICE_SECRET;
    expect((await post(t, [])).status).toBe(503);
  });

  it("rejects malformed batches and events", async () => {
    const t = await createTest();
    const bad = await t.fetch(CONVEX_OUTBOX_PATH, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
      body: "{",
    });
    expect(bad.status).toBe(400);
    const result = await ingest(t, [
      { v: 1, kind: "turn.started", key: "missing-fields", ownerId: OWNER_ID },
      { v: 2, kind: "conversation.created", key: "wrong-version" },
    ]);
    expect(result).toEqual({
      applied: [],
      duplicate: [],
      rejected: [
        { kind: "turn.started", key: "missing-fields", reason: "invalid" },
        {
          kind: "conversation.created",
          key: "wrong-version",
          reason: "invalid",
        },
      ],
    });
  });
});

describe("conversation projections", () => {
  it("creates, deduplicates by receipt, and refuses another owner's id", async () => {
    const t = await createTest();
    const first = created();
    expect(await ingest(t, [first])).toEqual({
      applied: [first.key],
      duplicate: [],
      rejected: [],
    });
    expect(await ingest(t, [first])).toMatchObject({ duplicate: [first.key] });
    const sameIdNewKey = created({ key: "created:again" });
    expect(await ingest(t, [sameIdNewKey])).toMatchObject({
      duplicate: [sameIdNewKey.key],
    });
    const foreign = created({
      key: "created:foreign",
      ownerId: OTHER_OWNER_ID,
    });
    expect(await ingest(t, [foreign])).toMatchObject({
      rejected: [
        {
          kind: "conversation.created",
          key: foreign.key,
          reason: "owner_mismatch",
        },
      ],
    });
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("cloud_conversations").collect();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        conversationId: CONVERSATION_ID,
        ownerId: OWNER_ID,
        title: "Outbox conversation",
        createdAt: 10,
        updatedAt: 10,
        execution: EXECUTION,
      });
    });
  });

  it("fences index flushes on (epoch, lastSeq)", async () => {
    const t = await createTest();
    await ingest(t, [created()]);
    const index = (key: string, epoch: number, lastSeq: number, text: string) =>
      event("conversation.index", {
        key,
        conversationId: CONVERSATION_ID,
        epoch,
        lastSeq,
        updatedAt: 100 + lastSeq,
        lastPreview: text,
        lastRole: "assistant",
        activity: "idle",
      });
    expect(await ingest(t, [index("idx:1", 1, 4, "four")])).toMatchObject({
      applied: ["idx:1"],
    });
    expect(await ingest(t, [index("idx:2", 1, 2, "two")])).toMatchObject({
      duplicate: ["idx:2"],
    });
    expect(await ingest(t, [index("idx:3", 0, 9, "old epoch")])).toMatchObject({
      rejected: [
        { kind: "conversation.index", key: "idx:3", reason: "stale_epoch" },
      ],
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("cloud_conversations")
        .withIndex("by_conversationId", (q) =>
          q.eq("conversationId", CONVERSATION_ID),
        )
        .unique();
      expect(row).toMatchObject({ epoch: 1, lastSeq: 4, lastPreview: "four" });
    });
  });

  it("tombstones on delete and schedules the storage purge", async () => {
    const t = await createTest();
    await ingest(t, [created()]);
    const deleted = event("conversation.deleted", {
      conversationId: CONVERSATION_ID,
      deletedAt: 500,
    });
    expect(await ingest(t, [deleted])).toMatchObject({
      applied: [deleted.key],
    });
    expect(
      await ingest(t, [{ ...deleted, key: "deleted:again" }]),
    ).toMatchObject({
      duplicate: ["deleted:again"],
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("cloud_conversations")
        .withIndex("by_conversationId", (q) =>
          q.eq("conversationId", CONVERSATION_ID),
        )
        .unique();
      expect(row).toMatchObject({ deletedAt: 500, title: "" });
      const scheduled = await ctx.db.system
        .query("_scheduled_functions")
        .collect();
      expect(
        scheduled.some((entry) =>
          entry.name.includes("purgeConversationInternal"),
        ),
      ).toBe(true);
    });
  });
});

describe("turn projections", () => {
  it("projects turn.started with its client id and bumps the conversation", async () => {
    const t = await createTest();
    await ingest(t, [created()]);
    const started = turnStarted("turn-1");
    expect(await ingest(t, [started])).toMatchObject({
      applied: [started.key],
    });
    expect(
      await ingest(t, [{ ...started, key: "started:again" }]),
    ).toMatchObject({
      duplicate: ["started:again"],
    });
    await t.run(async (ctx) => {
      const turn = await ctx.db
        .query("agent_turns")
        .withIndex("by_ownerId_and_clientMsgId", (q) =>
          q.eq("ownerId", OWNER_ID).eq("clientMsgId", "msg:turn-1"),
        )
        .unique();
      expect(turn).toMatchObject({
        turnId: "turn-1",
        kind: "chat",
        lane: "chat",
        status: "running",
        source: "desktop",
        ownerGeneration: GENERATION,
        execution: EXECUTION,
      });
      const conversation = await ctx.db
        .query("cloud_conversations")
        .withIndex("by_conversationId", (q) =>
          q.eq("conversationId", CONVERSATION_ID),
        )
        .unique();
      expect(conversation?.updatedAt).toBe(20);
    });
  });

  it("applies events once per (turn, attempt, eventSeq) and closes the turn on the first terminal", async () => {
    const t = await createTest();
    await ingest(t, [created(), turnStarted("turn-2")]);
    const progress = turnEvent("turn-2", 0);
    const redelivered = { ...progress, key: "event:redelivered-with-new-key" };
    const terminal = turnEvent("turn-2", 1, {
      eventKind: "completed",
      payload: { finalText: "done" },
      terminal: true,
      terminalStatus: "completed",
    });
    const secondTerminal = turnEvent("turn-2", 2, {
      eventKind: "failed",
      payload: { message: "late" },
      terminal: true,
      terminalStatus: "failed",
    });
    const result = await ingest(t, [
      progress,
      redelivered,
      terminal,
      secondTerminal,
    ]);
    expect(result).toEqual({
      applied: [progress.key, terminal.key],
      duplicate: [redelivered.key, secondTerminal.key],
      rejected: [],
    });
    await t.run(async (ctx) => {
      const turn = await ctx.db
        .query("agent_turns")
        .withIndex("by_turnId", (q) => q.eq("turnId", "turn-2"))
        .unique();
      expect(turn).toMatchObject({
        status: "completed",
        terminalKind: "completed",
        resultJson: JSON.stringify({ finalText: "done" }),
      });
      const events = await ctx.db
        .query("agent_events")
        .withIndex("by_turnId_and_seq", (q) => q.eq("turnId", "turn-2"))
        .collect();
      expect(
        events.map((entry) => [entry.seq, entry.eventSeq, entry.kind]),
      ).toEqual([
        [0, 0, "progress"],
        [1, 1, "completed"],
      ]);
    });
  });

  it("rejects unknown turns, stale generations, and purged owners permanently", async () => {
    const t = await createTest();
    await ingest(t, [created(), turnStarted("turn-3")]);
    const unknown = turnEvent("turn-missing", 0);
    const stale = turnEvent("turn-3", 0, {
      ownerGeneration: "generation-before-reset",
    });
    expect(await ingest(t, [unknown, stale])).toMatchObject({
      rejected: [
        { kind: "turn.event", key: unknown.key, reason: "unknown_turn" },
        { kind: "turn.event", key: stale.key, reason: "generation_stale" },
      ],
    });
    await t.run(async (ctx) => {
      const lifecycle = await ctx.db
        .query("cloud_owner_lifecycles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER_ID))
        .unique();
      await ctx.db.patch(lifecycle!._id, { state: "deleting" });
    });
    const purged = turnEvent("turn-3", 1);
    expect(await ingest(t, [purged])).toMatchObject({
      rejected: [
        { kind: "turn.event", key: purged.key, reason: "owner_purged" },
      ],
    });
  });

  it("orders a reordered batch parent-first", async () => {
    const t = await createTest();
    const conversation = created();
    const started = turnStarted("turn-4");
    const progress = turnEvent("turn-4", 0);
    expect(await ingest(t, [progress, started, conversation])).toEqual({
      applied: [conversation.key, started.key, progress.key],
      duplicate: [],
      rejected: [],
    });
  });
});

describe("thread projections", () => {
  const threadId = "thr-outbox-thread-1";
  const seedRunningThread = async (t: Harness) => {
    await ingest(t, [created(), turnStarted("parent-turn")]);
    const spawned = event("thread.spawned", {
      threadId,
      conversationId: CONVERSATION_ID,
      parentTurnId: "parent-turn",
      parentThreadId: "parent-thread",
      agentDepth: 2,
      attemptGeneration: 1,
      description: "Research the thing",
      prompt: "research",
      execution: EXECUTION,
      placement: "cloud",
      createdAt: 40,
    });
    const agentTurn = turnStarted("agent-turn-1", {
      turnKind: "agent",
      lane: "agent",
      source: "agent-thread",
      threadId,
      attemptGeneration: 1,
      agentType: "general",
      hidden: true,
      sessionId: threadId,
      clientMsgId: undefined,
    });
    return { spawned, agentTurn };
  };

  it("spawns and completes exactly once", async () => {
    const t = await createTest();
    const { spawned, agentTurn } = await seedRunningThread(t);
    // Batch order is parent-first: the turn row lands before the thread row.
    expect(await ingest(t, [spawned, agentTurn])).toMatchObject({
      applied: [agentTurn.key, spawned.key],
    });
    expect(
      await ingest(t, [{ ...spawned, key: "spawned:again" }]),
    ).toMatchObject({
      duplicate: ["spawned:again"],
    });
    const outputFiles = turnEvent("agent-turn-1", 0, {
      sessionId: threadId,
      attemptGeneration: 1,
      eventKind: "output_files",
      payload: { files: [{ path: "out/report.md", name: "report.md" }] },
    });
    const completed = event("thread.completed", {
      threadId,
      turnId: "agent-turn-1",
      attemptGeneration: 1,
      status: "completed",
      resultJson: JSON.stringify({ finalText: "done" }),
      completedAt: 90,
    });
    expect(await ingest(t, [outputFiles, completed])).toMatchObject({
      applied: [outputFiles.key, completed.key],
    });
    expect(
      await ingest(t, [{ ...completed, key: "completed:again" }]),
    ).toMatchObject({
      duplicate: ["completed:again"],
    });
    const stale = event("thread.completed", {
      key: "completed:stale-attempt",
      threadId,
      turnId: "agent-turn-0",
      attemptGeneration: 0 as never,
      status: "failed",
      completedAt: 91,
    });
    expect(await ingest(t, [stale])).toMatchObject({
      rejected: [
        { kind: "thread.completed", key: stale.key, reason: "invalid" },
      ],
    });
    await t.run(async (ctx) => {
      const thread = await ctx.db
        .query("cloud_agent_threads")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .unique();
      expect(thread).toMatchObject({
        parentThreadId: "parent-thread",
        status: "completed",
        attemptGeneration: 1,
        resultJson: JSON.stringify({ finalText: "done" }),
        updatedAt: 90,
      });
      const scheduled = await ctx.db.system
        .query("_scheduled_functions")
        .collect();
      const card = scheduled.find((entry) =>
        entry.name.includes("postConversationCardInternal"),
      );
      expect(card?.args[0]).toMatchObject({
        conversationId: CONVERSATION_ID,
        sourceTurnId: "agent-turn-1",
        card: { type: "files", files: [{ path: "out/report.md" }] },
      });
    });
  });

  it("treats a desktop-spawned thread's own projection as a duplicate and continues it on a newer attempt", async () => {
    const t = await createTest();
    await ingest(t, [created()]);
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_agent_threads", {
        threadId,
        ownerId: OWNER_ID,
        ownerGeneration: GENERATION,
        conversationId: CONVERSATION_ID,
        originDeviceId: "desktop-1",
        originConversationId: "local-1",
        description: "Desktop spawn",
        placement: "cloud",
        agentType: "general",
        attemptGeneration: 1,
        sandboxLeaseExpiresAt: 10_000,
        status: "completed",
        createdAt: 5,
        updatedAt: 6,
      });
    });
    const sameAttempt = event("thread.spawned", {
      threadId,
      conversationId: CONVERSATION_ID,
      parentTurnId: "parent-turn",
      agentDepth: 1,
      attemptGeneration: 1,
      description: "Desktop spawn",
      prompt: "go",
      execution: EXECUTION,
      placement: "cloud",
      originDeviceId: "desktop-1",
      originConversationId: "local-1",
      createdAt: 7,
    });
    const continuation = {
      ...sameAttempt,
      key: "spawned:attempt-2",
      attemptGeneration: 2,
      createdAt: 8,
    };
    expect(await ingest(t, [sameAttempt, continuation])).toMatchObject({
      applied: [continuation.key],
      duplicate: [sameAttempt.key],
    });
    await t.run(async (ctx) => {
      const thread = await ctx.db
        .query("cloud_agent_threads")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .unique();
      expect(thread).toMatchObject({
        status: "running",
        attemptGeneration: 2,
        originDeviceId: "desktop-1",
      });
      expect(thread?.originDeliveryAckAt).toBeUndefined();
    });
  });
});

describe("build projections", () => {
  it("records an app build once and rejects a mismatched owner", async () => {
    const t = await createTest();
    const appId = "app-outbox-build";
    const turnId = "build-turn-1";
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_apps", {
        appId,
        ownerId: OWNER_ID,
        slug: "orbit-outbox",
        title: "New app",
        status: "building",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("agent_turns", {
        turnId,
        sessionId: "cloud-build",
        ownerId: OWNER_ID,
        ownerGeneration: GENERATION,
        appId,
        prompt: "build",
        status: "running",
        kind: "build",
        lane: "build",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const ownerHash = createHash("sha256")
      .update(OWNER_ID, "utf8")
      .digest("hex");
    const buildId = "build-0001";
    const payload = {
      buildId,
      appId,
      ownerId: OWNER_ID,
      ownerGeneration: GENERATION,
      turnId,
      artifactPrefix: `builds/${ownerHash}/${buildId}`,
      previewUrl: "https://preview.stella.test/orbit-outbox",
      metrics: { files: 3, uploadedBytes: 1024 },
      slug: "orbit-outbox",
      title: "Orbit",
    };
    const recorded = event("build.recorded", { buildId, payload });
    expect(await ingest(t, [recorded])).toMatchObject({
      applied: [recorded.key],
    });
    expect(
      await ingest(t, [{ ...recorded, key: "build:again" }]),
    ).toMatchObject({
      duplicate: ["build:again"],
    });
    const foreign = event("build.recorded", {
      key: "build:foreign",
      buildId,
      payload: { ...payload, ownerId: OTHER_OWNER_ID },
      ownerId: OTHER_OWNER_ID,
    });
    expect(await ingest(t, [foreign])).toMatchObject({
      rejected: [
        { kind: "build.recorded", key: "build:foreign", reason: "invalid" },
      ],
    });
    const interior = event("interior-build.recorded", {
      buildId: "interior-bad",
      payload: { buildId: "interior-bad" },
    });
    expect(await ingest(t, [interior])).toMatchObject({
      rejected: [
        {
          kind: "interior-build.recorded",
          key: interior.key,
          reason: "invalid",
        },
      ],
    });
    await t.run(async (ctx) => {
      const builds = await ctx.db.query("cloud_app_builds").collect();
      expect(builds).toHaveLength(1);
      expect(builds[0]).toMatchObject({
        buildId,
        appId,
        turnId,
        callbackTitle: "Orbit",
      });
      const app = await ctx.db
        .query("cloud_apps")
        .withIndex("by_appId", (q) => q.eq("appId", appId))
        .unique();
      expect(app?.title).toBe("Orbit");
    });
  });
});

describe("dispatch projection", () => {
  const DISPATCH_ID = "dispatch-1";
  const summary = (
    overrides: Partial<DispatchSummary> = {},
  ): DispatchSummary => ({
    dispatchId: DISPATCH_ID,
    idempotencyKey: "idem-1",
    kind: "chat",
    ingress: "mobile",
    subject: "portable",
    conversationId: CONVERSATION_ID,
    state: "offering",
    revision: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  });
  const dispatchEvent = (
    dispatch: DispatchSummary,
    overrides: { ownerId?: string } = {},
  ) =>
    event("dispatch.updated", {
      key: `${dispatch.dispatchId}:${dispatch.revision}`,
      dispatchId: dispatch.dispatchId,
      dispatch,
      ...overrides,
    });

  const rows = (t: Harness) =>
    t.run(async (ctx) => await ctx.db.query("cloud_dispatches").collect());

  it("keeps one row per dispatch at the highest revision", async () => {
    const t = await createTest();
    expect(await ingest(t, [dispatchEvent(summary())])).toMatchObject({
      applied: [`${DISPATCH_ID}:1`],
    });
    const claimed = summary({
      revision: 2,
      state: "computer_accepted",
      placement: "computer",
      executorDeviceId: "desktop-1",
      executorPresenceSessionId: "presence-1",
      updatedAt: 2_000,
    });
    expect(await ingest(t, [dispatchEvent(claimed)])).toMatchObject({
      applied: [`${DISPATCH_ID}:2`],
    });
    const stored = await rows(t);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      dispatchId: DISPATCH_ID,
      ownerId: OWNER_ID,
      revision: 2,
      state: "computer_accepted",
      placement: "computer",
      executorDeviceId: "desktop-1",
      // The insert's createdAt survives; only the gate's later fields move.
      createdAt: 1_000,
      updatedAt: 2_000,
    });
  });

  it("drops an out-of-order older revision and replays are duplicates", async () => {
    const t = await createTest();
    const newer = summary({
      revision: 5,
      state: "completed",
      placement: "cloud",
      cloudTurnId: "turn-9",
      updatedAt: 5_000,
    });
    await ingest(t, [dispatchEvent(newer)]);
    // A redelivery of the same revision never reaches the projection: the
    // (kind, key) receipt answers first.
    expect(await ingest(t, [dispatchEvent(newer)])).toMatchObject({
      duplicate: [`${DISPATCH_ID}:5`],
    });
    // A genuinely older revision arriving late carries a fresh key, so the
    // revision fence — not the receipt — is what refuses it.
    const older = summary({
      revision: 4,
      state: "cloud_running",
      updatedAt: 4_000,
    });
    expect(await ingest(t, [dispatchEvent(older)])).toMatchObject({
      duplicate: [`${DISPATCH_ID}:4`],
    });
    const stored = await rows(t);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      revision: 5,
      state: "completed",
      cloudTurnId: "turn-9",
      updatedAt: 5_000,
    });
  });

  it("clears fields a newer revision dropped", async () => {
    const t = await createTest();
    await ingest(t, [
      dispatchEvent(
        summary({
          revision: 1,
          state: "cancel_pending",
          cancelRequestId: "cancel-1",
          cancelReason: "user asked",
          errorCode: "transient",
        }),
      ),
    ]);
    await ingest(t, [
      dispatchEvent(
        summary({ revision: 2, state: "completed", updatedAt: 3_000 }),
      ),
    ]);
    const stored = await rows(t);
    expect(stored[0]?.cancelRequestId).toBeUndefined();
    expect(stored[0]?.cancelReason).toBeUndefined();
    expect(stored[0]?.errorCode).toBeUndefined();
  });

  it("refuses another owner's dispatch id and a malformed summary", async () => {
    const t = await createTest();
    await ingest(t, [dispatchEvent(summary())]);
    expect(
      await ingest(t, [
        dispatchEvent(summary({ revision: 2 }), { ownerId: OTHER_OWNER_ID }),
      ]),
    ).toMatchObject({
      rejected: [
        {
          kind: "dispatch.updated",
          key: `${DISPATCH_ID}:2`,
          reason: "owner_mismatch",
        },
      ],
    });
    const badState = {
      ...dispatchEvent(summary({ revision: 3 })),
      dispatch: { ...summary({ revision: 3 }), state: "queued" },
    };
    expect(await ingest(t, [badState])).toMatchObject({
      rejected: [
        {
          kind: "dispatch.updated",
          key: `${DISPATCH_ID}:3`,
          reason: "invalid",
        },
      ],
    });
    // The key must name the exact revision it carries, or a replay of one
    // revision could overwrite another.
    const mismatchedKey = {
      ...dispatchEvent(summary({ revision: 4 })),
      key: `${DISPATCH_ID}:9`,
    };
    expect(await ingest(t, [mismatchedKey])).toMatchObject({
      rejected: [
        {
          kind: "dispatch.updated",
          key: `${DISPATCH_ID}:9`,
          reason: "invalid",
        },
      ],
    });
    const stored = await rows(t);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.revision).toBe(1);
  });
});
