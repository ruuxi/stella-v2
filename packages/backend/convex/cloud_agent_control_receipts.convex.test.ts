/// <reference types="vite/client" />

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  return t;
};
type TestHarness = ReturnType<typeof createTest>;

const desktopOwnerId = "https://issuer.test|desktop-control-owner";
const desktopOwnerGeneration = "generation:desktop-control";
const desktopOriginDeviceId = "device:desktop-control";
const desktopOriginConversationId = "local:desktop-control";

const asDesktopOwner = (t: TestHarness) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "desktop-control-owner",
    tokenIdentifier: desktopOwnerId,
    iat: 1_000,
  });

const spawnFromDesktop = makeFunctionReference<"mutation">(
  "cloud_apps:spawnCloudAgentFromDesktop",
);
const continueFromDesktop = makeFunctionReference<"mutation">(
  "cloud_apps:continueMyCloudAgentFromDesktop",
);

const seedDesktopOwner = async (
  t: TestHarness,
  conversationId: string,
) => {
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId: desktopOwnerId,
      generation: desktopOwnerGeneration,
      state: "open",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("cloud_conversations", {
      conversationId,
      ownerId: desktopOwnerId,
      title: "Desktop replay",
      createdAt: 10,
      updatedAt: 10,
    });
  });
};

describe("cloud agent control receipts", () => {
  it("replays a lost desktop spawn response before newest-conversation and rate state", async () => {
    const t = createTest();
    const originalConversationId = "conversation:desktop-spawn-original";
    await seedDesktopOwner(t, originalConversationId);
    const request = {
      ownerGeneration: desktopOwnerGeneration,
      clientMsgId: "spawn:desktop-lost-response",
      workspace: "cloud",
      description: "Durable desktop spawn",
      prompt: "Complete the durable desktop task.",
      originDeviceId: desktopOriginDeviceId,
      originConversationId: desktopOriginConversationId,
    };

    const first = await asDesktopOwner(t).mutation(spawnFromDesktop, request);
    expect(first).toMatchObject({
      conversationId: originalConversationId,
      attemptGeneration: 1,
      status: "running",
    });

    // A response-loss retry may arrive after unrelated activity has changed
    // which conversation is newest. That mutable choice must not alter the
    // already-committed delivery's fingerprint or consume a fresh rate slot.
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_conversations", {
        conversationId: "conversation:desktop-spawn-newest",
        ownerId: desktopOwnerId,
        title: "Newer conversation",
        createdAt: first.threadUpdatedAt + 1,
        updatedAt: first.threadUpdatedAt + 1,
      });
    });
    for (let replay = 0; replay < 25; replay += 1) {
      expect(
        await asDesktopOwner(t).mutation(spawnFromDesktop, request),
      ).toEqual(first);
    }
    await expect(
      asDesktopOwner(t).mutation(spawnFromDesktop, {
        ...request,
        conversationId: "conversation:desktop-spawn-newest",
      }),
    ).rejects.toThrow("already used differently");
    await t.run(async (ctx) => {
      const deliveries = await ctx.db
        .query("agent_turns")
        .withIndex("by_ownerId_and_clientMsgId", (q) =>
          q
            .eq("ownerId", desktopOwnerId)
            .eq("clientMsgId", request.clientMsgId),
        )
        .take(2);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.conversationId).toBe(originalConversationId);
      const original = await ctx.db
        .query("cloud_conversations")
        .withIndex("by_conversationId", (q) =>
          q.eq("conversationId", originalConversationId),
        )
        .unique();
      const newest = await ctx.db
        .query("cloud_conversations")
        .withIndex("by_conversationId", (q) =>
          q.eq("conversationId", "conversation:desktop-spawn-newest"),
        )
        .unique();
      expect(original?.updatedAt).toBe(first.threadUpdatedAt);
      expect(newest?.updatedAt).toBe(first.threadUpdatedAt + 1);
    });
  });

  it("replays a desktop continuation after restart before mutable thread and rate state", async () => {
    const t = createTest();
    const conversationId = "conversation:desktop-continue";
    await seedDesktopOwner(t, conversationId);
    const first = await asDesktopOwner(t).mutation(spawnFromDesktop, {
      ownerGeneration: desktopOwnerGeneration,
      clientMsgId: "spawn:desktop-before-continuation",
      workspace: "cloud",
      description: "Initial desktop attempt",
      prompt: "Finish the first attempt.",
      conversationId,
      originDeviceId: desktopOriginDeviceId,
      originConversationId: desktopOriginConversationId,
    });
    const firstTerminalAt = first.threadUpdatedAt + 1;
    await t.run(async (ctx) => {
      const thread = await ctx.db
        .query("cloud_agent_threads")
        .withIndex("by_threadId", (q) => q.eq("threadId", first.threadId))
        .unique();
      expect(thread).not.toBeNull();
      await ctx.db.patch(thread!._id, {
        status: "completed",
        resultJson: JSON.stringify({ ok: true }),
        updatedAt: firstTerminalAt,
      });
    });
    const request = {
      ownerGeneration: desktopOwnerGeneration,
      threadId: first.threadId,
      expectedAttemptGeneration: first.attemptGeneration,
      expectedTerminalUpdatedAt: firstTerminalAt,
      description: "Durable continuation",
      prompt: "Continue from the completed attempt.",
      originDeviceId: desktopOriginDeviceId,
      originConversationId: desktopOriginConversationId,
      controlRequestId: "continue:desktop-lost-response",
    };
    const continued = await asDesktopOwner(t).mutation(
      continueFromDesktop,
      request,
    );
    expect(continued).toMatchObject({
      threadId: first.threadId,
      conversationId,
      attemptGeneration: 2,
      status: "running",
    });

    // Simulate the process losing the response, restarting, and observing an
    // ABA successor before it replays the same durable id. The old attempt's
    // immutable receipt must win without reading or modifying current control.
    await t.run(async (ctx) => {
      const thread = await ctx.db
        .query("cloud_agent_threads")
        .withIndex("by_threadId", (q) => q.eq("threadId", first.threadId))
        .unique();
      expect(thread).not.toBeNull();
      const successorAt = continued.threadUpdatedAt + 1;
      await ctx.db.patch(thread!._id, {
        status: "running",
        attemptGeneration: 3,
        originDeviceId: "device:aba-successor",
        originConversationId: "local:aba-successor",
        resultJson: undefined,
        sandboxLeaseExpiresAt: successorAt + 60_000,
        updatedAt: successorAt,
      });
      await ctx.db.insert("agent_turns", {
        turnId: "turn:desktop-continue-aba-successor",
        sessionId: first.threadId,
        ownerId: desktopOwnerId,
        ownerGeneration: desktopOwnerGeneration,
        attemptGeneration: 3,
        conversationId,
        prompt: "A newer physical attempt",
        status: "running",
        lane: "agent",
        kind: "agent",
        workspace: "drive",
        threadId: first.threadId,
        source: "desktop",
        clientMsgId: "continue:desktop-aba-successor",
        hidden: true,
        createdAt: successorAt,
        updatedAt: successorAt,
      });
    });
    for (let replay = 0; replay < 25; replay += 1) {
      expect(
        await asDesktopOwner(t).mutation(continueFromDesktop, request),
      ).toEqual(continued);
    }
    await expect(
      asDesktopOwner(t).mutation(continueFromDesktop, {
        ...request,
        prompt: "A conflicting continuation payload.",
      }),
    ).rejects.toThrow("already used differently");
    await t.run(async (ctx) => {
      const deliveries = await ctx.db
        .query("agent_turns")
        .withIndex("by_ownerId_and_clientMsgId", (q) =>
          q
            .eq("ownerId", desktopOwnerId)
            .eq("clientMsgId", request.controlRequestId),
        )
        .take(2);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.attemptGeneration).toBe(2);
      const current = await ctx.db
        .query("cloud_agent_threads")
        .withIndex("by_threadId", (q) => q.eq("threadId", first.threadId))
        .unique();
      expect(current).toMatchObject({
        status: "running",
        attemptGeneration: 3,
        originDeviceId: "device:aba-successor",
        originConversationId: "local:aba-successor",
      });
    });
  });

  it("keeps an exact canceled target receipt separate from an ABA successor", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId: "owner:control-receipt",
        generation: "generation:control-receipt",
        state: "open",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("cloud_agent_threads", {
        threadId: "thread:control-receipt",
        ownerId: "owner:control-receipt",
        ownerGeneration: "generation:control-receipt",
        conversationId: "conversation:control-receipt",
        description: "successor",
        workspace: "cloud",
        agentType: "general",
        attemptGeneration: 2,
        status: "running",
        createdAt: 10,
        updatedAt: 300,
      });
      await ctx.db.insert("agent_turns", {
        turnId: "turn:control-receipt:1",
        sessionId: "thread:control-receipt",
        ownerId: "owner:control-receipt",
        ownerGeneration: "generation:control-receipt",
        conversationId: "conversation:control-receipt",
        prompt: "old attempt",
        status: "canceled",
        terminalKind: "canceled",
        errorMessage: JSON.stringify({
          message: "Stopped. Nothing was changed.",
        }),
        kind: "agent",
        threadId: "thread:control-receipt",
        attemptGeneration: 1,
        cancelRequestId: "cancel:control-receipt",
        createdAt: 100,
        updatedAt: 200,
      });
    });

    const control = await t.query(
      internal.cloud_apps.getCloudAgentThreadControlInternal,
      {
        ownerId: "owner:control-receipt",
        ownerGeneration: "generation:control-receipt",
        conversationId: "conversation:control-receipt",
        threadId: "thread:control-receipt",
        controlRequestId: "cancel:control-receipt",
      },
    );
    expect(control).toMatchObject({
      alreadyCanceled: true,
      status: "canceled",
      attemptGeneration: 1,
      threadUpdatedAt: 200,
      currentControl: {
        status: "running",
        attemptGeneration: 2,
        threadUpdatedAt: 300,
      },
    });

    const ack = await t.mutation(
      internal.cloud_apps.cancelCloudAgentTurnInternal,
      {
        ownerId: "owner:control-receipt",
        ownerGeneration: "generation:control-receipt",
        threadId: "thread:control-receipt",
        turnId: "turn:control-receipt:1",
        attemptGeneration: 1,
        controlRequestId: "cancel:control-receipt",
        now: 400,
      },
    );
    expect(ack).toMatchObject({
      canceled: true,
      status: "canceled",
      attemptGeneration: 1,
      threadUpdatedAt: 200,
      currentControl: {
        status: "running",
        attemptGeneration: 2,
        threadUpdatedAt: 300,
      },
    });
  });
});
