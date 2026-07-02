// Communities — trusted-circle sharing alongside friends.
//
// A community is a named group of users backed by a `social_rooms` row of
// kind "community" plus the usual `social_room_members` rows, so the whole
// existing social stack (messages, moderation, unread markers, add-on share
// cards, Stella sessions) works inside a community without any special
// casing. Joining is by invite code rather than friendship — that is the
// point: a trusted circle wider than your direct friends list.
//
// v1 keeps roles flat: the creator ("owner" membership role) can rename,
// remove members, and delete the community; everyone else is a "member"
// who can post, share, and leave. User-facing copy always says
// "community", never "organization".

import {
  internalMutation,
  mutation,
  type MutationCtx,
} from '../_generated/server'
import { internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import { ConvexError, v } from 'convex/values'
import { socialRoomValidator, ensureSocialProfileDoc } from './shared'
import { requireBoundedString } from '../shared_validators'
import { requireConnectedUserId } from '../auth'
import {
  enforceMutationRateLimit,
  RATE_STANDARD,
  RATE_VERY_EXPENSIVE,
} from '../lib/rate_limits'

// Invite codes avoid visually ambiguous characters (0/O, 1/I/L) so they
// survive being read aloud or hand-typed.
const INVITE_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const INVITE_CODE_LENGTH = 8
const MAX_INVITE_CODE_COLLISION_RETRIES = 24

const MAX_COMMUNITY_NAME_LENGTH = 80

// Rows deleted per purge batch when tearing a community down.
const PURGE_BATCH = 200

const generateInviteCodeCandidate = (): string => {
  let code = ''
  for (let index = 0; index < INVITE_CODE_LENGTH; index += 1) {
    code +=
      INVITE_CODE_ALPHABET[
        Math.floor(Math.random() * INVITE_CODE_ALPHABET.length)
      ]!
  }
  return code
}

const generateUniqueInviteCode = async (ctx: MutationCtx): Promise<string> => {
  for (
    let attempt = 0;
    attempt < MAX_INVITE_CODE_COLLISION_RETRIES;
    attempt += 1
  ) {
    const candidate = generateInviteCodeCandidate()
    const existing = await ctx.db
      .query('social_rooms')
      .withIndex('by_inviteCode', (q) => q.eq('inviteCode', candidate))
      .unique()
    if (!existing) return candidate
  }
  throw new ConvexError({
    code: 'INTERNAL_ERROR',
    message: 'Could not generate an invite code.',
  })
}

/**
 * Accepts pasted codes with stray separators/lowercase ("abcd-efgh") and
 * normalizes to the stored uppercase form.
 */
const normalizeInviteCode = (raw: string): string => {
  const normalized = raw.toUpperCase().replace(/[^0-9A-Z]/g, '')
  if (normalized.length !== INVITE_CODE_LENGTH) {
    throw new ConvexError({
      code: 'INVALID_ARGUMENT',
      message: 'That invite code doesn\u2019t look right. Codes are 8 characters.',
    })
  }
  return normalized
}

const normalizeCommunityName = (raw: string): string => {
  const name = raw.trim()
  if (!name) {
    throw new ConvexError({
      code: 'INVALID_ARGUMENT',
      message: 'Community name is required',
    })
  }
  requireBoundedString(name, 'name', MAX_COMMUNITY_NAME_LENGTH)
  return name
}

const requireCommunityRoom = async (
  ctx: MutationCtx,
  roomId: Id<'social_rooms'>,
): Promise<Doc<'social_rooms'>> => {
  const room = await ctx.db.get(roomId)
  if (!room || room.kind !== 'community') {
    throw new ConvexError({
      code: 'NOT_FOUND',
      message: 'Community not found',
    })
  }
  return room
}

const getCommunityMembership = async (
  ctx: MutationCtx,
  roomId: Id<'social_rooms'>,
  ownerId: string,
) =>
  await ctx.db
    .query('social_room_members')
    .withIndex('by_roomId_and_ownerId', (q) =>
      q.eq('roomId', roomId).eq('ownerId', ownerId),
    )
    .unique()

const requireCommunityMembership = async (
  ctx: MutationCtx,
  roomId: Id<'social_rooms'>,
  ownerId: string,
) => {
  const membership = await getCommunityMembership(ctx, roomId, ownerId)
  if (!membership) {
    throw new ConvexError({
      code: 'NOT_FOUND',
      message: 'Community not found',
    })
  }
  return membership
}

const requireCommunityCreator = async (
  ctx: MutationCtx,
  roomId: Id<'social_rooms'>,
  ownerId: string,
) => {
  const membership = await requireCommunityMembership(ctx, roomId, ownerId)
  if (membership.role !== 'owner') {
    throw new ConvexError({
      code: 'FORBIDDEN',
      message: 'Only the community creator can do that',
    })
  }
  return membership
}

/**
 * Mirror of the room-membership attach in `rooms.addGroupMembers`: if the
 * community has a live Stella session, a newly joined member should see it.
 */
const attachMemberToActiveSession = async (
  ctx: MutationCtx,
  room: Doc<'social_rooms'>,
  ownerId: string,
) => {
  if (!room.stellaSessionId) return
  const session = await ctx.db.get(room.stellaSessionId)
  if (!session || session.status === 'ended') return
  const existing = await ctx.db
    .query('stella_session_members')
    .withIndex('by_sessionId_and_ownerId', (q) =>
      q.eq('sessionId', session._id).eq('ownerId', ownerId),
    )
    .unique()
  if (existing) return
  const now = Date.now()
  await ctx.db.insert('stella_session_members', {
    sessionId: session._id,
    ownerId,
    joinedAt: now,
    lastAppliedFileOpOrdinal: 0,
    updatedAt: now,
  })
}

/** Departing/removed members also lose access to any session on the room. */
const detachMemberFromRoomSessions = async (
  ctx: MutationCtx,
  roomId: Id<'social_rooms'>,
  ownerId: string,
) => {
  const session = await ctx.db
    .query('stella_sessions')
    .withIndex('by_roomId', (q) => q.eq('roomId', roomId))
    .unique()
  if (!session) return
  const membership = await ctx.db
    .query('stella_session_members')
    .withIndex('by_sessionId_and_ownerId', (q) =>
      q.eq('sessionId', session._id).eq('ownerId', ownerId),
    )
    .unique()
  if (membership) {
    await ctx.db.delete(membership._id)
  }
}

export const createCommunity = mutation({
  args: {
    name: v.string(),
  },
  returns: socialRoomValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx)
    await enforceMutationRateLimit(
      ctx,
      'social_create_community',
      ownerId,
      RATE_VERY_EXPENSIVE,
      'Too many communities created. Please wait a minute and try again.',
    )
    const name = normalizeCommunityName(args.name)
    await ensureSocialProfileDoc(ctx, ownerId)

    const now = Date.now()
    const inviteCode = await generateUniqueInviteCode(ctx)
    const roomId = await ctx.db.insert('social_rooms', {
      kind: 'community',
      title: name,
      createdByOwnerId: ownerId,
      inviteCode,
      createdAt: now,
      updatedAt: now,
      latestMessageAt: now,
    })
    await ctx.db.insert('social_room_members', {
      roomId,
      ownerId,
      role: 'owner',
      joinedAt: now,
      lastReadAt: now,
      updatedAt: now,
    })
    const created = await ctx.db.get(roomId)
    if (!created) {
      throw new ConvexError({
        code: 'INTERNAL_ERROR',
        message: 'Failed to create community',
      })
    }
    return created
  },
})

export const joinCommunity = mutation({
  args: {
    inviteCode: v.string(),
  },
  returns: socialRoomValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx)
    // Invite codes are guessable in principle; cap join attempts hard so a
    // client can't brute-force the code space.
    await enforceMutationRateLimit(
      ctx,
      'social_join_community',
      ownerId,
      RATE_VERY_EXPENSIVE,
      'Too many join attempts. Please wait a minute and try again.',
    )
    const inviteCode = normalizeInviteCode(args.inviteCode)
    const room = await ctx.db
      .query('social_rooms')
      .withIndex('by_inviteCode', (q) => q.eq('inviteCode', inviteCode))
      .unique()
    if (!room || room.kind !== 'community') {
      throw new ConvexError({
        code: 'NOT_FOUND',
        message: 'No community found for that invite code',
      })
    }
    await ensureSocialProfileDoc(ctx, ownerId)

    const existing = await getCommunityMembership(ctx, room._id, ownerId)
    if (existing) {
      return room
    }
    const now = Date.now()
    await ctx.db.insert('social_room_members', {
      roomId: room._id,
      ownerId,
      role: 'member',
      joinedAt: now,
      lastReadAt: now,
      updatedAt: now,
    })
    await attachMemberToActiveSession(ctx, room, ownerId)
    await ctx.db.patch(room._id, { updatedAt: now })
    const updated = await ctx.db.get(room._id)
    if (!updated) {
      throw new ConvexError({
        code: 'INTERNAL_ERROR',
        message: 'Failed to join community',
      })
    }
    return updated
  },
})

export const renameCommunity = mutation({
  args: {
    roomId: v.id('social_rooms'),
    name: v.string(),
  },
  returns: socialRoomValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx)
    await enforceMutationRateLimit(
      ctx,
      'social_rename_community',
      ownerId,
      RATE_STANDARD,
      'Too many community changes. Please slow down and try again.',
    )
    const room = await requireCommunityRoom(ctx, args.roomId)
    await requireCommunityCreator(ctx, args.roomId, ownerId)
    const name = normalizeCommunityName(args.name)
    await ctx.db.patch(room._id, {
      title: name,
      updatedAt: Date.now(),
    })
    const updated = await ctx.db.get(room._id)
    if (!updated) {
      throw new ConvexError({
        code: 'INTERNAL_ERROR',
        message: 'Failed to rename community',
      })
    }
    return updated
  },
})

export const removeCommunityMember = mutation({
  args: {
    roomId: v.id('social_rooms'),
    memberOwnerId: v.string(),
  },
  returns: v.object({ removed: v.boolean() }),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx)
    await enforceMutationRateLimit(
      ctx,
      'social_remove_community_member',
      ownerId,
      RATE_STANDARD,
      'Too many community changes. Please slow down and try again.',
    )
    await requireCommunityRoom(ctx, args.roomId)
    await requireCommunityCreator(ctx, args.roomId, ownerId)
    if (args.memberOwnerId === ownerId) {
      throw new ConvexError({
        code: 'INVALID_ARGUMENT',
        message: 'You can\u2019t remove yourself. Delete the community instead.',
      })
    }
    const membership = await getCommunityMembership(
      ctx,
      args.roomId,
      args.memberOwnerId,
    )
    if (!membership) {
      return { removed: false }
    }
    await ctx.db.delete(membership._id)
    await detachMemberFromRoomSessions(ctx, args.roomId, args.memberOwnerId)
    await ctx.db.patch(args.roomId, { updatedAt: Date.now() })
    return { removed: true }
  },
})

export const leaveCommunity = mutation({
  args: {
    roomId: v.id('social_rooms'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx)
    await enforceMutationRateLimit(
      ctx,
      'social_leave_community',
      ownerId,
      RATE_STANDARD,
      'Too many community changes. Please slow down and try again.',
    )
    await requireCommunityRoom(ctx, args.roomId)
    const membership = await requireCommunityMembership(
      ctx,
      args.roomId,
      ownerId,
    )
    if (membership.role === 'owner') {
      // v1 keeps ownership fixed: no transfer flow, so the creator's exit
      // path is deleting the community.
      throw new ConvexError({
        code: 'FORBIDDEN',
        message:
          'You created this community. Delete it instead of leaving it.',
      })
    }
    await ctx.db.delete(membership._id)
    await detachMemberFromRoomSessions(ctx, args.roomId, ownerId)
    return null
  },
})

export const deleteCommunity = mutation({
  args: {
    roomId: v.id('social_rooms'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx)
    await enforceMutationRateLimit(
      ctx,
      'social_delete_community',
      ownerId,
      RATE_STANDARD,
      'Too many community changes. Please slow down and try again.',
    )
    const room = await requireCommunityRoom(ctx, args.roomId)
    await requireCommunityCreator(ctx, args.roomId, ownerId)

    if (room.stellaSessionId) {
      const session = await ctx.db.get(room.stellaSessionId)
      if (session && session.status !== 'ended') {
        throw new ConvexError({
          code: 'CONFLICT',
          message:
            'End the live Stella session in this community before deleting it.',
        })
      }
    }

    // Delete the room row first: the community disappears from every
    // member's list immediately (summaries hydrate to null without the room
    // doc) and new message sends fail because `refreshRoomUpdatedAt` can no
    // longer patch it. Children are purged asynchronously in batches.
    await ctx.db.delete(room._id)
    await ctx.scheduler.runAfter(
      0,
      internal.social.communities.purgeCommunityRoomBatchInternal,
      { roomId: args.roomId },
    )
    return null
  },
})

/**
 * Batched cascade behind `deleteCommunity`. Deletes messages, memberships,
 * and any (ended) Stella-session rows for the room, rescheduling itself
 * whenever a full batch was consumed so a large community can't blow a
 * single mutation's budget. Mirrors the batch shape of
 * `admin_deletes.deleteSocialRoomBatch`.
 */
export const purgeCommunityRoomBatchInternal = internalMutation({
  args: {
    roomId: v.id('social_rooms'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const reschedule = async () => {
      await ctx.scheduler.runAfter(
        0,
        internal.social.communities.purgeCommunityRoomBatchInternal,
        { roomId: args.roomId },
      )
    }

    const messages = await ctx.db
      .query('social_messages')
      .withIndex('by_roomId_and_createdAt', (q) => q.eq('roomId', args.roomId))
      .take(PURGE_BATCH)
    if (messages.length > 0) {
      for (const row of messages) await ctx.db.delete(row._id)
      await reschedule()
      return null
    }

    const members = await ctx.db
      .query('social_room_members')
      .withIndex('by_roomId_and_joinedAt', (q) => q.eq('roomId', args.roomId))
      .take(PURGE_BATCH)
    if (members.length > 0) {
      for (const row of members) await ctx.db.delete(row._id)
      await reschedule()
      return null
    }

    const session = await ctx.db
      .query('stella_sessions')
      .withIndex('by_roomId', (q) => q.eq('roomId', args.roomId))
      .unique()
    if (session) {
      const sessionChildBatches = [
        await ctx.db
          .query('stella_session_file_ops')
          .withIndex('by_sessionId_and_ordinal', (q) =>
            q.eq('sessionId', session._id),
          )
          .take(PURGE_BATCH),
        await ctx.db
          .query('stella_session_files')
          .withIndex('by_sessionId_and_updatedAt', (q) =>
            q.eq('sessionId', session._id),
          )
          .take(PURGE_BATCH),
        await ctx.db
          .query('stella_session_file_blobs')
          .withIndex('by_sessionId_and_createdAt', (q) =>
            q.eq('sessionId', session._id),
          )
          .take(PURGE_BATCH),
        await ctx.db
          .query('stella_session_turns')
          .withIndex('by_sessionId_and_ordinal', (q) =>
            q.eq('sessionId', session._id),
          )
          .take(PURGE_BATCH),
        await ctx.db
          .query('stella_session_members')
          .withIndex('by_sessionId_and_updatedAt', (q) =>
            q.eq('sessionId', session._id),
          )
          .take(PURGE_BATCH),
      ]
      for (const batch of sessionChildBatches) {
        if (batch.length > 0) {
          for (const row of batch) await ctx.db.delete(row._id)
          await reschedule()
          return null
        }
      }
      await ctx.db.delete(session._id)
    }

    // Room row was deleted synchronously in `deleteCommunity`; nothing left.
    return null
  },
})
