/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);

const getPreference = makeFunctionReference<"query", any, any>(
  "cloud_memory:getMyMemoryPreference",
);
const setPreference = makeFunctionReference<"mutation", any, any>(
  "cloud_memory:setMyMemoryEnabled",
);
const listDocuments = makeFunctionReference<"query", any, any>(
  "cloud_memory:listMyMemoryDocuments",
);
const beginMemoryWrite = makeFunctionReference<"mutation", any, any>(
  "cloud_memory:beginWriteInternal",
);
const commitMemoryWrite = makeFunctionReference<"mutation", any, any>(
  "cloud_memory:commitWriteInternal",
);
const searchRecall = makeFunctionReference<"query", any, any>(
  "cloud_agent_home:searchOwnerMessagesInternal",
);
const recordDreamInput = makeFunctionReference<"mutation", any, any>(
  "cloud_dream:recordInboxObjectInternal",
);
const appendEvent = makeFunctionReference<"mutation", any, any>(
  "cloud_apps:appendEventInternal",
);

const OWNER_ID = "https://issuer.test|memory-preference-owner";
const GENERATION = "memory-preference-generation-1";

const asOwner = (t: ReturnType<typeof createTest>) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "memory-preference-owner",
    tokenIdentifier: OWNER_ID,
  });

const openOwner = async (t: ReturnType<typeof createTest>) => {
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId: OWNER_ID,
      generation: GENERATION,
      state: "open",
      createdAt: 1,
      updatedAt: 1,
    });
  });
};

const setEnabled = async (
  t: ReturnType<typeof createTest>,
  memoryEnabled: boolean,
  expectedRevision: number,
  requestId: string,
) =>
  await asOwner(t).mutation(setPreference, {
    expectedSubject: OWNER_ID,
    memoryEnabled,
    expectedOwnerGeneration: GENERATION,
    expectedRevision,
    requestId,
  });

const beginWrite = async (
  t: ReturnType<typeof createTest>,
  args: {
    name: string;
    kind: string;
    writer: string;
    idempotencyKey: string;
  },
) =>
  await t.mutation(beginMemoryWrite, {
    ownerId: OWNER_ID,
    ownerGeneration: GENERATION,
    name: args.name,
    kind: args.kind,
    source: "preference-test",
    expectedRevision: 0,
    sha256: "a".repeat(64),
    sizeBytes: 24,
    writer: args.writer,
    idempotencyKey: args.idempotencyKey,
    now: 100,
  });

const commitWrite = async (
  t: ReturnType<typeof createTest>,
  prepared: Record<string, unknown>,
) =>
  await t.mutation(commitMemoryWrite, {
    ownerId: OWNER_ID,
    ownerGeneration: GENERATION,
    memoryEpoch: prepared.memoryEpoch,
    intentId: prepared.intentId,
    versionId: prepared.versionId,
    r2Key: prepared.r2Key,
    sha256: prepared.sha256,
    sizeBytes: prepared.sizeBytes,
    now: 200,
  });

const insertConversationTurn = async (
  t: ReturnType<typeof createTest>,
  suffix: string,
) => {
  const conversationId = `memory-pref-conversation-${suffix}`;
  const turnId = `memory-pref-turn-${suffix}`;
  const sessionId = `memory-pref-session-${suffix}`;
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_conversations", {
      conversationId,
      ownerId: OWNER_ID,
      title: "Memory preference",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("agent_turns", {
      turnId,
      sessionId,
      ownerId: OWNER_ID,
      ownerGeneration: GENERATION,
      conversationId,
      prompt: "Remember this only when cloud memory is enabled.",
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

describe("authoritative cloud memory preference", () => {
  it("defaults enabled and enforces generation/revision CAS plus idempotency", async () => {
    const t = createTest();
    await openOwner(t);
    expect(
      await asOwner(t).query(getPreference, { expectedSubject: OWNER_ID }),
    ).toEqual({
      subject: OWNER_ID,
      ownerGeneration: GENERATION,
      memoryEnabled: true,
      revision: 0,
      updatedAt: 0,
    });
    await expect(
      asOwner(t).query(getPreference, {
        expectedSubject: "https://issuer.test|different-owner",
      }),
    ).rejects.toThrow("session changed");
    await expect(
      asOwner(t).mutation(setPreference, {
        expectedSubject: "https://issuer.test|different-owner",
        memoryEnabled: false,
        expectedOwnerGeneration: GENERATION,
        expectedRevision: 0,
        requestId: "memory-pref-wrong-subject",
      }),
    ).rejects.toThrow("session changed");

    const disabled = await setEnabled(t, false, 0, "memory-pref-disable-1");
    expect(disabled).toMatchObject({
      ownerGeneration: GENERATION,
      memoryEnabled: false,
      revision: 1,
    });
    expect(await setEnabled(t, false, 0, "memory-pref-disable-1")).toEqual(
      disabled,
    );
    await expect(
      setEnabled(t, true, 0, "memory-pref-disable-1"),
    ).rejects.toThrow("different input");
    await expect(
      setEnabled(t, true, 0, "memory-pref-enable-stale"),
    ).rejects.toThrow("changed before this request");

    await t.run(async (ctx) => {
      const lifecycle = await ctx.db
        .query("cloud_owner_lifecycles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER_ID))
        .unique();
      if (!lifecycle) throw new Error("lifecycle missing");
      await ctx.db.patch(lifecycle._id, {
        generation: "memory-preference-generation-2",
        updatedAt: 300,
      });
    });
    await expect(
      setEnabled(t, true, 1, "memory-pref-enable-old-generation"),
    ).rejects.toThrow("before the account data was reset");
  });

  it("preserves existing heads while blocking Recall, Remember and Dream writes", async () => {
    const t = createTest();
    await openOwner(t);
    const existing = await beginWrite(t, {
      name: "memories/profile.md",
      kind: "profile",
      writer: "system_seed",
      idempotencyKey: "memory-pref-existing-profile",
    });
    expect(await commitWrite(t, existing)).toMatchObject({
      status: "committed",
      nextRevision: 1,
    });
    const preparedDream = await beginWrite(t, {
      name: "MEMORY.md",
      kind: "memory",
      writer: "dream",
      idempotencyKey: "memory-pref-inflight-dream",
    });

    await setEnabled(t, false, 0, "memory-pref-disable-writers");
    expect(await asOwner(t).query(listDocuments, {})).toMatchObject([
      { name: "memories/profile.md", revision: 1 },
    ]);
    await expect(
      beginWrite(t, {
        name: "memories/memory_map.md",
        kind: "memory_map",
        writer: "remember",
        idempotencyKey: "memory-pref-blocked-remember",
      }),
    ).rejects.toThrow("disabled");
    await expect(
      t.query(searchRecall, {
        ownerId: OWNER_ID,
        ownerGeneration: GENERATION,
        terms: ["preference"],
        now: 300,
      }),
    ).rejects.toThrow("disabled");
    await expect(
      t.mutation(recordDreamInput, {
        ownerId: OWNER_ID,
        ownerGeneration: GENERATION,
        memoryEpoch: "legacy",
        kind: "thread_summary",
        sourceKey: "turn:blocked",
        sourceRevision: 1,
        r2Key: "not-used-while-disabled",
        sha256: "b".repeat(64),
        sizeBytes: 1,
        now: 300,
      }),
    ).rejects.toThrow("disabled");
    expect(await commitWrite(t, preparedDream)).toMatchObject({
      status: "aborted",
    });
    expect(await asOwner(t).query(listDocuments, {})).toMatchObject([
      { name: "memories/profile.md", revision: 1 },
    ]);
  });

  it("suppresses automatic Dream while off and resumes on a later enabled turn", async () => {
    const t = createTest();
    await openOwner(t);
    await setEnabled(t, false, 0, "memory-pref-disable-auto-dream");
    const disabledTurn = await insertConversationTurn(t, "disabled");
    await t.mutation(appendEvent, {
      ownerId: OWNER_ID,
      ownerGeneration: GENERATION,
      turnId: disabledTurn.turnId,
      sessionId: disabledTurn.sessionId,
      seq: 0,
      kind: "completed",
      payloadJson: JSON.stringify({ text: "This must not enter Dream." }),
      terminal: true,
      now: 400,
    });
    expect(
      await t.run(
        async (ctx) => await ctx.db.query("cloud_dream_dispatches").collect(),
      ),
    ).toEqual([]);

    await setEnabled(t, true, 1, "memory-pref-enable-auto-dream");
    const enabledTurn = await insertConversationTurn(t, "reenabled");
    await t.mutation(appendEvent, {
      ownerId: OWNER_ID,
      ownerGeneration: GENERATION,
      turnId: enabledTurn.turnId,
      sessionId: enabledTurn.sessionId,
      seq: 0,
      kind: "completed",
      payloadJson: JSON.stringify({ text: "This later turn may enter Dream." }),
      terminal: true,
      now: 500,
    });
    expect(
      await t.run(
        async (ctx) => await ctx.db.query("cloud_dream_dispatches").collect(),
      ),
    ).toMatchObject([
      {
        turnId: enabledTurn.turnId,
        ownerGeneration: GENERATION,
        status: "pending",
        attemptCount: 0,
      },
    ]);
  });
});
