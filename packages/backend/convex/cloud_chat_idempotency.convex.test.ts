/// <reference types="vite/client" />

import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const createMyConversation = makeFunctionReference<"mutation">(
  "cloud_apps:createMyConversation",
);
const getMyCloudConversationIdentity = makeFunctionReference<"query">(
  "cloud_apps:getMyCloudConversationIdentity",
);

const createTest = () => {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
};

type TestHarness = ReturnType<typeof createTest>;

const identity = (t: TestHarness, subject: string) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject,
    tokenIdentifier: `https://issuer.test|${subject}`,
    iat: 1_000,
  });

const anonymousIdentity = (t: TestHarness, subject: string) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject,
    tokenIdentifier: `https://issuer.test|${subject}`,
    isAnonymous: true,
    iat: 1_000,
  });

const ownerIdFor = (subject: string) => `https://issuer.test|${subject}`;

const seedGeneration = async (
  t: TestHarness,
  ownerId: string,
  generation: string,
) => {
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId,
      generation,
      state: "open",
      createdAt: 1,
      updatedAt: 1,
    });
  });
};

const turnsForClient = async (
  t: TestHarness,
  ownerId: string,
  clientMsgId: string,
) =>
  await t.run(
    async (ctx) =>
      await ctx.db
        .query("agent_turns")
        .withIndex("by_ownerId_and_clientMsgId", (q) =>
          q.eq("ownerId", ownerId).eq("clientMsgId", clientMsgId),
        )
        .take(10),
  );

const scheduledForTurn = async (t: TestHarness, turnId: string) =>
  await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (entry) =>
        (entry.name.includes("runCloudTurnInternal") ||
          entry.name.includes("routeCloudTurnInternal")) &&
        entry.state.kind !== "canceled" &&
        typeof entry.args[0] === "object" &&
        entry.args[0] !== null &&
        (entry.args[0] as { turnId?: unknown; dispatchAttempt?: unknown })
          .turnId === turnId &&
        (entry.args[0] as { dispatchAttempt?: unknown }).dispatchAttempt ===
          undefined,
    ),
  );

describe("cloud conversation lifecycle authority", () => {
  it("publishes conversation lifecycle authority to anonymous onboarding owners", async () => {
    const t = createTest();
    const subject = "anonymous-conversation-owner";
    const ownerId = ownerIdFor(subject);
    await seedGeneration(t, ownerId, "generation-anonymous");

    await expect(
      anonymousIdentity(t, subject).query(getMyCloudConversationIdentity, {}),
    ).resolves.toMatchObject({
      ownerId,
      ownerGeneration: "generation-anonymous",
    });
  });

  it("rejects conversation lifecycle authority without a cloud session", async () => {
    const t = createTest();

    await expect(t.query(getMyCloudConversationIdentity, {})).rejects.toThrow(
      /Authentication required/u,
    );
  });

  it("fences a delayed conversation create across an owner-generation reset", async () => {
    const t = createTest();
    const subject = "conversation-generation-owner";
    const ownerId = ownerIdFor(subject);
    await seedGeneration(t, ownerId, "generation-1");
    await t.run(async (ctx) => {
      const lifecycle = await ctx.db
        .query("cloud_owner_lifecycles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique();
      await ctx.db.patch(lifecycle!._id, {
        generation: "generation-2",
        updatedAt: 2,
      });
    });

    await expect(
      identity(t, subject).mutation(createMyConversation, {
        clientCreateId: "create-before-reset",
        expectedOwnerGeneration: "generation-1",
      }),
    ).rejects.toThrow(/reset|generation/iu);
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("cloud_conversations")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .collect(),
      ),
    ).resolves.toEqual([]);
  });

  it("keeps the client-requested conversation identity across retries", async () => {
    const t = createTest();
    const subject = "optimistic-conversation-owner";
    const ownerId = ownerIdFor(subject);
    const generation = "generation-optimistic-conversation";
    const requestedConversationId = "1730c5ea-40d8-4a15-83f5-c60f88a5afc9";
    await seedGeneration(t, ownerId, generation);
    const args = {
      clientCreateId: "optimistic-create-0001",
      requestedConversationId,
      expectedOwnerGeneration: generation,
    };

    const created = await identity(t, subject).mutation(
      createMyConversation,
      args,
    );
    const replayed = await identity(t, subject).mutation(
      createMyConversation,
      args,
    );

    expect(created.conversationId).toBe(requestedConversationId);
    expect(replayed.conversationId).toBe(requestedConversationId);
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("cloud_conversations")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .collect(),
      ),
    ).resolves.toHaveLength(1);
  });

  it("rejects invalid or already-claimed requested conversation identities", async () => {
    const t = createTest();
    const firstSubject = "requested-id-owner-one";
    const secondSubject = "requested-id-owner-two";
    const firstOwnerId = ownerIdFor(firstSubject);
    const secondOwnerId = ownerIdFor(secondSubject);
    const requestedConversationId = "dad44f0e-ef82-4bba-a29a-86f064cd12a1";
    await seedGeneration(t, firstOwnerId, "generation-requested-one");
    await seedGeneration(t, secondOwnerId, "generation-requested-two");

    await identity(t, firstSubject).mutation(createMyConversation, {
      clientCreateId: "requested-id-create-one",
      requestedConversationId,
      expectedOwnerGeneration: "generation-requested-one",
    });

    await expect(
      identity(t, secondSubject).mutation(createMyConversation, {
        clientCreateId: "requested-id-create-two",
        requestedConversationId,
        expectedOwnerGeneration: "generation-requested-two",
      }),
    ).rejects.toThrow(/could not be created/iu);
    await expect(
      identity(t, secondSubject).mutation(createMyConversation, {
        clientCreateId: "requested-id-create-invalid",
        requestedConversationId: "not-a-uuid",
        expectedOwnerGeneration: "generation-requested-two",
      }),
    ).rejects.toThrow(/could not be created/iu);
  });
});
