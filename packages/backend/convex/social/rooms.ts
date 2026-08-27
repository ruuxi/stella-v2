import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { ConvexError, v } from "convex/values";
import {
  socialMessageValidator,
  socialProfileValidator,
  socialRoomMemberValidator,
  socialRoomValidator,
  ensureRelationshipIsAccepted,
  ensureSocialProfileDoc,
  getRelationshipKey,
  getSocialProfileByOwnerId,
  listAcceptedRelationshipsForOwner,
  loadRelationship,
  requireRoomMembership,
} from "./shared";
import { requireBoundedString } from "../shared_validators";
import {
  assertOwnerMigrationWriteAllowed,
  getConnectedUserIdOrNull,
  requireConnectedUserId,
} from "../auth";
import {
  enforceMutationRateLimit,
  RATE_HOT_PATH,
  RATE_STANDARD,
  RATE_VERY_EXPENSIVE,
} from "../lib/rate_limits";
import { assertC8RetiredSurfaceUnavailable } from "../lib/c8_retired_surface";

const roomSummaryValidator = v.object({
  room: socialRoomValidator,
  membership: socialRoomMemberValidator,
  latestMessage: v.union(v.null(), socialMessageValidator),
  memberProfiles: v.array(socialProfileValidator),
});

const optionalRoomSummaryValidator = v.union(v.null(), roomSummaryValidator);

// Cap on member rows hydrated for a single room summary. Group rooms can grow,
// so this keeps the query bounded; over-cap rooms simply truncate the
// member-profile preview.
const MAX_ROOM_MEMBERS_HYDRATED = 500;

// A single group mutation fans out into relationship/profile reads and one or
// more membership/session writes per invited owner. Keep each transaction
// comfortably below Convex's document limits even if the caller submits a
// very large array.
export const MAX_GROUP_MEMBER_FANOUT = 50;

const assertGroupMemberFanoutWithinLimit = (memberOwnerIds: string[]) => {
  if (memberOwnerIds.length > MAX_GROUP_MEMBER_FANOUT) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `At most ${MAX_GROUP_MEMBER_FANOUT} members can be added at once`,
    });
  }
};

const GLOBAL_CHAT_DISABLED_ERROR = "Global Chat is disabled.";

type SocialProfileCache = Map<string, Promise<Doc<"social_profiles"> | null>>;

const getCachedSocialProfileByOwnerId = async (
  ctx: QueryCtx,
  cache: SocialProfileCache | undefined,
  ownerId: string,
) => {
  if (!cache) {
    return await getSocialProfileByOwnerId(ctx, ownerId);
  }
  let pending = cache.get(ownerId);
  if (!pending) {
    pending = getSocialProfileByOwnerId(ctx, ownerId);
    cache.set(ownerId, pending);
  }
  return await pending;
};

const hydrateRoomSummary = async (
  ctx: QueryCtx,
  room: Doc<"social_rooms"> | null,
  membership: Doc<"social_room_members">,
  profileCache?: SocialProfileCache,
) => {
  if (!room) {
    return null;
  }
  // Global rooms have no bounded member preview, so resolve senders on demand
  // if an older room summary is ever hydrated.
  const isGlobalRoom = room.kind === "global";
  const [memberDocs, latestMessage] = await Promise.all([
    isGlobalRoom
      ? Promise.resolve([] as Doc<"social_room_members">[])
      : ctx.db
          .query("social_room_members")
          .withIndex("by_roomId_and_joinedAt", (q) => q.eq("roomId", room._id))
          .take(MAX_ROOM_MEMBERS_HYDRATED),
    ctx.db
      .query("social_messages")
      .withIndex("by_roomId_and_createdAt", (q) => q.eq("roomId", room._id))
      .order("desc")
      .first(),
  ]);
  const memberProfiles = await Promise.all(
    memberDocs.map(
      async (member) =>
        await getCachedSocialProfileByOwnerId(
          ctx,
          profileCache,
          member.ownerId,
        ),
    ),
  );
  return {
    room,
    membership,
    latestMessage: latestMessage ?? null,
    memberProfiles: memberProfiles.filter(
      (profile): profile is NonNullable<typeof profile> => Boolean(profile),
    ),
  };
};

const assertRoomOwnerRole = (membership: { role: "owner" | "member" }) => {
  if (membership.role !== "owner") {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "Only the room owner can perform this action",
    });
  }
};

const createRoomMembership = async (
  ctx: MutationCtx,
  roomId: Id<"social_rooms">,
  ownerId: string,
  role: "owner" | "member",
) => {
  await assertOwnerMigrationWriteAllowed(ctx, ownerId);
  const now = Date.now();
  return await ctx.db.insert("social_room_members", {
    roomId,
    ownerId,
    role,
    joinedAt: now,
    lastReadAt: now,
    updatedAt: now,
  });
};

const attachMemberToActiveSession = async (
  ctx: MutationCtx,
  roomId: Id<"social_rooms">,
  ownerId: string,
) => {
  await assertOwnerMigrationWriteAllowed(ctx, ownerId);
  const room = await ctx.db.get(roomId);
  if (!room?.stellaSessionId) {
    return;
  }
  const session = await ctx.db.get(room.stellaSessionId);
  if (!session || session.status === "ended") {
    return;
  }
  const existingMembership = await ctx.db
    .query("stella_session_members")
    .withIndex("by_sessionId_and_ownerId", (q) =>
      q.eq("sessionId", session._id).eq("ownerId", ownerId),
    )
    .unique();
  if (existingMembership) {
    return;
  }
  const now = Date.now();
  await ctx.db.insert("stella_session_members", {
    sessionId: session._id,
    ownerId,
    joinedAt: now,
    lastAppliedFileOpOrdinal: 0,
    updatedAt: now,
  });
};

export const listRooms = query({
  args: {},
  returns: v.array(roomSummaryValidator),
  handler: async (ctx) => {
    const ownerId = await getConnectedUserIdOrNull(ctx);
    if (!ownerId) {
      return [];
    }
    const memberships = await ctx.db
      .query("social_room_members")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(200);
    const profileCache: SocialProfileCache = new Map();
    const summaries = await Promise.all(
      memberships.map(async (membership) => {
        const room = await ctx.db.get(membership.roomId);
        return await hydrateRoomSummary(ctx, room, membership, profileCache);
      }),
    );
    // Global Chat is rendered as a pinned entry in the sidebar; exclude it
    // from the per-user room list so it isn't shown twice.
    return summaries.filter(
      (entry): entry is NonNullable<typeof entry> =>
        Boolean(entry) && entry!.room.kind !== "global",
    );
  },
});

export const getGlobalRoomSummary = query({
  args: {},
  returns: optionalRoomSummaryValidator,
  handler: async (ctx) => {
    const ownerId = await getConnectedUserIdOrNull(ctx);
    if (!ownerId) {
      return null;
    }
    return null;
  },
});

export const getOrJoinGlobalRoom = mutation({
  args: {},
  returns: socialRoomValidator,
  handler: async (ctx) => {
    assertC8RetiredSurfaceUnavailable("Social rooms");
    await requireConnectedUserId(ctx);
    throw new ConvexError({
      code: "FORBIDDEN",
      message: GLOBAL_CHAT_DISABLED_ERROR,
    });
  },
});

export const getRoom = query({
  args: { roomId: v.id("social_rooms") },
  returns: optionalRoomSummaryValidator,
  handler: async (ctx, args) => {
    const ownerId = await getConnectedUserIdOrNull(ctx);
    if (!ownerId) {
      return null;
    }
    const membership = await ctx.db
      .query("social_room_members")
      .withIndex("by_roomId_and_ownerId", (q) =>
        q.eq("roomId", args.roomId).eq("ownerId", ownerId),
      )
      .unique();
    if (!membership) {
      return null;
    }
    const room = await ctx.db.get(args.roomId);
    if (room?.kind === "global") {
      return null;
    }
    return await hydrateRoomSummary(ctx, room, membership);
  },
});

export const getOrCreateDmRoom = mutation({
  args: {
    otherOwnerId: v.string(),
  },
  returns: socialRoomValidator,
  handler: async (ctx, args) => {
    assertC8RetiredSurfaceUnavailable("Social rooms");
    const ownerId = await requireConnectedUserId(ctx);
    await assertOwnerMigrationWriteAllowed(ctx, ownerId);
    await enforceMutationRateLimit(
      ctx,
      "social_get_or_create_dm_room",
      ownerId,
      RATE_STANDARD,
      "Too many room requests. Please slow down and try again.",
    );
    if (ownerId === args.otherOwnerId) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Cannot create a DM with yourself",
      });
    }
    // Verify friendship before ensuring profiles so this mutation can't be
    // used to mint profile rows for arbitrary ownerId strings.
    const relationship = await loadRelationship(
      ctx,
      ownerId,
      args.otherOwnerId,
    );
    ensureRelationshipIsAccepted(relationship);
    await assertOwnerMigrationWriteAllowed(ctx, args.otherOwnerId);
    await ensureSocialProfileDoc(ctx, ownerId);
    await ensureSocialProfileDoc(ctx, args.otherOwnerId);

    const roomKey = `dm:${getRelationshipKey(ownerId, args.otherOwnerId)}`;
    const room = await ctx.db
      .query("social_rooms")
      .withIndex("by_roomKey", (q) => q.eq("roomKey", roomKey))
      .unique();
    if (room) {
      return room;
    }

    const now = Date.now();
    const [dmLowOwnerId, dmHighOwnerId] = [ownerId, args.otherOwnerId].sort(
      (left, right) => left.localeCompare(right),
    );
    const roomId = await ctx.db.insert("social_rooms", {
      kind: "dm",
      roomKey,
      dmLowOwnerId,
      dmHighOwnerId,
      createdByOwnerId: ownerId,
      createdAt: now,
      updatedAt: now,
      latestMessageAt: now,
    });
    await Promise.all([
      createRoomMembership(ctx, roomId, ownerId, "owner"),
      createRoomMembership(ctx, roomId, args.otherOwnerId, "member"),
    ]);
    const created = await ctx.db.get(roomId);
    if (!created) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Failed to create DM room",
      });
    }
    return created;
  },
});

export const createGroupRoom = mutation({
  args: {
    title: v.string(),
    memberOwnerIds: v.array(v.string()),
  },
  returns: socialRoomValidator,
  handler: async (ctx, args) => {
    assertC8RetiredSurfaceUnavailable("Social rooms");
    const ownerId = await requireConnectedUserId(ctx);
    assertGroupMemberFanoutWithinLimit(args.memberOwnerIds);
    await assertOwnerMigrationWriteAllowed(ctx, ownerId);
    // Each call writes N membership rows; cap so we can't be used to spawn
    // unbounded room/membership churn.
    await enforceMutationRateLimit(
      ctx,
      "social_create_group_room",
      ownerId,
      RATE_VERY_EXPENSIVE,
      "Too many group rooms created. Please wait a minute and try again.",
    );
    const title = args.title.trim();
    if (!title) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "title is required",
      });
    }
    requireBoundedString(title, "title", 120);

    const uniqueMemberOwnerIds = [
      ...new Set(
        args.memberOwnerIds.filter((value) => value && value !== ownerId),
      ),
    ];
    const acceptedRelationships = await listAcceptedRelationshipsForOwner(
      ctx,
      ownerId,
    );
    const acceptedOwnerIds = new Set(
      acceptedRelationships.map((relationship) =>
        relationship.lowOwnerId === ownerId
          ? relationship.highOwnerId
          : relationship.lowOwnerId,
      ),
    );

    for (const memberOwnerId of uniqueMemberOwnerIds) {
      if (!acceptedOwnerIds.has(memberOwnerId)) {
        throw new ConvexError({
          code: "FORBIDDEN",
          message: "Only friends can be invited to a group",
        });
      }
    }
    await Promise.all(
      uniqueMemberOwnerIds.map((memberOwnerId) =>
        assertOwnerMigrationWriteAllowed(ctx, memberOwnerId),
      ),
    );
    for (const memberOwnerId of uniqueMemberOwnerIds) {
      await ensureSocialProfileDoc(ctx, memberOwnerId);
    }

    const now = Date.now();
    const roomId = await ctx.db.insert("social_rooms", {
      kind: "group",
      title,
      createdByOwnerId: ownerId,
      createdAt: now,
      updatedAt: now,
      latestMessageAt: now,
    });

    await createRoomMembership(ctx, roomId, ownerId, "owner");
    await Promise.all(
      uniqueMemberOwnerIds.map(async (memberOwnerId) => {
        await createRoomMembership(ctx, roomId, memberOwnerId, "member");
      }),
    );

    const room = await ctx.db.get(roomId);
    if (!room) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Failed to create group room",
      });
    }
    return room;
  },
});

export const addGroupMembers = mutation({
  args: {
    roomId: v.id("social_rooms"),
    memberOwnerIds: v.array(v.string()),
  },
  returns: socialRoomValidator,
  handler: async (ctx, args) => {
    assertC8RetiredSurfaceUnavailable("Social rooms");
    const ownerId = await requireConnectedUserId(ctx);
    assertGroupMemberFanoutWithinLimit(args.memberOwnerIds);
    await assertOwnerMigrationWriteAllowed(ctx, ownerId);
    await enforceMutationRateLimit(
      ctx,
      "social_add_group_members",
      ownerId,
      RATE_STANDARD,
      "Too many group membership changes. Please slow down and try again.",
    );
    const membership = await requireRoomMembership(ctx, args.roomId, ownerId);
    assertRoomOwnerRole(membership);
    const room = await ctx.db.get(args.roomId);
    if (!room || room.kind !== "group") {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Group room not found",
      });
    }

    const candidateOwnerIds = [...new Set(args.memberOwnerIds)].filter(
      (memberOwnerId) => memberOwnerId !== ownerId,
    );
    const acceptedRelationships = await listAcceptedRelationshipsForOwner(
      ctx,
      ownerId,
    );
    const acceptedOwnerIds = new Set(
      acceptedRelationships.map((relationship) =>
        relationship.lowOwnerId === ownerId
          ? relationship.highOwnerId
          : relationship.lowOwnerId,
      ),
    );
    for (const memberOwnerId of candidateOwnerIds) {
      if (!acceptedOwnerIds.has(memberOwnerId)) {
        throw new ConvexError({
          code: "FORBIDDEN",
          message: "Only friends can be invited to a group",
        });
      }
    }
    await Promise.all(
      candidateOwnerIds.map((memberOwnerId) =>
        assertOwnerMigrationWriteAllowed(ctx, memberOwnerId),
      ),
    );
    await Promise.all(
      candidateOwnerIds.map(async (memberOwnerId) => {
        const existing = await ctx.db
          .query("social_room_members")
          .withIndex("by_roomId_and_ownerId", (q) =>
            q.eq("roomId", args.roomId).eq("ownerId", memberOwnerId),
          )
          .unique();
        if (!existing) {
          await createRoomMembership(ctx, args.roomId, memberOwnerId, "member");
          await attachMemberToActiveSession(ctx, args.roomId, memberOwnerId);
        }
      }),
    );

    await ctx.db.patch(args.roomId, {
      updatedAt: Date.now(),
    });
    const updated = await ctx.db.get(args.roomId);
    if (!updated) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Failed to update room",
      });
    }
    return updated;
  },
});

export const markRoomRead = mutation({
  args: {
    roomId: v.id("social_rooms"),
    messageId: v.optional(v.id("social_messages")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertC8RetiredSurfaceUnavailable("Social rooms");
    const ownerId = await requireConnectedUserId(ctx);
    await assertOwnerMigrationWriteAllowed(ctx, ownerId);
    // Hot path (called on every focus / scroll), so use the loose hot-path
    // budget — but still cap it so it can't be looped at runtime to churn
    // the membership row.
    await enforceMutationRateLimit(
      ctx,
      "social_mark_room_read",
      ownerId,
      RATE_HOT_PATH,
    );
    const membership = await requireRoomMembership(ctx, args.roomId, ownerId);
    const room = await ctx.db.get(args.roomId);
    if (room?.kind === "global") {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: GLOBAL_CHAT_DISABLED_ERROR,
      });
    }
    if (args.messageId) {
      const message = await ctx.db.get(args.messageId);
      if (!message || message.roomId !== args.roomId) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: "messageId does not belong to this room",
        });
      }
    }
    await ctx.db.patch(membership._id, {
      ...(args.messageId ? { lastReadMessageId: args.messageId } : {}),
      lastReadAt: Date.now(),
      updatedAt: Date.now(),
    });
    return null;
  },
});
