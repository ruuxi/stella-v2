/// <reference types="vite/client" />

import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const actorOwnerId = "https://issuer.test|social-actor";

const createTest = () => {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
};

const asActor = (t: ReturnType<typeof createTest>) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "social-actor",
    tokenIdentifier: actorOwnerId,
  });

const insertAcceptedRelationship = async (
  t: ReturnType<typeof createTest>,
  otherOwnerId: string,
) => {
  await t.run(async (ctx) => {
    const [lowOwnerId, highOwnerId] = [actorOwnerId, otherOwnerId].sort(
      (a, b) => a.localeCompare(b),
    );
    await ctx.db.insert("social_relationships", {
      relationshipKey: `${lowOwnerId}:${highOwnerId}`,
      lowOwnerId,
      highOwnerId,
      requesterOwnerId: actorOwnerId,
      addresseeOwnerId: otherOwnerId,
      initiatedByOwnerId: actorOwnerId,
      status: "accepted",
      createdAt: 1,
      updatedAt: 1,
      respondedAt: 1,
    });
  });
};

describe("social cross-owner lifecycle fencing", () => {
  it("does not create a relationship naming an owner whose reset is active", async () => {
    const t = createTest();
    const targetOwnerId = "social-reset-target";
    await t.run(async (ctx) => {
      await ctx.db.insert("social_profiles", {
        ownerId: targetOwnerId,
        username: "reset-target",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    await t.mutation(internal.owner_lifecycle.beginOwnerDataPurgeInternal, {
      ownerId: targetOwnerId,
      operationId: "reset-social-target",
      mode: "reset",
      now: 10_000,
    });

    await expect(
      asActor(t).mutation(api.social.relationships.sendFriendRequest, {
        username: "reset-target",
      }),
    ).rejects.toThrow(/data is being reset/u);

    await t.run(async (ctx) => {
      expect(await ctx.db.query("social_relationships").collect()).toEqual([]);
      expect(
        (await ctx.db.query("social_profiles").collect()).map(
          (profile) => profile.ownerId,
        ),
      ).toEqual([targetOwnerId]);
    });
  });

  it("does not create a DM room or membership for an owner being deleted", async () => {
    const t = createTest();
    const targetOwnerId = "social-delete-target";
    await insertAcceptedRelationship(t, targetOwnerId);
    await t.mutation(internal.owner_lifecycle.beginOwnerDataPurgeInternal, {
      ownerId: targetOwnerId,
      operationId: "delete-social-target",
      mode: "delete",
      now: 20_000,
    });

    await expect(
      asActor(t).mutation(api.social.rooms.getOrCreateDmRoom, {
        otherOwnerId: targetOwnerId,
      }),
    ).rejects.toThrow(/being deleted/u);

    await t.run(async (ctx) => {
      expect(await ctx.db.query("social_rooms").collect()).toEqual([]);
      expect(await ctx.db.query("social_room_members").collect()).toEqual([]);
      expect(await ctx.db.query("stella_session_members").collect()).toEqual(
        [],
      );
    });
  });

  it("does not fan out group rows to either side of an active migration", async () => {
    const t = createTest();
    const fromOwnerId = "social-migration-source";
    const toOwnerId = "social-migration-destination";
    await insertAcceptedRelationship(t, fromOwnerId);
    await insertAcceptedRelationship(t, toOwnerId);
    await t.mutation(internal.auth_migration.prepareOwnershipMigration, {
      fromOwnerId,
      toOwnerId,
    });
    await t.mutation(internal.auth_migration.claimOwnershipMigration, {
      fromOwnerId,
      toOwnerId,
      leaseId: "social-migration-lease",
      now: 30_000,
    });

    await expect(
      asActor(t).mutation(api.social.rooms.createGroupRoom, {
        title: "Must not be created",
        memberOwnerIds: [fromOwnerId, toOwnerId],
      }),
    ).rejects.toThrow(/linked to an account/u);

    await t.run(async (ctx) => {
      expect(await ctx.db.query("social_rooms").collect()).toEqual([]);
      expect(await ctx.db.query("social_room_members").collect()).toEqual([]);
      expect(await ctx.db.query("stella_session_members").collect()).toEqual(
        [],
      );
    });
  });
});
