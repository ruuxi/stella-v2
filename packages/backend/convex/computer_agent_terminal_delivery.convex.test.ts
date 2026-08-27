/// <reference types="vite/client" />

import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const OWNER_ID = "https://issuer.test|computer-agent-owner";
const CONVERSATION_ID = "computer-agent-conversation";
const DEVICE_ID = "computer-agent-device";
const THREAD_ID = "computer-agent-thread";
const OWNER_GENERATION = "owner-generation-a";

const start = makeFunctionReference<"mutation">(
  "local_agent_threads:startMyComputerAgentThread",
);
const complete = makeFunctionReference<"mutation">(
  "local_agent_threads:completeMyComputerAgentThread",
);
const cancel = makeFunctionReference<"mutation">(
  "local_agent_threads:cancelMyComputerAgentThread",
);
const list = makeFunctionReference<"query">(
  "cloud_apps:listMyDeviceAgentThreads",
);
const acknowledge = makeFunctionReference<"mutation">(
  "cloud_apps:acknowledgeMyDeviceAgentThreadDelivery",
);

const createTest = () => {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
};

const asOwner = (t: ReturnType<typeof createTest>) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "computer-agent-owner",
    tokenIdentifier: OWNER_ID,
    iat: 1_000,
  });

describe("computer-agent terminal delivery receipts", () => {
  it("replays only the exact start intent and rejects stale, gapped, or ABA input", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId: OWNER_ID,
        generation: OWNER_GENERATION,
        state: "open",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("cloud_conversations", {
        conversationId: CONVERSATION_ID,
        ownerId: OWNER_ID,
        title: "Computer agent",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const owner = asOwner(t);
    const first = {
      threadId: THREAD_ID,
      conversationId: CONVERSATION_ID,
      originDeviceId: DEVICE_ID,
      description: "Exact request",
      agentType: "general",
      attemptGeneration: 1,
      ownerGeneration: OWNER_GENERATION,
    } as const;
    await expect(owner.mutation(start, first)).resolves.toEqual({
      agentId: THREAD_ID,
    });
    await expect(owner.mutation(start, first)).resolves.toEqual({
      agentId: THREAD_ID,
    });
    await expect(
      owner.mutation(start, { ...first, description: "ABA replacement" }),
    ).rejects.toThrow(/different input/iu);
    const gapError = await owner
      .mutation(start, { ...first, attemptGeneration: 3 })
      .catch((error: unknown) => error);
    expect(gapError).toMatchObject({
      data: {
        code: "COMPUTER_AGENT_START_REJECTED",
        reason: "attempt_not_next",
        message: "Computer agent attempt generation is not next.",
      },
    });
    await owner.mutation(start, {
      ...first,
      description: "Second attempt",
      attemptGeneration: 2,
    });
    await expect(owner.mutation(start, first)).rejects.toThrow(/stale/iu);

    await expect(
      owner.mutation(cancel, {
        threadId: THREAD_ID,
        ownerGeneration: OWNER_GENERATION,
        originDeviceId: DEVICE_ID,
        attemptGeneration: 1,
      }),
    ).resolves.toEqual({ canceled: false, status: "running" });
    await expect(
      owner.mutation(cancel, {
        threadId: THREAD_ID,
        ownerGeneration: OWNER_GENERATION,
        originDeviceId: DEVICE_ID,
        attemptGeneration: 2,
      }),
    ).resolves.toEqual({ canceled: true, status: "canceled" });
  });

  it("keeps every generation unacknowledged until its exact terminal revision is durably ACKed", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId: OWNER_ID,
        generation: OWNER_GENERATION,
        state: "open",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("cloud_conversations", {
        conversationId: CONVERSATION_ID,
        ownerId: OWNER_ID,
        title: "Computer agent",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const owner = asOwner(t);

    await owner.mutation(start, {
      threadId: THREAD_ID,
      conversationId: CONVERSATION_ID,
      originDeviceId: DEVICE_ID,
      description: "Inspect the workspace",
      agentType: "general",
      attemptGeneration: 1,
      ownerGeneration: OWNER_GENERATION,
    });
    const running = (await owner.query(list, {
      originDeviceId: DEVICE_ID,
      ownerGeneration: OWNER_GENERATION,
      limit: 10,
    })) as Array<Record<string, unknown>>;
    expect(running).toMatchObject([
      {
        threadId: THREAD_ID,
        attemptGeneration: 1,
        status: "running",
        originDeliveryAckAt: null,
      },
    ]);

    await owner.mutation(complete, {
      threadId: THREAD_ID,
      originDeviceId: DEVICE_ID,
      attemptGeneration: 1,
      ownerGeneration: OWNER_GENERATION,
      status: "completed",
      result: "Generation one done.",
    });
    const [generationOne] = (await owner.query(list, {
      originDeviceId: DEVICE_ID,
      ownerGeneration: OWNER_GENERATION,
      limit: 10,
    })) as Array<Record<string, unknown>>;
    expect(generationOne).toMatchObject({
      attemptGeneration: 1,
      status: "completed",
    });
    const generationOneUpdatedAt = generationOne?.updatedAt as number;

    await owner.mutation(acknowledge, {
      threadId: THREAD_ID,
      originDeviceId: DEVICE_ID,
      attemptGeneration: 1,
      ownerGeneration: OWNER_GENERATION,
      terminalUpdatedAt: generationOneUpdatedAt,
    });
    expect(
      await owner.query(list, {
        originDeviceId: DEVICE_ID,
        ownerGeneration: OWNER_GENERATION,
        limit: 10,
      }),
    ).toEqual([]);

    await owner.mutation(start, {
      threadId: THREAD_ID,
      conversationId: CONVERSATION_ID,
      originDeviceId: DEVICE_ID,
      description: "Inspect the workspace again",
      agentType: "general",
      attemptGeneration: 2,
      ownerGeneration: OWNER_GENERATION,
    });
    await owner.mutation(complete, {
      threadId: THREAD_ID,
      originDeviceId: DEVICE_ID,
      attemptGeneration: 2,
      ownerGeneration: OWNER_GENERATION,
      status: "completed",
      result: "Generation two done.",
    });
    const [generationTwo] = (await owner.query(list, {
      originDeviceId: DEVICE_ID,
      ownerGeneration: OWNER_GENERATION,
      limit: 10,
    })) as Array<Record<string, unknown>>;
    expect(generationTwo).toMatchObject({
      attemptGeneration: 2,
      status: "completed",
      originDeliveryAckAt: null,
    });

    const staleAck = (await owner.mutation(acknowledge, {
      threadId: THREAD_ID,
      originDeviceId: DEVICE_ID,
      attemptGeneration: 1,
      ownerGeneration: OWNER_GENERATION,
      terminalUpdatedAt: generationOneUpdatedAt,
    })) as Record<string, unknown>;
    expect(staleAck).toEqual({
      acknowledged: false,
      acknowledgedAt: null,
      superseded: true,
    });
    expect(
      (await owner.query(list, {
        originDeviceId: DEVICE_ID,
        ownerGeneration: OWNER_GENERATION,
        limit: 10,
      })) as Array<Record<string, unknown>>,
    ).toMatchObject([{ attemptGeneration: 2, status: "completed" }]);

    await owner.mutation(acknowledge, {
      threadId: THREAD_ID,
      originDeviceId: DEVICE_ID,
      attemptGeneration: 2,
      ownerGeneration: OWNER_GENERATION,
      terminalUpdatedAt: generationTwo?.updatedAt as number,
    });
    expect(
      await owner.query(list, {
        originDeviceId: DEVICE_ID,
        ownerGeneration: OWNER_GENERATION,
        limit: 10,
      }),
    ).toEqual([]);
  });

  it("rejects generation N after reset and permits the same thread id only in N+1 after purge", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId: OWNER_ID,
        generation: OWNER_GENERATION,
        state: "open",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("cloud_conversations", {
        conversationId: CONVERSATION_ID,
        ownerId: OWNER_ID,
        title: "Computer agent",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const owner = asOwner(t);

    await owner.mutation(start, {
      threadId: THREAD_ID,
      conversationId: CONVERSATION_ID,
      originDeviceId: DEVICE_ID,
      description: "Generation N",
      agentType: "general",
      attemptGeneration: 1,
      ownerGeneration: OWNER_GENERATION,
    });

    const ownerGenerationTwo = "owner-generation-b";
    await t.run(async (ctx) => {
      const lifecycle = await ctx.db
        .query("cloud_owner_lifecycles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER_ID))
        .unique();
      if (!lifecycle) throw new Error("missing owner lifecycle");
      await ctx.db.patch(lifecycle._id, {
        generation: ownerGenerationTwo,
        updatedAt: 2,
      });
    });

    await expect(
      owner.mutation(complete, {
        threadId: THREAD_ID,
        originDeviceId: DEVICE_ID,
        attemptGeneration: 1,
        ownerGeneration: OWNER_GENERATION,
        status: "completed",
        result: "stale",
      }),
    ).rejects.toThrow("OWNER_DATA_GENERATION_STALE");
    await expect(
      owner.query(list, {
        originDeviceId: DEVICE_ID,
        ownerGeneration: OWNER_GENERATION,
        limit: 10,
      }),
    ).rejects.toThrow("OWNER_DATA_GENERATION_STALE");

    // The reset purge removes generation N before reopening N+1. Reusing the
    // mutable thread id is safe only after that exact old row is gone.
    await t.run(async (ctx) => {
      const staleThread = await ctx.db
        .query("cloud_agent_threads")
        .withIndex("by_threadId", (q) => q.eq("threadId", THREAD_ID))
        .unique();
      if (staleThread) await ctx.db.delete(staleThread._id);
    });
    await owner.mutation(start, {
      threadId: THREAD_ID,
      conversationId: CONVERSATION_ID,
      originDeviceId: DEVICE_ID,
      description: "Generation N+1",
      agentType: "general",
      attemptGeneration: 1,
      ownerGeneration: ownerGenerationTwo,
    });
    expect(
      await owner.query(list, {
        originDeviceId: DEVICE_ID,
        ownerGeneration: ownerGenerationTwo,
        limit: 10,
      }),
    ).toMatchObject([
      {
        threadId: THREAD_ID,
        ownerGeneration: ownerGenerationTwo,
        attemptGeneration: 1,
        status: "running",
      },
    ]);
  });
});
