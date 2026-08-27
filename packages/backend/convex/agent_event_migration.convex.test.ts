/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);

type OwnerIds = { fromOwnerId: string; toOwnerId: string };
type Lease = OwnerIds & {
  leaseId: string;
  leaseGeneration: number;
  leaseNow: number;
};
type PurgeFence = {
  ownerId: string;
  operationId: string;
  generation: string;
};

const prepareOwnershipMigration = makeFunctionReference<
  "mutation",
  OwnerIds,
  null
>("auth_migration:prepareOwnershipMigration");
const claimOwnershipMigration = makeFunctionReference<
  "mutation",
  OwnerIds & { leaseId: string; now: number },
  {
    claimed: boolean;
    terminal: boolean;
    leaseGeneration?: number;
  }
>("auth_migration:claimOwnershipMigration");
const commitCloudConversationTransferBatch = makeFunctionReference<
  "mutation",
  Lease & {
    conversationId: string;
    transferOperationId: string;
    transferPlanFingerprint: string;
    transferStage: string;
  },
  { complete: boolean; progressed: boolean }
>("auth_migration:commitCloudConversationTransferBatch");
const migrateCloudProductCoreBatch = makeFunctionReference<
  "mutation",
  Lease,
  { hasMore: boolean; progressed: boolean }
>("auth_migration:migrateCloudProductCoreBatch");
const auditOwnershipMigrationResidue = makeFunctionReference<
  "query",
  OwnerIds,
  { kind: "clear" | "retry" | "blocked"; table?: string }
>("auth_migration:auditOwnershipMigrationResidue");
const beginOwnerDataPurge = makeFunctionReference<
  "mutation",
  { ownerId: string; operationId: string; mode: "delete"; now: number },
  PurgeFence & { mode: "delete"; stage: "core" | "cloud" | "complete" }
>("owner_lifecycle:beginOwnerDataPurgeInternal");
const claimOwnerPurgeStage = makeFunctionReference<
  "mutation",
  PurgeFence & {
    stage: "core" | "cloud";
    leaseId: string;
    now: number;
  },
  { claimed: boolean; complete: boolean; mode: "delete" }
>("owner_lifecycle:claimOwnerPurgeStageInternal");
const advanceOwnerPurgeStage = makeFunctionReference<
  "mutation",
  PurgeFence & {
    leaseId: string;
    stage: "core";
    nextStage: "cloud";
    now: number;
  },
  boolean
>("owner_lifecycle:advanceOwnerPurgeStageInternal");
const deleteOwnerTurnBatch = makeFunctionReference<
  "mutation",
  PurgeFence,
  { hasMore: boolean }
>("cloud_purge:deleteOwnerTurnBatch");
const deleteOwnerCloudBatch = makeFunctionReference<
  "mutation",
  PurgeFence & { table: "agent_events" },
  { hasMore: boolean }
>("cloud_purge:deleteOwnerCloudBatch");

const beginMigration = async (
  t: ReturnType<typeof createTest>,
  owners: OwnerIds,
  leaseId: string,
): Promise<Lease> => {
  await t.mutation(prepareOwnershipMigration, owners);
  const claim = await t.mutation(claimOwnershipMigration, {
    ...owners,
    leaseId,
    now: 1_000,
  });
  expect(claim).toMatchObject({ claimed: true, terminal: false });
  return {
    ...owners,
    leaseId,
    leaseGeneration: claim.leaseGeneration!,
    leaseNow: 1_001,
  };
};

const beginCloudPurge = async (
  t: ReturnType<typeof createTest>,
  ownerId: string,
): Promise<PurgeFence> => {
  const begun = await t.mutation(beginOwnerDataPurge, {
    ownerId,
    operationId: "post-migration-source-purge",
    mode: "delete",
    now: 2_000,
  });
  const fence = {
    ownerId,
    operationId: begun.operationId,
    generation: begun.generation,
  };
  const coreLeaseId = "source-core-purge-lease";
  expect(
    await t.mutation(claimOwnerPurgeStage, {
      ...fence,
      stage: "core",
      leaseId: coreLeaseId,
      now: 2_001,
    }),
  ).toMatchObject({ claimed: true, complete: false });
  expect(
    await t.mutation(advanceOwnerPurgeStage, {
      ...fence,
      stage: "core",
      nextStage: "cloud",
      leaseId: coreLeaseId,
      now: 2_002,
    }),
  ).toBe(true);
  expect(
    await t.mutation(claimOwnerPurgeStage, {
      ...fence,
      stage: "cloud",
      leaseId: "source-cloud-purge-lease",
      now: 2_003,
    }),
  ).toMatchObject({ claimed: true, complete: false });
  return fence;
};

describe("agent event ownership migration", () => {
  it("moves a bounded per-turn stream before its turn and survives source purge", async () => {
    const t = createTest();
    const owners = {
      fromOwnerId: "anonymous-event-owner",
      toOwnerId: "connected-event-owner",
    };
    const lease = await beginMigration(t, owners, "event-conversation-lease");
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_conversations", {
        conversationId: "event-conversation",
        ownerId: owners.fromOwnerId,
        title: "Event migration",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("agent_turns", {
        turnId: "event-turn",
        sessionId: "event-session",
        ownerId: owners.fromOwnerId,
        conversationId: "event-conversation",
        prompt: "Preserve the event stream",
        status: "complete",
        createdAt: 1,
        updatedAt: 1,
      });
      for (let seq = 0; seq < 201; seq += 1) {
        await ctx.db.insert("agent_events", {
          ownerId: owners.fromOwnerId,
          turnId: "event-turn",
          sessionId: "event-session",
          seq,
          kind: seq % 2 === 0 ? "text_delta" : "tool",
          payloadJson: JSON.stringify({ seq, source: true }),
          createdAt: seq,
        });
      }
      await ctx.db.insert("agent_events", {
        turnId: "event-turn",
        sessionId: "event-session",
        seq: 201,
        kind: "legacy",
        payloadJson: '{"seq":201,"ownerless":true}',
        createdAt: 201,
      });
    });

    const transfer = {
      ...lease,
      conversationId: "event-conversation",
      transferOperationId: "a".repeat(64),
      transferPlanFingerprint: "b".repeat(64),
      transferStage: "conversations",
    };
    await expect(
      t.mutation(commitCloudConversationTransferBatch, transfer),
    ).resolves.toEqual({ complete: false, progressed: true });
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("agent_turns")
          .withIndex("by_turnId", (q) => q.eq("turnId", "event-turn"))
          .unique(),
      ),
    ).toMatchObject({ ownerId: owners.fromOwnerId });

    await expect(
      t.mutation(commitCloudConversationTransferBatch, transfer),
    ).resolves.toEqual({ complete: false, progressed: true });
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("agent_turns")
          .withIndex("by_turnId", (q) => q.eq("turnId", "event-turn"))
          .unique(),
      ),
    ).toMatchObject({ ownerId: owners.toOwnerId });
    await expect(
      t.mutation(commitCloudConversationTransferBatch, transfer),
    ).resolves.toEqual({ complete: true, progressed: true });
    await expect(
      t.mutation(commitCloudConversationTransferBatch, transfer),
    ).resolves.toEqual({ complete: true, progressed: false });

    const beforePurge = await t.run(async (ctx) =>
      ctx.db
        .query("agent_events")
        .withIndex("by_turnId_and_seq", (q) => q.eq("turnId", "event-turn"))
        .collect(),
    );
    expect(beforePurge).toHaveLength(202);
    expect(beforePurge.map((event) => event.ownerId)).toEqual(
      Array.from({ length: 202 }, () => owners.toOwnerId),
    );
    expect(beforePurge.map((event) => event.seq)).toEqual(
      Array.from({ length: 202 }, (_, seq) => seq),
    );
    expect(beforePurge[200]?.payloadJson).toBe(
      '{"seq":200,"source":true}',
    );
    expect(beforePurge[201]?.payloadJson).toBe(
      '{"seq":201,"ownerless":true}',
    );

    const sourceResidueId = await t.run(async (ctx) =>
      ctx.db.insert("agent_events", {
        ownerId: owners.fromOwnerId,
        turnId: "missing-source-turn",
        sessionId: "missing-source-session",
        seq: 0,
        kind: "source-residue",
        payloadJson: '{"purge":true}',
        createdAt: 500,
      }),
    );
    const fence = await beginCloudPurge(t, owners.fromOwnerId);
    await t.mutation(deleteOwnerTurnBatch, fence);
    await t.mutation(deleteOwnerCloudBatch, {
      ...fence,
      table: "agent_events",
    });
    expect(await t.run(async (ctx) => ctx.db.get(sourceResidueId))).toBeNull();
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("agent_events")
          .withIndex("by_turnId_and_seq", (q) => q.eq("turnId", "event-turn"))
          .collect(),
      ),
    ).toEqual(beforePurge);
  });

  it("re-owns source-turn, moved-parent, and parentless residue before readback clears", async () => {
    const t = createTest();
    const owners = {
      fromOwnerId: "anonymous-core-event-owner",
      toOwnerId: "connected-core-event-owner",
    };
    const lease = await beginMigration(t, owners, "event-core-lease");
    await t.run(async (ctx) => {
      const migration = await ctx.db
        .query("auth_owner_migrations")
        .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
          q
            .eq("fromOwnerId", owners.fromOwnerId)
            .eq("toOwnerId", owners.toOwnerId),
        )
        .unique();
      await ctx.db.patch(migration!._id, { cloudProductStage: "core" });
      await ctx.db.insert("agent_turns", {
        turnId: "source-core-turn",
        sessionId: "source-core-session",
        ownerId: owners.fromOwnerId,
        prompt: "Source turn",
        status: "complete",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("agent_events", {
        ownerId: owners.fromOwnerId,
        turnId: "source-core-turn",
        sessionId: "source-core-session",
        seq: 7,
        kind: "source-child",
        payloadJson: '{"preserve":"source-child"}',
        createdAt: 10,
      });
      await ctx.db.insert("agent_turns", {
        turnId: "already-moved-turn",
        sessionId: "already-moved-session",
        ownerId: owners.toOwnerId,
        prompt: "Already moved",
        status: "complete",
        createdAt: 2,
        updatedAt: 2,
      });
      await ctx.db.insert("agent_events", {
        ownerId: owners.fromOwnerId,
        turnId: "already-moved-turn",
        sessionId: "already-moved-session",
        seq: 8,
        kind: "crash-residue",
        payloadJson: '{"preserve":"moved-parent"}',
        createdAt: 20,
      });
      await ctx.db.insert("agent_events", {
        ownerId: owners.fromOwnerId,
        turnId: "missing-core-turn",
        sessionId: "missing-core-session",
        seq: 9,
        kind: "orphan-residue",
        payloadJson: '{"preserve":"parentless"}',
        createdAt: 30,
      });
    });

    await expect(
      t.mutation(migrateCloudProductCoreBatch, lease),
    ).resolves.toEqual({ hasMore: true, progressed: true });
    await expect(
      t.query(auditOwnershipMigrationResidue, owners),
    ).resolves.toEqual({ kind: "retry", table: "agent_events" });
    await expect(
      t.mutation(migrateCloudProductCoreBatch, lease),
    ).resolves.toEqual({ hasMore: true, progressed: true });
    await expect(
      t.mutation(migrateCloudProductCoreBatch, lease),
    ).resolves.toEqual({ hasMore: true, progressed: true });
    await expect(
      t.query(auditOwnershipMigrationResidue, owners),
    ).resolves.toEqual({ kind: "clear" });

    const snapshot = await t.run(async (ctx) => ({
      turns: await ctx.db.query("agent_turns").collect(),
      events: await ctx.db.query("agent_events").collect(),
    }));
    expect(snapshot.turns.map((turn) => turn.ownerId)).toEqual([
      owners.toOwnerId,
      owners.toOwnerId,
    ]);
    expect(snapshot.events.map((event) => event.ownerId)).toEqual([
      owners.toOwnerId,
      owners.toOwnerId,
      owners.toOwnerId,
    ]);
    expect(snapshot.events.map((event) => event.seq).sort()).toEqual([7, 8, 9]);
    expect(snapshot.events.map((event) => event.payloadJson).sort()).toEqual([
      '{"preserve":"moved-parent"}',
      '{"preserve":"parentless"}',
      '{"preserve":"source-child"}',
    ]);
  });

  it("blocks source-attributed residue attached to an unrelated owner's turn", async () => {
    const t = createTest();
    const owners = {
      fromOwnerId: "anonymous-conflict-event-owner",
      toOwnerId: "connected-conflict-event-owner",
    };
    const lease = await beginMigration(t, owners, "event-conflict-lease");
    const eventId = await t.run(async (ctx) => {
      const migration = await ctx.db
        .query("auth_owner_migrations")
        .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
          q
            .eq("fromOwnerId", owners.fromOwnerId)
            .eq("toOwnerId", owners.toOwnerId),
        )
        .unique();
      await ctx.db.patch(migration!._id, { cloudProductStage: "core" });
      await ctx.db.insert("agent_turns", {
        turnId: "foreign-turn",
        sessionId: "foreign-session",
        ownerId: "unrelated-owner",
        prompt: "Foreign",
        status: "complete",
        createdAt: 1,
        updatedAt: 1,
      });
      return await ctx.db.insert("agent_events", {
        ownerId: owners.fromOwnerId,
        turnId: "foreign-turn",
        sessionId: "foreign-session",
        seq: 1,
        kind: "foreign-residue",
        payloadJson: "{}",
        createdAt: 1,
      });
    });

    await expect(
      t.mutation(migrateCloudProductCoreBatch, lease),
    ).rejects.toThrow("belongs to another owner's turn");
    expect(await t.run(async (ctx) => ctx.db.get(eventId))).toMatchObject({
      ownerId: owners.fromOwnerId,
    });
  });
});
