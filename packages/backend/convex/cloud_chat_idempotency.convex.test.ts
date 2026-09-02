/// <reference types="vite/client" />

import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const startAppBuildTurn = makeFunctionReference<"mutation">(
  "cloud_apps:startAppBuildTurn",
);
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

describe("app build lane reliable delivery", () => {
  it("creates the app on first use and replays a lost response with one turn and dispatch", async () => {
    const t = createTest();
    const subject = "build-replay-owner";
    const ownerId = ownerIdFor(subject);
    const generation = "generation-build-replay";
    const clientMsgId = "build:lost-response-0001";
    await seedGeneration(t, ownerId, generation);
    const args = {
      prompt: "Create a habit tracker with a progress ring.",
      appId: "app-build-replay-0001",
      clientMsgId,
      expectedOwnerGeneration: generation,
    };

    const committed = await identity(t, subject).mutation(
      startAppBuildTurn,
      args,
    );
    const recovered = await identity(t, subject).mutation(
      startAppBuildTurn,
      args,
    );

    expect(recovered).toEqual(committed);
    expect(committed.appId).toBe(args.appId);
    const turns = await turnsForClient(t, ownerId, clientMsgId);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      ownerId,
      ownerGeneration: generation,
      conversationId: committed.conversationId,
      turnId: committed.turnId,
      appId: args.appId,
      kind: "build",
      lane: "build",
    });
    expect(turns[0]?.chatIntentFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    await t.run(async (ctx) => {
      expect(
        await ctx.db
          .query("cloud_apps")
          .withIndex("by_appId", (q) => q.eq("appId", args.appId))
          .unique(),
      ).toMatchObject({ ownerId, status: "building", title: "New app" });
      expect(
        await ctx.db
          .query("cloud_conversations")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .collect(),
      ).toHaveLength(1);
    });
    expect(await scheduledForTurn(t, committed.turnId)).toHaveLength(1);
  });

  it("fails closed when a client id changes payload, app, or conversation authority", async () => {
    const t = createTest();
    const subject = "build-conflict-owner";
    const ownerId = ownerIdFor(subject);
    const generation = "generation-build-conflict";
    await seedGeneration(t, ownerId, generation);
    const first = {
      prompt: "Add a dark theme.",
      appId: "app-build-conflict-0001",
      clientMsgId: "build:conflict-0001",
      expectedOwnerGeneration: generation,
    };
    const receipt = await identity(t, subject).mutation(
      startAppBuildTurn,
      first,
    );

    for (const changed of [
      { prompt: "Add a light theme." },
      { appId: "app-build-conflict-0002" },
      { conversationId: "3f0a5c2e-6a1b-4a0c-9c3e-2b7d8e1f0a11" },
      { locale: "fr" },
      { attachments: ["images/mock.png"] },
    ]) {
      await expect(
        identity(t, subject).mutation(startAppBuildTurn, {
          ...first,
          ...changed,
        }),
      ).rejects.toThrow(/already used for a different request|not found/iu);
    }
    expect(await turnsForClient(t, ownerId, first.clientMsgId)).toHaveLength(1);
    expect(await scheduledForTurn(t, receipt.turnId)).toHaveLength(1);
  });

  it("rejects predecessor-generation replay after a reset", async () => {
    const t = createTest();
    const subject = "build-generation-owner";
    const ownerId = ownerIdFor(subject);
    await seedGeneration(t, ownerId, "generation-before");
    const args = {
      prompt: "Ship it.",
      appId: "app-build-generation-0001",
      clientMsgId: "build:generation-0001",
      expectedOwnerGeneration: "generation-before",
    };
    await identity(t, subject).mutation(startAppBuildTurn, args);
    await t.run(async (ctx) => {
      const lifecycle = await ctx.db
        .query("cloud_owner_lifecycles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique();
      await ctx.db.patch(lifecycle!._id, {
        generation: "generation-after",
        updatedAt: 2,
      });
    });

    await expect(
      identity(t, subject).mutation(startAppBuildTurn, args),
    ).rejects.toThrow(/reset|generation/iu);
    await expect(
      identity(t, subject).mutation(startAppBuildTurn, {
        ...args,
        expectedOwnerGeneration: "generation-after",
      }),
    ).rejects.toThrow(/already used for a different request/iu);
  });

  it("keeps identical client ids isolated by owner and never adopts another owner's app", async () => {
    const t = createTest();
    const sharedClientMsgId = "build:cross-owner-0001";
    const owners = [
      { subject: "build-owner-a", generation: "generation-owner-a" },
      { subject: "build-owner-b", generation: "generation-owner-b" },
    ];
    for (const owner of owners) {
      await seedGeneration(t, ownerIdFor(owner.subject), owner.generation);
    }
    const first = await identity(t, owners[0]!.subject).mutation(
      startAppBuildTurn,
      {
        prompt: "Owner A app.",
        appId: "app-owner-a-0001",
        clientMsgId: sharedClientMsgId,
        expectedOwnerGeneration: owners[0]!.generation,
      },
    );
    const second = await identity(t, owners[1]!.subject).mutation(
      startAppBuildTurn,
      {
        prompt: "Owner B app.",
        appId: "app-owner-b-0001",
        clientMsgId: sharedClientMsgId,
        expectedOwnerGeneration: owners[1]!.generation,
      },
    );
    expect(second.turnId).not.toBe(first.turnId);
    expect(second.conversationId).not.toBe(first.conversationId);

    await expect(
      identity(t, owners[1]!.subject).mutation(startAppBuildTurn, {
        prompt: "Owner B on A's app.",
        appId: "app-owner-a-0001",
        clientMsgId: "build:cross-owner-0002",
        expectedOwnerGeneration: owners[1]!.generation,
      }),
    ).rejects.toThrow(/App not found/u);
    await expect(
      identity(t, owners[1]!.subject).mutation(startAppBuildTurn, {
        prompt: "Bad id.",
        appId: "x",
        expectedOwnerGeneration: owners[1]!.generation,
      }),
    ).rejects.toThrow(/App not found/u);
  });
});
