/// <reference types="vite/client" />

import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { MAX_GROUP_MEMBER_FANOUT } from "./social/rooms";

const modules = import.meta.glob("./**/*.ts");
const ownerId = "https://issuer.test|group-owner";

const createTest = () => {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
};

const asOwner = (t: ReturnType<typeof createTest>) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "group-owner",
    tokenIdentifier: ownerId,
  });

const overLimitOwnerIds = () =>
  Array.from(
    { length: MAX_GROUP_MEMBER_FANOUT + 1 },
    (_, index) => `friend-${index}`,
  );

describe("social group member fanout", () => {
  it("rejects an over-cap create before writing the room", async () => {
    const t = createTest();

    await expect(
      asOwner(t).mutation(api.social.rooms.createGroupRoom, {
        title: "Too large",
        memberOwnerIds: overLimitOwnerIds(),
      }),
    ).rejects.toThrow(
      `At most ${MAX_GROUP_MEMBER_FANOUT} members can be added at once`,
    );

    await t.run(async (ctx) => {
      expect(await ctx.db.query("social_rooms").take(1)).toEqual([]);
      expect(await ctx.db.query("social_room_members").take(1)).toEqual([]);
    });
  });

  it("rejects an over-cap add before reading membership or writing members", async () => {
    const t = createTest();
    const roomId = await t.run(async (ctx) =>
      ctx.db.insert("social_rooms", {
        kind: "group",
        title: "Existing group",
        createdByOwnerId: ownerId,
        createdAt: 1,
        updatedAt: 1,
      }),
    );

    await expect(
      asOwner(t).mutation(api.social.rooms.addGroupMembers, {
        roomId,
        memberOwnerIds: overLimitOwnerIds(),
      }),
    ).rejects.toThrow(
      `At most ${MAX_GROUP_MEMBER_FANOUT} members can be added at once`,
    );

    await t.run(async (ctx) => {
      expect(await ctx.db.query("social_room_members").take(1)).toEqual([]);
      expect((await ctx.db.get(roomId))?.updatedAt).toBe(1);
    });
  });
});
