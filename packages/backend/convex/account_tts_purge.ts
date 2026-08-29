import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { assertOwnerPurgeLease } from "./owner_lifecycle";

const TTS_TICKET_BATCH = 8;
const TTS_SEGMENT_BATCH = 48;
const TTS_USAGE_BATCH = 100;
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
 * rows deliberately survive reset.
 */
export const remainingOwnerTtsInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => await remainingOwnerTtsReset(ctx, args.ownerId),
});

export const remainingOwnerTtsDeleteInternal = internalQuery({
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
    ]);
    const labels = [
      "tts_hls_segments",
      "tts_stream_tickets",
      "internal_tts_usage",
      "tts_provider_dispatch_active",
      "tts_provider_dispatch_debt",
    ];
    return checks
      .map((row, index) => (row ? labels[index]! : null))
      .filter((label): label is string => label !== null);
  },
});

export const purgeOwnerTtsInternal = internalAction({
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

      const tts: { progress: boolean; pending: string } = await ctx.runMutation(
        internal.account_tts_purge.purgeOwnerTtsBatchInternal,
        { ...args, mode: "delete" },
      );
      if (!tts.progress) break;
    }

    const pending: string[] = (
      await ctx.runQuery(
        internal.account_tts_purge.remainingOwnerTtsDeleteInternal,
        { ownerId: args.ownerId },
      )
    ).slice(0, MAX_PENDING_LABELS);
    return { ready: pending.length === 0, pending };
  },
});

/**
 * Reset deletes only transient provider payloads. Internal provider-spend
 * audit rows are intentionally preserved by reset.
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
          internal.account_tts_purge.purgeOwnerTtsBatchInternal,
          { ...args, mode: "reset" },
        );
      if (!batch.progress) break;
    }
    const pending: string[] = await ctx.runQuery(
      internal.account_tts_purge.remainingOwnerTtsInternal,
      { ownerId: args.ownerId },
    );
    return { ready: pending.length === 0, pending };
  },
});
