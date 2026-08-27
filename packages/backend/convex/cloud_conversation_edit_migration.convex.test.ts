/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);

const prepare = makeFunctionReference<"mutation", any, any>(
  "auth_migration:prepareOwnershipMigration",
);
const claim = makeFunctionReference<"mutation", any, any>(
  "auth_migration:claimOwnershipMigration",
);
const list = makeFunctionReference<"query", any, any>(
  "auth_migration:listCloudConversationTransferBatch",
);
const commit = makeFunctionReference<"mutation", any, any>(
  "auth_migration:commitCloudConversationTransferBatch",
);

describe("conversation edit ownership migration", () => {
  it("transfers and re-generates an unpublished fork target locator", async () => {
    const t = createTest();
    const owners = { fromOwnerId: "anonymous-owner", toOwnerId: "user-owner" };
    await t.mutation(prepare, owners);
    await t.mutation(claim, {
      ...owners,
      leaseId: "migration-lease",
      now: 1_000,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_conversation_edits", {
        operationId: "edit-operation",
        ownerId: owners.fromOwnerId,
        ownerGeneration: "legacy",
        requestId: "request-1",
        fingerprint: "fingerprint-1",
        kind: "fork",
        state: "preparing",
        sourceConversationId: "published-source",
        targetConversationId: "unpublished-target",
        throughSeq: 1,
        expectedEpoch: 1,
        expectedLastSeq: 3,
        title: "Conversation",
        sourceCreatedAt: 1,
        targetCreatedAt: 2,
        createdAt: 2,
        updatedAt: 2,
      });
    });

    await expect(t.query(list, owners)).resolves.toEqual([
      {
        conversationId: "unpublished-target",
        deleted: false,
        purged: false,
      },
    ]);
    await expect(
      t.mutation(commit, {
        ...owners,
        leaseId: "migration-lease",
        leaseGeneration: 1,
        leaseNow: 1_001,
        conversationId: "unpublished-target",
        transferOperationId: "a".repeat(64),
        transferPlanFingerprint: "b".repeat(64),
        transferStage: "conversations",
      }),
    ).resolves.toEqual({ complete: true, progressed: false });

    const snapshot = await t.run(async (ctx) => ({
      edit: await ctx.db
        .query("cloud_conversation_edits")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", "edit-operation"),
        )
        .unique(),
      migration: await ctx.db
        .query("auth_owner_migrations")
        .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
          q
            .eq("fromOwnerId", owners.fromOwnerId)
            .eq("toOwnerId", owners.toOwnerId),
        )
        .unique(),
    }));
    expect(snapshot.edit).toMatchObject({
      ownerId: owners.toOwnerId,
      ownerGeneration: "legacy",
      targetConversationId: "unpublished-target",
    });
    expect(snapshot.migration?.externalTransferAck).toMatchObject({
      ready: true,
      transferOperationId: "a".repeat(64),
    });
  });
});
