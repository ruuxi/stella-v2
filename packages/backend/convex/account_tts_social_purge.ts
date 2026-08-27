import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { hasOwnerMigrationWriteFence } from "./auth";
import { assertOwnerPurgeLease } from "./owner_lifecycle";

const ROW_BATCH = 48;
const TTS_TICKET_BATCH = 8;
const TTS_SEGMENT_BATCH = 48;
const TTS_USAGE_BATCH = 100;
const STORAGE_BATCH = 24;
const MAX_ACTION_PASSES = 8;
const MAX_PENDING_LABELS = 64;

type PurgeFence = {
  ownerId: string;
  operationId: string;
  generation: string;
  leaseId: string;
};

const purgeModeValidator = v.union(v.literal("reset"), v.literal("delete"));

const assertPurgeLease = async (
  ctx: MutationCtx,
  fence: PurgeFence & { mode: "reset" | "delete" },
) => {
  await assertOwnerPurgeLease(ctx, {
    ...fence,
    stage: "core",
  });
};

const assertDeleteLease = async (ctx: MutationCtx, fence: PurgeFence) => {
  await assertPurgeLease(ctx, { ...fence, mode: "delete" });
};

const ownerIsOpen = async (ctx: MutationCtx, ownerId: string) => {
  const lifecycle = await ctx.db
    .query("cloud_owner_lifecycles")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();
  if (lifecycle && lifecycle.state !== "open") return false;
  return !(await hasOwnerMigrationWriteFence(ctx, ownerId));
};

const findOpenRoomSuccessor = async (
  ctx: MutationCtx,
  roomId: Id<"social_rooms">,
  deletingOwnerId: string,
) => {
  const members = await ctx.db
    .query("social_room_members")
    .withIndex("by_roomId_and_joinedAt", (q) => q.eq("roomId", roomId))
    .take(100);
  const candidates = [...members]
    .filter((member) => member.ownerId !== deletingOwnerId)
    .sort((left, right) =>
      left.ownerId === right.ownerId
        ? left.joinedAt - right.joinedAt
        : left.ownerId.localeCompare(right.ownerId),
    );
  for (const candidate of candidates) {
    if (await ownerIsOpen(ctx, candidate.ownerId)) return candidate;
  }
  return null;
};

const clearMessageReadPointers = async (
  ctx: MutationCtx,
  messageId: Id<"social_messages">,
) => {
  const refs = await ctx.db
    .query("social_room_members")
    .withIndex("by_lastReadMessageId", (q) =>
      q.eq("lastReadMessageId", messageId),
    )
    .take(ROW_BATCH);
  for (const ref of refs) {
    await ctx.db.patch(ref._id, {
      lastReadMessageId: undefined,
      lastReadAt: undefined,
      updatedAt: Date.now(),
    });
  }
  return refs.length < ROW_BATCH;
};

const deleteDerivedTurnMessages = async (
  ctx: MutationCtx,
  turnId: Id<"stella_session_turns">,
) => {
  const messages = await ctx.db
    .query("social_messages")
    .withIndex("by_sourceTurnId", (q) => q.eq("sourceTurnId", turnId))
    .take(ROW_BATCH);
  for (const message of messages) {
    if (!(await clearMessageReadPointers(ctx, message._id))) return false;
    await ctx.db.patch(message._id, {
      body: "",
      originalBody: undefined,
      clientMessageId: undefined,
      sourceTurnId: undefined,
    });
    await ctx.db.delete(message._id);
  }
  return messages.length < ROW_BATCH;
};

export const purgeOwnerTtsBatchInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    leaseId: v.string(),
    mode: purgeModeValidator,
  },
  returns: v.object({ progress: v.boolean(), pending: v.string() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ progress: boolean; pending: string }> => {
    await assertPurgeLease(ctx, args);

    const segments = await ctx.db
      .query("tts_hls_segments")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(TTS_SEGMENT_BATCH);
    if (segments.length > 0) {
      for (const segment of segments) {
        await ctx.db.delete(segment._id);
      }
      return { progress: true, pending: "tts_hls_segments" };
    }

    const tickets = await ctx.db
      .query("tts_stream_tickets")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(TTS_TICKET_BATCH);
    if (tickets.length > 0) {
      for (const ticket of tickets) {
        await ctx.db.delete(ticket._id);
      }
      return { progress: true, pending: "tts_stream_tickets" };
    }

    if (args.mode === "delete") {
      const usage = await ctx.db
        .query("internal_tts_usage")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .take(TTS_USAGE_BATCH);
      if (usage.length > 0) {
        for (const row of usage) await ctx.db.delete(row._id);
        return { progress: true, pending: "internal_tts_usage" };
      }
    }

    return { progress: false, pending: "" };
  },
});

const storageManifestEntryValidator = v.object({
  storageId: v.id("_storage"),
  deleteStorage: v.boolean(),
});

type StorageManifestEntry = {
  storageId: Id<"_storage">;
  deleteStorage: boolean;
};

/**
 * External-first manifest runner with dependency injection for deterministic
 * failure/replay tests. A rejected delete never invokes `finalize`, so the
 * exact Convex locator rows remain durable retry debt.
 */
export const runStorageManifestDeletes = async (
  entries: StorageManifestEntry[],
  deleteStorage: (storageId: Id<"_storage">) => Promise<void>,
  finalize: (entry: StorageManifestEntry) => Promise<void>,
): Promise<string[]> => {
  const pending: string[] = [];
  for (const entry of entries) {
    try {
      if (entry.deleteStorage) await deleteStorage(entry.storageId);
      await finalize(entry);
    } catch {
      pending.push("stella_session_storage_delete");
    }
  }
  return pending;
};

export const listOwnerSocialStorageManifestInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(storageManifestEntryValidator),
  handler: async (ctx, args) => {
    const [files, blobs, ops] = await Promise.all([
      ctx.db
        .query("stella_session_files")
        .withIndex("by_lastActorOwnerId_and_updatedAt", (q) =>
          q.eq("lastActorOwnerId", args.ownerId),
        )
        .take(STORAGE_BATCH),
      ctx.db
        .query("stella_session_file_blobs")
        .withIndex("by_createdByOwnerId_and_createdAt", (q) =>
          q.eq("createdByOwnerId", args.ownerId),
        )
        .take(STORAGE_BATCH),
      ctx.db
        .query("stella_session_file_ops")
        .withIndex("by_actorOwnerId_and_createdAt", (q) =>
          q.eq("actorOwnerId", args.ownerId),
        )
        .take(STORAGE_BATCH),
    ]);
    const ids = new Set<Id<"_storage">>();
    for (const row of files) if (row.storageId) ids.add(row.storageId);
    for (const row of blobs) ids.add(row.storageId);
    for (const row of ops) if (row.storageId) ids.add(row.storageId);

    const entries = [];
    for (const storageId of [...ids].slice(0, STORAGE_BATCH)) {
      const [blob, foreignBefore, foreignAfter, ...foreignFiles] =
        await Promise.all([
          ctx.db
            .query("stella_session_file_blobs")
            .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
            .unique(),
          ctx.db
            .query("stella_session_file_ops")
            .withIndex("by_storageId_and_actorOwnerId", (q) =>
              q.eq("storageId", storageId).lt("actorOwnerId", args.ownerId),
            )
            .first(),
          ctx.db
            .query("stella_session_file_ops")
            .withIndex("by_storageId_and_actorOwnerId", (q) =>
              q.eq("storageId", storageId).gt("actorOwnerId", args.ownerId),
            )
            .first(),
          ...([false, true] as const).flatMap((deleted) => [
            ctx.db
              .query("stella_session_files")
              .withIndex("by_storageId_and_deleted_and_lastActorOwnerId", (q) =>
                q
                  .eq("storageId", storageId)
                  .eq("deleted", deleted)
                  .lt("lastActorOwnerId", args.ownerId),
              )
              .first(),
            ctx.db
              .query("stella_session_files")
              .withIndex("by_storageId_and_deleted_and_lastActorOwnerId", (q) =>
                q
                  .eq("storageId", storageId)
                  .eq("deleted", deleted)
                  .gt("lastActorOwnerId", args.ownerId),
              )
              .first(),
          ]),
        ]);
      entries.push({
        storageId,
        deleteStorage:
          blob?.externalDeletedAt === undefined &&
          !foreignBefore &&
          !foreignAfter &&
          foreignFiles.every((row) => row === null),
      });
    }
    return entries;
  },
});

export const finalizeOwnerSocialStorageInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    leaseId: v.string(),
    storageId: v.id("_storage"),
    externalDeleted: v.boolean(),
  },
  returns: v.object({ progress: v.boolean() }),
  handler: async (ctx, args) => {
    await assertDeleteLease(ctx, args);
    let progress = false;

    const files = await ctx.db
      .query("stella_session_files")
      .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
      .take(ROW_BATCH);
    for (const file of files) {
      let belongsToOwner = file.lastActorOwnerId === args.ownerId;
      if (!file.lastActorOwnerId) {
        const latest = await ctx.db
          .query("stella_session_file_ops")
          .withIndex("by_sessionId_and_relativePath_and_ordinal", (q) =>
            q
              .eq("sessionId", file.sessionId)
              .eq("relativePath", file.relativePath),
          )
          .order("desc")
          .first();
        belongsToOwner = latest?.actorOwnerId === args.ownerId;
      }
      if (!belongsToOwner) continue;
      await ctx.db.delete(file._id);
      progress = true;
    }

    const [foreignBefore, foreignAfter] = await Promise.all([
      ctx.db
        .query("stella_session_file_ops")
        .withIndex("by_storageId_and_actorOwnerId", (q) =>
          q.eq("storageId", args.storageId).lt("actorOwnerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("stella_session_file_ops")
        .withIndex("by_storageId_and_actorOwnerId", (q) =>
          q.eq("storageId", args.storageId).gt("actorOwnerId", args.ownerId),
        )
        .first(),
    ]);
    const blob = await ctx.db
      .query("stella_session_file_blobs")
      .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
      .unique();
    if (blob) {
      const [remainingFile, remainingOp] = await Promise.all([
        ctx.db
          .query("stella_session_files")
          .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
          .first(),
        ctx.db
          .query("stella_session_file_ops")
          .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
          .first(),
      ]);
      const externalDeletionConfirmed =
        args.externalDeleted || blob.externalDeletedAt !== undefined;
      if (
        externalDeletionConfirmed &&
        !foreignBefore &&
        !foreignAfter &&
        !remainingFile &&
        !remainingOp
      ) {
        await ctx.db.delete(blob._id);
      } else if (args.externalDeleted && !blob.externalDeletedAt) {
        // Persist successful external deletion before dependent locators are
        // drained. Replays can now skip the non-idempotent storage.delete and
        // retain this exact row as durable deletion debt until it is last.
        await ctx.db.patch(blob._id, { externalDeletedAt: Date.now() });
      } else if (
        !externalDeletionConfirmed &&
        blob.createdByOwnerId === args.ownerId
      ) {
        // A foreign current file/op now owns the shared content. Remove only
        // the deleted principal provenance; retain the shared locator/object.
        await ctx.db.patch(blob._id, {
          createdByOwnerId: undefined,
          ownerGeneration: undefined,
        });
      }
      progress = true;
    }
    return { progress };
  },
});

export const purgeOwnerSocialBatchInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    leaseId: v.string(),
  },
  returns: v.object({ progress: v.boolean(), pending: v.string() }),
  handler: async (ctx, args) => {
    await assertDeleteLease(ctx, args);

    const messages = await ctx.db
      .query("social_messages")
      .withIndex("by_senderOwnerId_and_createdAt", (q) =>
        q.eq("senderOwnerId", args.ownerId),
      )
      .take(ROW_BATCH);
    if (messages.length > 0) {
      for (const message of messages) {
        if (!(await clearMessageReadPointers(ctx, message._id))) continue;
        await ctx.db.patch(message._id, {
          body: "",
          originalBody: undefined,
          clientMessageId: undefined,
          sourceTurnId: undefined,
        });
        await ctx.db.delete(message._id);
      }
      return { progress: true, pending: "social_messages" };
    }

    const turns = await ctx.db
      .query("stella_session_turns")
      .withIndex("by_requestedByOwnerId_and_createdAt", (q) =>
        q.eq("requestedByOwnerId", args.ownerId),
      )
      .take(ROW_BATCH);
    if (turns.length > 0) {
      for (const turn of turns) {
        if (!(await deleteDerivedTurnMessages(ctx, turn._id))) continue;
        await ctx.db.patch(turn._id, {
          prompt: "",
          resultText: undefined,
          error: undefined,
          requestId: undefined,
          claimedByDeviceId: undefined,
        });
        await ctx.db.delete(turn._id);
      }
      return { progress: true, pending: "stella_session_turns" };
    }

    const fileOps = await ctx.db
      .query("stella_session_file_ops")
      .withIndex("by_actorOwnerId_and_createdAt", (q) =>
        q.eq("actorOwnerId", args.ownerId),
      )
      .take(ROW_BATCH);
    if (fileOps.length > 0) {
      for (const op of fileOps) {
        await ctx.db.patch(op._id, {
          relativePath: "",
          contentHash: undefined,
          storageId: undefined,
          sizeBytes: undefined,
          contentType: undefined,
        });
        await ctx.db.delete(op._id);
      }
      return { progress: true, pending: "stella_session_file_ops" };
    }

    const files = await ctx.db
      .query("stella_session_files")
      .withIndex("by_lastActorOwnerId_and_updatedAt", (q) =>
        q.eq("lastActorOwnerId", args.ownerId),
      )
      .take(ROW_BATCH);
    if (files.length > 0) {
      for (const file of files) {
        if (file.storageId) continue;
        await ctx.db.delete(file._id);
      }
      return { progress: true, pending: "stella_session_files" };
    }

    const hosted = await ctx.db
      .query("stella_sessions")
      .withIndex("by_hostOwnerId_and_status", (q) =>
        q.eq("hostOwnerId", args.ownerId),
      )
      .take(ROW_BATCH);
    if (hosted.length > 0) {
      for (const session of hosted) {
        const room = await ctx.db.get(session.roomId);
        if (room?.stellaSessionId === session._id) {
          await ctx.db.patch(room._id, {
            stellaSessionId: undefined,
            updatedAt: Date.now(),
          });
        }
        await ctx.db.patch(session._id, {
          hostOwnerId: undefined,
          hostDeviceId: "",
          ...(session.createdByOwnerId === args.ownerId
            ? {
                createdByOwnerId: undefined,
                workspaceSlug: "deleted-account",
                workspaceFolderName: "Deleted account workspace",
                conversationId: "",
              }
            : {}),
          status: "ended",
          updatedAt: Date.now(),
        });
      }
      return { progress: true, pending: "stella_sessions.hostOwnerId" };
    }

    const createdSessions = await ctx.db
      .query("stella_sessions")
      .withIndex("by_createdByOwnerId_and_updatedAt", (q) =>
        q.eq("createdByOwnerId", args.ownerId),
      )
      .take(ROW_BATCH);
    if (createdSessions.length > 0) {
      for (const session of createdSessions) {
        await ctx.db.patch(session._id, {
          createdByOwnerId: undefined,
          workspaceSlug: "deleted-account",
          workspaceFolderName: "Deleted account workspace",
          conversationId: "",
        });
      }
      return { progress: true, pending: "stella_sessions.createdByOwnerId" };
    }

    const roomMemberships = await ctx.db
      .query("social_room_members")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(ROW_BATCH);
    if (roomMemberships.length > 0) {
      for (const membership of roomMemberships) {
        const room = await ctx.db.get(membership.roomId);
        if (room) {
          if (membership.role === "owner") {
            const successor = await findOpenRoomSuccessor(
              ctx,
              room._id,
              args.ownerId,
            );
            if (successor) {
              await ctx.db.patch(successor._id, {
                role: "owner",
                updatedAt: Date.now(),
              });
            }
          }
          await ctx.db.patch(room._id, {
            ...(room.createdByOwnerId === args.ownerId
              ? {
                  createdByOwnerId: undefined,
                  title: undefined,
                  inviteCode: undefined,
                }
              : {}),
            ...(room.dmLowOwnerId === args.ownerId
              ? { dmLowOwnerId: undefined }
              : {}),
            ...(room.dmHighOwnerId === args.ownerId
              ? { dmHighOwnerId: undefined }
              : {}),
            ...(room.kind === "dm" ? { roomKey: undefined } : {}),
            updatedAt: Date.now(),
          });
        }
        await ctx.db.delete(membership._id);
      }
      return { progress: true, pending: "social_room_members" };
    }

    const affectedRooms = [
      ...(await ctx.db
        .query("social_rooms")
        .withIndex("by_createdByOwnerId_and_updatedAt", (q) =>
          q.eq("createdByOwnerId", args.ownerId),
        )
        .take(ROW_BATCH)),
      ...(await ctx.db
        .query("social_rooms")
        .withIndex("by_dmLowOwnerId_and_updatedAt", (q) =>
          q.eq("dmLowOwnerId", args.ownerId),
        )
        .take(ROW_BATCH)),
      ...(await ctx.db
        .query("social_rooms")
        .withIndex("by_dmHighOwnerId_and_updatedAt", (q) =>
          q.eq("dmHighOwnerId", args.ownerId),
        )
        .take(ROW_BATCH)),
    ];
    if (affectedRooms.length > 0) {
      for (const roomId of new Set(affectedRooms.map((room) => room._id))) {
        const room = await ctx.db.get(roomId);
        if (!room) continue;
        await ctx.db.patch(room._id, {
          ...(room.createdByOwnerId === args.ownerId
            ? {
                createdByOwnerId: undefined,
                title: undefined,
                inviteCode: undefined,
              }
            : {}),
          ...(room.dmLowOwnerId === args.ownerId
            ? { dmLowOwnerId: undefined }
            : {}),
          ...(room.dmHighOwnerId === args.ownerId
            ? { dmHighOwnerId: undefined }
            : {}),
          ...(room.kind === "dm" ? { roomKey: undefined } : {}),
          updatedAt: Date.now(),
        });
      }
      return { progress: true, pending: "social_rooms" };
    }

    const sessionMemberships = await ctx.db
      .query("stella_session_members")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(ROW_BATCH);
    if (sessionMemberships.length > 0) {
      for (const membership of sessionMemberships) {
        await ctx.db.delete(membership._id);
      }
      return { progress: true, pending: "stella_session_members" };
    }

    const relationships = [
      ...(await ctx.db
        .query("social_relationships")
        .withIndex("by_lowOwnerId_and_status", (q) =>
          q.eq("lowOwnerId", args.ownerId),
        )
        .take(ROW_BATCH)),
      ...(await ctx.db
        .query("social_relationships")
        .withIndex("by_highOwnerId_and_status", (q) =>
          q.eq("highOwnerId", args.ownerId),
        )
        .take(ROW_BATCH)),
      ...(await ctx.db
        .query("social_relationships")
        .withIndex("by_initiatedByOwnerId_and_updatedAt", (q) =>
          q.eq("initiatedByOwnerId", args.ownerId),
        )
        .take(ROW_BATCH)),
    ];
    if (relationships.length > 0) {
      for (const id of new Set(relationships.map((row) => row._id))) {
        await ctx.db.delete(id);
      }
      return { progress: true, pending: "social_relationships" };
    }

    const profiles = await ctx.db
      .query("social_profiles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .take(ROW_BATCH);
    if (profiles.length > 0) {
      for (const profile of profiles) await ctx.db.delete(profile._id);
      return { progress: true, pending: "social_profiles" };
    }

    return { progress: false, pending: "" };
  },
});

const remainingOwnerTtsReset = async (ctx: QueryCtx, ownerId: string) => {
  const checks = await Promise.all([
    ctx.db
      .query("tts_hls_segments")
      .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
      .first(),
    ctx.db
      .query("tts_stream_tickets")
      .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
      .first(),
    ctx.db
      .query("tts_provider_dispatch_leases")
      .withIndex("by_ownerId_and_state", (q) =>
        q.eq("ownerId", ownerId).eq("state", "active"),
      )
      .first(),
    ctx.db
      .query("tts_provider_dispatch_leases")
      .withIndex("by_ownerId_and_state", (q) =>
        q.eq("ownerId", ownerId).eq("state", "cancel_requested"),
      )
      .first(),
  ]);
  const labels = [
    "tts_hls_segments",
    "tts_stream_tickets",
    "tts_provider_dispatch_active",
    "tts_provider_dispatch_debt",
  ];
  return checks
    .map((row, index) => (row ? labels[index]! : null))
    .filter((label): label is string => label !== null);
};

/**
 * Strict reset readback for transient TTS payloads only. Provider-spend audit
 * rows and social product state deliberately survive reset.
 */
export const remainingOwnerTtsInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => await remainingOwnerTtsReset(ctx, args.ownerId),
});

export const remainingOwnerTtsSocialInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const checks = await Promise.all([
      ctx.db
        .query("tts_hls_segments")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("tts_stream_tickets")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("internal_tts_usage")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("tts_provider_dispatch_leases")
        .withIndex("by_ownerId_and_state", (q) =>
          q.eq("ownerId", args.ownerId).eq("state", "active"),
        )
        .first(),
      ctx.db
        .query("tts_provider_dispatch_leases")
        .withIndex("by_ownerId_and_state", (q) =>
          q.eq("ownerId", args.ownerId).eq("state", "cancel_requested"),
        )
        .first(),
      ctx.db
        .query("social_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
        .first(),
      ctx.db
        .query("social_relationships")
        .withIndex("by_lowOwnerId_and_status", (q) =>
          q.eq("lowOwnerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("social_relationships")
        .withIndex("by_highOwnerId_and_status", (q) =>
          q.eq("highOwnerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("social_relationships")
        .withIndex("by_requesterOwnerId_and_status", (q) =>
          q.eq("requesterOwnerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("social_relationships")
        .withIndex("by_addresseeOwnerId_and_status", (q) =>
          q.eq("addresseeOwnerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("social_relationships")
        .withIndex("by_initiatedByOwnerId_and_updatedAt", (q) =>
          q.eq("initiatedByOwnerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("social_rooms")
        .withIndex("by_createdByOwnerId_and_updatedAt", (q) =>
          q.eq("createdByOwnerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("social_rooms")
        .withIndex("by_dmLowOwnerId_and_updatedAt", (q) =>
          q.eq("dmLowOwnerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("social_rooms")
        .withIndex("by_dmHighOwnerId_and_updatedAt", (q) =>
          q.eq("dmHighOwnerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("social_room_members")
        .withIndex("by_ownerId_and_updatedAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("social_messages")
        .withIndex("by_senderOwnerId_and_createdAt", (q) =>
          q.eq("senderOwnerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("stella_sessions")
        .withIndex("by_hostOwnerId_and_status", (q) =>
          q.eq("hostOwnerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("stella_sessions")
        .withIndex("by_createdByOwnerId_and_updatedAt", (q) =>
          q.eq("createdByOwnerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("stella_session_members")
        .withIndex("by_ownerId_and_updatedAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("stella_session_turns")
        .withIndex("by_requestedByOwnerId_and_createdAt", (q) =>
          q.eq("requestedByOwnerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("stella_session_file_blobs")
        .withIndex("by_createdByOwnerId_and_createdAt", (q) =>
          q.eq("createdByOwnerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("stella_session_files")
        .withIndex("by_lastActorOwnerId_and_updatedAt", (q) =>
          q.eq("lastActorOwnerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("stella_session_file_ops")
        .withIndex("by_actorOwnerId_and_createdAt", (q) =>
          q.eq("actorOwnerId", args.ownerId),
        )
        .first(),
    ]);
    const labels = [
      "tts_hls_segments",
      "tts_stream_tickets",
      "internal_tts_usage",
      "tts_provider_dispatch_active",
      "tts_provider_dispatch_debt",
      "social_profiles",
      "social_relationships.lowOwnerId",
      "social_relationships.highOwnerId",
      "social_relationships.requesterOwnerId",
      "social_relationships.addresseeOwnerId",
      "social_relationships.initiatedByOwnerId",
      "social_rooms.createdByOwnerId",
      "social_rooms.dmLowOwnerId",
      "social_rooms.dmHighOwnerId",
      "social_room_members",
      "social_messages.senderOwnerId",
      "stella_sessions.hostOwnerId",
      "stella_sessions.createdByOwnerId",
      "stella_session_members",
      "stella_session_turns.requestedByOwnerId",
      "stella_session_file_blobs.createdByOwnerId",
      "stella_session_files.lastActorOwnerId",
      "stella_session_file_ops.actorOwnerId",
    ];
    return checks
      .map((row, index) => (row ? labels[index]! : null))
      .filter((label): label is string => label !== null);
  },
});

export const purgeOwnerTtsSocialInternal = internalAction({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    leaseId: v.string(),
  },
  returns: v.object({ ready: v.boolean(), pending: v.array(v.string()) }),
  handler: async (
    ctx,
    args,
  ): Promise<{ ready: boolean; pending: string[] }> => {
    const transientPending: string[] = [];
    for (let pass = 0; pass < MAX_ACTION_PASSES; pass += 1) {
      await ctx.runMutation(
        internal.owner_lifecycle.renewOwnerPurgeLeaseInternal,
        {
          ...args,
          stage: "core",
          mode: "delete",
          now: Date.now(),
        },
      );

      const dispatches: { ready: boolean; pending: string[] } =
        await ctx.runMutation(
          internal.tts_dispatch.cancelOwnerTtsProviderDispatchesInternal,
          { ...args, mode: "delete", now: Date.now() },
        );
      if (!dispatches.ready) {
        return {
          ready: false,
          pending: dispatches.pending.slice(0, MAX_PENDING_LABELS),
        };
      }

      const manifest: Array<{
        storageId: Id<"_storage">;
        deleteStorage: boolean;
      }> = await ctx.runQuery(
        internal.account_tts_social_purge
          .listOwnerSocialStorageManifestInternal,
        { ownerId: args.ownerId },
      );
      if (manifest.length > 0) {
        await ctx.runMutation(
          internal.owner_lifecycle.renewOwnerPurgeLeaseInternal,
          {
            ...args,
            stage: "core",
            mode: "delete",
            now: Date.now(),
          },
        );
        transientPending.push(
          ...(await runStorageManifestDeletes(
            manifest,
            async (storageId) => {
              await ctx.runMutation(
                internal.owner_lifecycle.renewOwnerPurgeLeaseInternal,
                {
                  ...args,
                  stage: "core",
                  mode: "delete",
                  now: Date.now(),
                },
              );
              // Convex storage deletion is not idempotent. A crash can occur
              // after deleting bytes but before persisting confirmation, so
              // absence is already success and must advance finalization.
              if ((await ctx.storage.getUrl(storageId)) !== null) {
                await ctx.storage.delete(storageId);
              }
            },
            async (entry) => {
              await ctx.runMutation(
                internal.account_tts_social_purge
                  .finalizeOwnerSocialStorageInternal,
                {
                  ...args,
                  storageId: entry.storageId,
                  externalDeleted: entry.deleteStorage,
                },
              );
            },
          )),
        );
        if (transientPending.length > 0) break;
      }

      const tts: { progress: boolean; pending: string } = await ctx.runMutation(
        internal.account_tts_social_purge.purgeOwnerTtsBatchInternal,
        { ...args, mode: "delete" },
      );
      const social: { progress: boolean; pending: string } =
        await ctx.runMutation(
          internal.account_tts_social_purge.purgeOwnerSocialBatchInternal,
          args,
        );
      if (!tts.progress && !social.progress && manifest.length === 0) break;
    }

    const remaining: string[] = await ctx.runQuery(
      internal.account_tts_social_purge.remainingOwnerTtsSocialInternal,
      { ownerId: args.ownerId },
    );
    const pending: string[] = [
      ...new Set([...transientPending, ...remaining]),
    ].slice(0, MAX_PENDING_LABELS);
    return { ready: pending.length === 0, pending };
  },
});

/**
 * Reset deletes only transient provider payloads. Internal provider-spend
 * audit rows, social rooms, memberships, messages, sessions, turns, and files
 * are intentionally preserved by reset.
 */
export const purgeOwnerTtsResetInternal = internalAction({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    leaseId: v.string(),
  },
  returns: v.object({ ready: v.boolean(), pending: v.array(v.string()) }),
  handler: async (
    ctx,
    args,
  ): Promise<{ ready: boolean; pending: string[] }> => {
    for (let pass = 0; pass < MAX_ACTION_PASSES; pass += 1) {
      await ctx.runMutation(
        internal.owner_lifecycle.renewOwnerPurgeLeaseInternal,
        {
          ...args,
          stage: "core",
          mode: "reset",
          now: Date.now(),
        },
      );
      const dispatches: { ready: boolean; pending: string[] } =
        await ctx.runMutation(
          internal.tts_dispatch.cancelOwnerTtsProviderDispatchesInternal,
          { ...args, mode: "reset", now: Date.now() },
        );
      if (!dispatches.ready) {
        return {
          ready: false,
          pending: dispatches.pending.slice(0, MAX_PENDING_LABELS),
        };
      }
      const batch: { progress: boolean; pending: string } =
        await ctx.runMutation(
          internal.account_tts_social_purge.purgeOwnerTtsBatchInternal,
          { ...args, mode: "reset" },
        );
      if (!batch.progress) break;
    }
    const pending: string[] = await ctx.runQuery(
      internal.account_tts_social_purge.remainingOwnerTtsInternal,
      { ownerId: args.ownerId },
    );
    return { ready: pending.length === 0, pending };
  },
});
