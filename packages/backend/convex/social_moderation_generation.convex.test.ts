/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { internal } from "./_generated/api";
import schema from "./schema";
import { SOCIAL_MESSAGE_MODERATION_POLICY } from "./social/messages";
import { seedReadyPurgeBackupSweep } from "../tests/convex_backup_sweep_test_helpers";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);

describe("social moderation generation fencing", () => {
  it("declares the bounded unbilled safety policy and durable dispatch fence", () => {
    expect(SOCIAL_MESSAGE_MODERATION_POLICY).toEqual({
      billing: "unbilled",
      purpose: "safety_control_plane",
      maxInputChars: 20_000,
      rateLimitKey: "social_send_room_message",
      auditOutcomes: ["clean", "censored", "failed"],
    });
    const source = readFileSync(
      new URL("./social/messages.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain(
      "SOCIAL_MESSAGE_MODERATION_POLICY.rateLimitKey,\n      ownerId,\n      RATE_STANDARD",
    );
    expect(source).toContain(
      '"body",\n      SOCIAL_MESSAGE_MODERATION_POLICY.maxInputChars',
    );
    expect(source).toMatch(
      /dispatchGuard: createManagedUsageDispatchGuard\(ctx, \{\s*ownerId: args\.ownerId,\s*ownerGeneration: args\.ownerGeneration,\s*beforeDispatch: assertDispatch,\s*\}\)/u,
    );
    expect(source).not.toContain("scheduleManagedUsage");
  });

  it("persists an exact terminal attempt receipt without user usage billing", async () => {
    const t = createTest();
    const attempt = {
      ownerId: "social-moderation-unbilled-owner",
      ownerGeneration: "legacy",
      executionId: "social-moderation-unbilled-execution",
      attemptId: "social-moderation-unbilled-attempt",
      leaseId: "social-moderation-unbilled-lease",
      now: 100,
    };

    await t.mutation(
      internal.billing.acquireManagedProviderDispatchInternal,
      attempt,
    );
    await expect(
      t.mutation(internal.billing.settleManagedProviderDispatchInternal, {
        ...attempt,
        ownerGeneration: "wrong-generation",
        outcome: "failed",
        now: 200,
      }),
    ).rejects.toThrow(/lost its lease/iu);

    expect(
      await t.mutation(internal.billing.settleManagedProviderDispatchInternal, {
        ...attempt,
        outcome: "failed",
        now: 201,
      }),
    ).toBe(true);

    const { receipt, usage } = await t.run(async (ctx) => ({
      receipt: await ctx.db
        .query("billing_managed_dispatch_leases")
        .withIndex("by_attemptId", (q) => q.eq("attemptId", attempt.attemptId))
        .unique(),
      usage: await ctx.db
        .query("usage_logs")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", attempt.ownerId),
        )
        .take(1),
    }));
    expect(receipt).toMatchObject({
      ownerId: attempt.ownerId,
      ownerGeneration: attempt.ownerGeneration,
      executionId: attempt.executionId,
      attemptId: attempt.attemptId,
      leaseId: attempt.leaseId,
      state: "terminal",
      outcome: "failed",
      terminalAt: 201,
    });
    expect(receipt).not.toHaveProperty("billing");
    expect(usage).toEqual([]);
  });

  it("durably records the terminal moderation audit disposition", async () => {
    const t = createTest();
    const ownerId = "social-moderation-audit-owner";
    const ownerGeneration = "legacy";
    const messageId = await t.run(async (ctx) => {
      const roomId = await ctx.db.insert("social_rooms", {
        kind: "group",
        createdByOwnerId: ownerId,
        createdAt: 1,
        updatedAt: 1,
      });
      return await ctx.db.insert("social_messages", {
        roomId,
        senderOwnerId: ownerId,
        senderOwnerGeneration: ownerGeneration,
        kind: "text",
        body: "pending moderation",
        moderationStatus: "pending",
        createdAt: 1,
      });
    });

    await t.mutation(internal.social.messages.applyMessageModerationInternal, {
      messageId,
      ownerId,
      ownerGeneration,
      originalBody: "pending moderation",
      status: "failed",
    });
    expect(await t.run(async (ctx) => ctx.db.get(messageId))).toMatchObject({
      moderationStatus: "failed",
      moderatedAt: expect.any(Number),
    });
  });

  it("rejects a pre-reset moderation dispatch after reset and reopen", async () => {
    const t = createTest();
    const ownerId = "social-moderation-generation-owner";
    const staleGeneration = "legacy";
    const messageId = await t.run(async (ctx) => {
      const roomId = await ctx.db.insert("social_rooms", {
        kind: "group",
        createdByOwnerId: ownerId,
        createdAt: 1,
        updatedAt: 1,
      });
      return await ctx.db.insert("social_messages", {
        roomId,
        senderOwnerId: ownerId,
        senderOwnerGeneration: staleGeneration,
        kind: "text",
        body: "pending moderation",
        moderationStatus: "pending",
        createdAt: 1,
      });
    });

    expect(
      await t.mutation(
        internal.social.messages.assertMessageModerationDispatchInternal,
        { messageId, ownerId, ownerGeneration: staleGeneration },
      ),
    ).toBe(true);

    const purge = await t.mutation(
      internal.owner_lifecycle.beginOwnerDataPurgeInternal,
      {
        ownerId,
        operationId: "social-moderation-reset",
        mode: "reset",
        now: 10_000,
      },
    );
    await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
      ownerId,
      operationId: purge.operationId,
      generation: purge.generation,
      stage: "core",
      leaseId: "social-core-lease",
      now: 10_001,
    });
    await t.mutation(internal.owner_lifecycle.advanceOwnerPurgeStageInternal, {
      ownerId,
      operationId: purge.operationId,
      generation: purge.generation,
      leaseId: "social-core-lease",
      stage: "core",
      nextStage: "cloud",
      now: 10_002,
    });
    await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
      ownerId,
      operationId: purge.operationId,
      generation: purge.generation,
      stage: "cloud",
      leaseId: "social-cloud-lease",
      now: 10_003,
    });
    const currentGeneration = "social-reopened-generation";
    await t.run(async (ctx) => {
      await seedReadyPurgeBackupSweep(ctx, {
        ownerId,
        operationId: purge.operationId,
        generation: purge.generation,
        now: 10_004,
      });
    });
    expect(
      await t.mutation(internal.owner_lifecycle.finishOwnerCloudPurgeInternal, {
        ownerId,
        operationId: purge.operationId,
        generation: purge.generation,
        leaseId: "social-cloud-lease",
        nextGeneration: currentGeneration,
        now: 10_004,
      }),
    ).toBe(true);

    await expect(
      t.mutation(
        internal.social.messages.assertMessageModerationDispatchInternal,
        { messageId, ownerId, ownerGeneration: staleGeneration },
      ),
    ).rejects.toThrow(/started before the account data was reset/u);

    expect(
      await t.mutation(
        internal.social.messages.assertMessageModerationDispatchInternal,
        { messageId, ownerId, ownerGeneration: currentGeneration },
      ),
    ).toBe(false);
  });
});
