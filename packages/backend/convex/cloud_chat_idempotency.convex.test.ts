/// <reference types="vite/client" />

import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const startCloudChat = makeFunctionReference<"mutation">(
  "cloud_apps:startCloudChat",
);
const startCloudChatInternal = makeFunctionReference<"mutation">(
  "cloud_apps:startCloudChatTurnInternal",
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

const seedConversation = async (
  t: TestHarness,
  ownerId: string,
  conversationId: string,
) => {
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_conversations", {
      ownerId,
      conversationId,
      title: "Reliable chat",
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
        (entry.name.includes("runOrchestratorTurnInternal") ||
          entry.name.includes("runCloudTurnInternal")) &&
        entry.state.kind !== "canceled" &&
        typeof entry.args[0] === "object" &&
        entry.args[0] !== null &&
        (entry.args[0] as { turnId?: unknown; dispatchAttempt?: unknown })
          .turnId === turnId &&
        (entry.args[0] as { dispatchAttempt?: unknown }).dispatchAttempt ===
          undefined,
    ),
  );

describe("cloud chat reliable-delivery authority", () => {
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

  it("replays a lost first-message response with one conversation, turn, and schedule", async () => {
    const t = createTest();
    const subject = "chat-replay-owner";
    const ownerId = ownerIdFor(subject);
    const generation = "generation-chat-replay";
    const clientMsgId = "chat:lost-response-0001";
    await seedGeneration(t, ownerId, generation);
    const args = {
      prompt: "Explain durable delivery in one paragraph.",
      clientMsgId,
      expectedOwnerGeneration: generation,
      locale: "fr",
      attachments: ["images/chart.png"],
    };

    // Treat the first return value as a response that was committed by Convex
    // but lost by the transport. The retry must recover the same receipt.
    const committed = await identity(t, subject).mutation(startCloudChat, args);
    const recovered = await identity(t, subject).mutation(startCloudChat, args);

    expect(recovered).toEqual(committed);
    const turns = await turnsForClient(t, ownerId, clientMsgId);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      ownerId,
      ownerGeneration: generation,
      conversationId: committed.conversationId,
      turnId: committed.turnId,
      prompt: args.prompt,
      clientMsgId,
      kind: "chat",
    });
    expect(turns[0]?.chatIntentFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    await t.run(async (ctx) => {
      const conversations = await ctx.db
        .query("cloud_conversations")
        .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
        .collect();
      expect(conversations).toHaveLength(1);
    });
    expect(await scheduledForTurn(t, committed.turnId)).toHaveLength(1);
  });

  it("fails closed when a client id changes payload or requested conversation authority", async () => {
    const t = createTest();
    const subject = "chat-collision-owner";
    const ownerId = ownerIdFor(subject);
    const generation = "generation-chat-collision";
    const conversationId = "conversation-chat-collision-a";
    const otherConversationId = "conversation-chat-collision-b";
    const clientMsgId = "chat:collision-0001";
    await seedGeneration(t, ownerId, generation);
    await seedConversation(t, ownerId, conversationId);
    await seedConversation(t, ownerId, otherConversationId);
    const first = {
      prompt: "Keep these exact bytes.",
      conversationId,
      clientMsgId,
      expectedOwnerGeneration: generation,
      locale: "en",
      attachments: ["images/a.png"],
    };
    const receipt = await identity(t, subject).mutation(startCloudChat, first);

    await expect(
      identity(t, subject).mutation(startCloudChat, {
        ...first,
        prompt: "These are changed bytes.",
      }),
    ).rejects.toThrow("different request");
    await expect(
      identity(t, subject).mutation(startCloudChat, {
        ...first,
        locale: "fr",
      }),
    ).rejects.toThrow("different request");
    await expect(
      identity(t, subject).mutation(startCloudChat, {
        ...first,
        attachments: ["images/b.png"],
      }),
    ).rejects.toThrow("different request");
    await expect(
      identity(t, subject).mutation(startCloudChat, {
        ...first,
        conversationId: otherConversationId,
      }),
    ).rejects.toThrow("different request");

    expect(await turnsForClient(t, ownerId, clientMsgId)).toHaveLength(1);
    expect(await scheduledForTurn(t, receipt.turnId)).toHaveLength(1);
  });

  it("does not let direct and placement-independent internal authority adopt each other's client id", async () => {
    const t = createTest();
    const subject = "chat-authority-owner";
    const ownerId = ownerIdFor(subject);
    const generation = "generation-chat-authority";
    const conversationId = "conversation-chat-authority";
    const clientMsgId = "chat:authority-0001";
    const prompt = "Keep caller authority distinct.";
    await seedGeneration(t, ownerId, generation);
    await seedConversation(t, ownerId, conversationId);
    const receipt = await identity(t, subject).mutation(startCloudChat, {
      prompt,
      conversationId,
      clientMsgId,
      expectedOwnerGeneration: generation,
    });

    await expect(
      t.mutation(startCloudChatInternal, {
        ownerId,
        ownerGeneration: generation,
        conversationId,
        prompt,
        clientMsgId,
        now: 2,
      }),
    ).rejects.toThrow("different request");
    expect(await turnsForClient(t, ownerId, clientMsgId)).toHaveLength(1);
    expect(await scheduledForTurn(t, receipt.turnId)).toHaveLength(1);
  });

  it("rejects predecessor-generation replay and generation rewriting after reset", async () => {
    const t = createTest();
    const subject = "chat-reset-owner";
    const ownerId = ownerIdFor(subject);
    const beforeReset = "generation-before-reset";
    const afterReset = "generation-after-reset";
    const conversationId = "conversation-chat-reset";
    const clientMsgId = "chat:generation-0001";
    await seedGeneration(t, ownerId, beforeReset);
    await seedConversation(t, ownerId, conversationId);
    const args = {
      prompt: "Do not cross the reset boundary.",
      conversationId,
      clientMsgId,
      expectedOwnerGeneration: beforeReset,
    };
    const receipt = await identity(t, subject).mutation(startCloudChat, args);
    await t.run(async (ctx) => {
      const lifecycle = await ctx.db
        .query("cloud_owner_lifecycles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique();
      expect(lifecycle).not.toBeNull();
      await ctx.db.patch(lifecycle!._id, {
        generation: afterReset,
        updatedAt: 3,
      });
    });

    await expect(
      identity(t, subject).mutation(startCloudChat, args),
    ).rejects.toThrow("started before the account data was reset");
    await expect(
      identity(t, subject).mutation(startCloudChat, {
        ...args,
        expectedOwnerGeneration: afterReset,
      }),
    ).rejects.toThrow("different request");

    expect(await turnsForClient(t, ownerId, clientMsgId)).toHaveLength(1);
    expect(await scheduledForTurn(t, receipt.turnId)).toHaveLength(1);
  });

  it("rejects legacy or duplicate residue instead of guessing replay authority", async () => {
    const t = createTest();
    const subject = "chat-residue-owner";
    const ownerId = ownerIdFor(subject);
    const generation = "generation-chat-residue";
    const conversationId = "conversation-chat-residue";
    await seedGeneration(t, ownerId, generation);
    await seedConversation(t, ownerId, conversationId);
    await t.run(async (ctx) => {
      await ctx.db.insert("agent_turns", {
        turnId: "turn-legacy-residue",
        sessionId: "session-legacy-residue",
        ownerId,
        conversationId,
        prompt: "Legacy residue",
        status: "running",
        lane: "chat",
        kind: "chat",
        agentType: "orchestrator",
        clientMsgId: "chat:legacy-residue",
        createdAt: 1,
        updatedAt: 1,
      });
      for (const suffix of ["a", "b"]) {
        await ctx.db.insert("agent_turns", {
          turnId: `turn-duplicate-${suffix}`,
          sessionId: `session-duplicate-${suffix}`,
          ownerId,
          conversationId,
          prompt: "Duplicate residue",
          status: "running",
          lane: "chat",
          kind: "chat",
          agentType: "orchestrator",
          clientMsgId: "chat:duplicate-residue",
          ownerGeneration: generation,
          chatIntentFingerprint: `${suffix}`.repeat(64),
          createdAt: 1,
          updatedAt: 1,
        });
      }
    });

    await expect(
      identity(t, subject).mutation(startCloudChat, {
        prompt: "Legacy residue",
        conversationId,
        clientMsgId: "chat:legacy-residue",
        expectedOwnerGeneration: generation,
      }),
    ).rejects.toThrow("different request");
    await expect(
      identity(t, subject).mutation(startCloudChat, {
        prompt: "Duplicate residue",
        conversationId,
        clientMsgId: "chat:duplicate-residue",
        expectedOwnerGeneration: generation,
      }),
    ).rejects.toThrow("conflicting prior deliveries");
  });

  it("keeps identical client ids isolated by owner and replays one build app id", async () => {
    const t = createTest();
    const sharedClientMsgId = "chat:cross-owner-0001";
    const owners = [
      { subject: "chat-owner-a", generation: "generation-owner-a" },
      { subject: "chat-owner-b", generation: "generation-owner-b" },
    ];
    for (const owner of owners) {
      await seedGeneration(t, ownerIdFor(owner.subject), owner.generation);
    }
    const first = await identity(t, owners[0]!.subject).mutation(
      startCloudChat,
      {
        prompt: "Owner A message.",
        clientMsgId: sharedClientMsgId,
        expectedOwnerGeneration: owners[0]!.generation,
      },
    );
    const second = await identity(t, owners[1]!.subject).mutation(
      startCloudChat,
      {
        prompt: "Owner B message.",
        clientMsgId: sharedClientMsgId,
        expectedOwnerGeneration: owners[1]!.generation,
      },
    );
    expect(second.turnId).not.toBe(first.turnId);
    expect(second.conversationId).not.toBe(first.conversationId);

    const buildClientMsgId = "chat:build-replay-0001";
    const buildArgs = {
      prompt: "Create a new app that shows one blue square.",
      clientMsgId: buildClientMsgId,
      expectedOwnerGeneration: owners[0]!.generation,
    };
    const build = await identity(t, owners[0]!.subject).mutation(
      startCloudChat,
      buildArgs,
    );
    const replayedBuild = await identity(t, owners[0]!.subject).mutation(
      startCloudChat,
      buildArgs,
    );
    expect(build.appId).toMatch(/^app-/u);
    expect(replayedBuild).toEqual(build);
    expect(
      await turnsForClient(t, ownerIdFor(owners[0]!.subject), buildClientMsgId),
    ).toHaveLength(1);
    await t.run(async (ctx) => {
      expect(
        await ctx.db
          .query("cloud_apps")
          .withIndex("by_appId", (q) => q.eq("appId", build.appId!))
          .unique(),
      ).not.toBeNull();
    });
    expect(await scheduledForTurn(t, build.turnId)).toHaveLength(1);
  });
});
