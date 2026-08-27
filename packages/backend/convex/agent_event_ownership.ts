import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { assertOwnerPurgeOperation } from "./owner_lifecycle";

const MAX_BATCH = 100;
const DEFAULT_BATCH = 50;
const MAINTENANCE_PAGE_SIZE = 25;
const DEFAULT_MAINTENANCE_BATCHES = 8;
const MAX_MAINTENANCE_BATCHES = 20;
const MAINTENANCE_KEY = "agent-event-ownership";
const MAINTENANCE_LEASE_MS = 9 * 60_000;

/**
 * A legacy event must be old enough that every normal turn/thread retention
 * window has had time to settle before it can be treated as unreachable
 * garbage. GC still proves the absence of all Convex parent/session evidence
 * transactionally before deleting it.
 */
export const AGENT_EVENT_UNATTRIBUTED_GC_MIN_AGE_MS = 30 * 24 * 60 * 60_000;

type LegacyAgentEvent = {
  turnId: string;
  sessionId: string;
};

type Attribution =
  | { kind: "owner"; ownerId: string; source: "turn" | "thread" }
  | { kind: "conflict" }
  | { kind: "unattributed" };

const boundedBatch = (limit: number | undefined): number =>
  Number.isFinite(limit)
    ? Math.max(1, Math.min(MAX_BATCH, Math.floor(limit!)))
    : DEFAULT_BATCH;

/**
 * Resolve only from authoritative parent records. An exact turn is strongest;
 * a durable spawned-agent thread is a safe fallback because those turns use
 * `sessionId === threadId`. A mismatched exact turn is corruption, not evidence
 * that may be guessed around.
 */
const resolveAttribution = async (
  ctx: MutationCtx,
  event: LegacyAgentEvent,
): Promise<Attribution> => {
  const turn = await ctx.db
    .query("agent_turns")
    .withIndex("by_turnId", (q) => q.eq("turnId", event.turnId))
    .unique();
  if (turn) {
    return turn.sessionId === event.sessionId
      ? { kind: "owner", ownerId: turn.ownerId, source: "turn" }
      : { kind: "conflict" };
  }

  const thread = await ctx.db
    .query("cloud_agent_threads")
    .withIndex("by_threadId", (q) => q.eq("threadId", event.sessionId))
    .unique();
  return thread
    ? { kind: "owner", ownerId: thread.ownerId, source: "thread" }
    : { kind: "unattributed" };
};

const cursorValidator = v.union(v.string(), v.null());
const maintenancePhaseValidator = v.union(v.literal("repair"), v.literal("gc"));
type MaintenancePhase = "repair" | "gc";

/**
 * Rolling backfill for rows written before `agent_events.ownerId` existed.
 * Callers carry the returned cursor until `done`; every pass is bounded and
 * restarting from null is safe.
 */
export const repairAgentEventOwnershipBatchInternal = internalMutation({
  args: {
    cursor: cursorValidator,
    limit: v.optional(v.number()),
  },
  returns: v.object({
    scanned: v.number(),
    repairedFromTurn: v.number(),
    repairedFromThread: v.number(),
    conflicts: v.number(),
    unresolved: v.number(),
    cursor: cursorValidator,
    done: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("agent_events")
      .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", undefined))
      .paginate({ cursor: args.cursor, numItems: boundedBatch(args.limit) });
    let repairedFromTurn = 0;
    let repairedFromThread = 0;
    let conflicts = 0;
    let unresolved = 0;
    for (const event of page.page) {
      const attribution = await resolveAttribution(ctx, event);
      if (attribution.kind === "owner") {
        await ctx.db.patch(event._id, { ownerId: attribution.ownerId });
        if (attribution.source === "turn") repairedFromTurn += 1;
        else repairedFromThread += 1;
      } else if (attribution.kind === "conflict") {
        conflicts += 1;
      } else {
        unresolved += 1;
      }
    }
    return {
      scanned: page.page.length,
      repairedFromTurn,
      repairedFromThread,
      conflicts,
      unresolved,
      cursor: page.isDone ? null : page.continueCursor,
      done: page.isDone,
    };
  },
});

/**
 * Delete only old legacy rows that cannot be attributed to any live Convex
 * owner surface. Besides the exact parent/thread checks above, this refuses to
 * delete when any surviving turn shares the session. All reads and the delete
 * occur in one transaction, so a concurrent parent/session insert conflicts
 * and is re-evaluated instead of racing the proof.
 */
export const gcUnattributedAgentEventsBatchInternal = internalMutation({
  args: {
    cursor: cursorValidator,
    limit: v.optional(v.number()),
  },
  returns: v.object({
    scanned: v.number(),
    deleted: v.number(),
    repairedFromTurn: v.number(),
    repairedFromThread: v.number(),
    protectedByConflict: v.number(),
    protectedByLiveSession: v.number(),
    cursor: cursorValidator,
    done: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const cutoffCreatedAt = Date.now() - AGENT_EVENT_UNATTRIBUTED_GC_MIN_AGE_MS;
    const page = await ctx.db
      .query("agent_events")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", undefined).lte("createdAt", cutoffCreatedAt),
      )
      .paginate({ cursor: args.cursor, numItems: boundedBatch(args.limit) });
    let deleted = 0;
    let repairedFromTurn = 0;
    let repairedFromThread = 0;
    let protectedByConflict = 0;
    let protectedByLiveSession = 0;
    for (const event of page.page) {
      const attribution = await resolveAttribution(ctx, event);
      if (attribution.kind === "owner") {
        await ctx.db.patch(event._id, { ownerId: attribution.ownerId });
        if (attribution.source === "turn") repairedFromTurn += 1;
        else repairedFromThread += 1;
        continue;
      }
      if (attribution.kind === "conflict") {
        protectedByConflict += 1;
        continue;
      }
      const liveSessionTurn = await ctx.db
        .query("agent_turns")
        .withIndex("by_sessionId_and_createdAt", (q) =>
          q.eq("sessionId", event.sessionId),
        )
        .take(1);
      if (liveSessionTurn.length > 0) {
        protectedByLiveSession += 1;
        continue;
      }
      await ctx.db.delete(event._id);
      deleted += 1;
    }
    return {
      scanned: page.page.length,
      deleted,
      repairedFromTurn,
      repairedFromThread,
      protectedByConflict,
      protectedByLiveSession,
      cursor: page.isDone ? null : page.continueCursor,
      done: page.isDone,
    };
  },
});

/** Exact owner-indexed deletion seam for reset/account-deletion orchestration. */
export const deleteOwnerAgentEventsBatchInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    const limit = boundedBatch(args.limit);
    const events = await ctx.db
      .query("agent_events")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(limit);
    await Promise.all(events.map((event) => ctx.db.delete(event._id)));
    return { deleted: events.length, hasMore: events.length === limit };
  },
});

/** Exact bounded readback seam used by strict purge completeness checks. */
export const hasOwnerAgentEventsInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) =>
    (
      await ctx.db
        .query("agent_events")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .take(1)
    ).length > 0,
});

/** Migration completion seam: false is the gate for making ownerId required. */
export const hasUnattributedAgentEventsInternal = internalQuery({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) =>
    (
      await ctx.db
        .query("agent_events")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", undefined),
        )
        .take(1)
    ).length > 0,
});

const maintenanceClaimValidator = v.object({
  claimed: v.boolean(),
  phase: maintenancePhaseValidator,
  cursor: cursorValidator,
});

export const claimAgentEventOwnershipMaintenanceInternal = internalMutation({
  args: { leaseId: v.string(), now: v.number() },
  returns: maintenanceClaimValidator,
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("agent_event_ownership_maintenance")
      .withIndex("by_key", (q) => q.eq("key", MAINTENANCE_KEY))
      .unique();
    if (
      row?.leaseId &&
      row.leaseId !== args.leaseId &&
      (row.leaseExpiresAt ?? 0) > args.now
    ) {
      return {
        claimed: false,
        phase: row.phase,
        cursor: row.cursor ?? null,
      };
    }
    const next = {
      leaseId: args.leaseId,
      leaseExpiresAt: args.now + MAINTENANCE_LEASE_MS,
      updatedAt: args.now,
    };
    if (row) await ctx.db.patch(row._id, next);
    else {
      await ctx.db.insert("agent_event_ownership_maintenance", {
        key: MAINTENANCE_KEY,
        phase: "repair",
        ...next,
      });
    }
    return {
      claimed: true,
      phase: row?.phase ?? "repair",
      cursor: row?.cursor ?? null,
    };
  },
});

export const advanceAgentEventOwnershipMaintenanceInternal = internalMutation({
  args: {
    leaseId: v.string(),
    phase: maintenancePhaseValidator,
    cursor: cursorValidator,
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("agent_event_ownership_maintenance")
      .withIndex("by_key", (q) => q.eq("key", MAINTENANCE_KEY))
      .unique();
    if (!row || row.leaseId !== args.leaseId) return false;
    await ctx.db.patch(row._id, {
      phase: args.phase,
      cursor: args.cursor ?? undefined,
      leaseExpiresAt: args.now + MAINTENANCE_LEASE_MS,
      updatedAt: args.now,
    });
    return true;
  },
});

export const releaseAgentEventOwnershipMaintenanceInternal = internalMutation({
  args: { leaseId: v.string(), now: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("agent_event_ownership_maintenance")
      .withIndex("by_key", (q) => q.eq("key", MAINTENANCE_KEY))
      .unique();
    if (!row || row.leaseId !== args.leaseId) return false;
    await ctx.db.patch(row._id, {
      leaseId: undefined,
      leaseExpiresAt: undefined,
      updatedAt: args.now,
    });
    return true;
  },
});

type RepairBatchResult = {
  scanned: number;
  repairedFromTurn: number;
  repairedFromThread: number;
  conflicts: number;
  unresolved: number;
  cursor: string | null;
  done: boolean;
};

type GcBatchResult = {
  scanned: number;
  deleted: number;
  repairedFromTurn: number;
  repairedFromThread: number;
  protectedByConflict: number;
  protectedByLiveSession: number;
  cursor: string | null;
  done: boolean;
};

const claimMaintenanceRef = makeFunctionReference<
  "mutation",
  { leaseId: string; now: number },
  { claimed: boolean; phase: MaintenancePhase; cursor: string | null }
>("agent_event_ownership:claimAgentEventOwnershipMaintenanceInternal");
const advanceMaintenanceRef = makeFunctionReference<
  "mutation",
  {
    leaseId: string;
    phase: MaintenancePhase;
    cursor: string | null;
    now: number;
  },
  boolean
>("agent_event_ownership:advanceAgentEventOwnershipMaintenanceInternal");
const releaseMaintenanceRef = makeFunctionReference<
  "mutation",
  { leaseId: string; now: number },
  boolean
>("agent_event_ownership:releaseAgentEventOwnershipMaintenanceInternal");
const repairOwnershipRef = makeFunctionReference<
  "mutation",
  { cursor: string | null; limit?: number },
  RepairBatchResult
>("agent_event_ownership:repairAgentEventOwnershipBatchInternal");
const gcUnattributedRef = makeFunctionReference<
  "mutation",
  { cursor: string | null; limit?: number },
  GcBatchResult
>("agent_event_ownership:gcUnattributedAgentEventsBatchInternal");

const maintenanceResultValidator = v.object({
  claimed: v.boolean(),
  batches: v.number(),
  cycleComplete: v.boolean(),
  nextPhase: maintenancePhaseValidator,
  nextCursor: cursorValidator,
  repairScanned: v.number(),
  repairedFromTurn: v.number(),
  repairedFromThread: v.number(),
  repairConflicts: v.number(),
  repairUnresolved: v.number(),
  gcScanned: v.number(),
  gcDeleted: v.number(),
  gcProtected: v.number(),
});

/**
 * Cron-friendly bounded orchestrator. Phase and pagination cursor are persisted
 * after every page, so a crash or low `maxBatches` resumes behind a persistent
 * unresolved prefix instead of rescanning it forever.
 */
export const maintainAgentEventOwnershipInternal = internalAction({
  args: { maxBatches: v.optional(v.number()) },
  returns: maintenanceResultValidator,
  handler: async (ctx, args) => {
    const maxBatches = Number.isFinite(args.maxBatches)
      ? Math.max(
          1,
          Math.min(MAX_MAINTENANCE_BATCHES, Math.floor(args.maxBatches!)),
        )
      : DEFAULT_MAINTENANCE_BATCHES;
    const leaseId = crypto.randomUUID();
    const claim = await ctx.runMutation(claimMaintenanceRef, {
      leaseId,
      now: Date.now(),
    });
    let phase = claim.phase;
    let cursor = claim.cursor;
    let batches = 0;
    let cycleComplete = false;
    let repairScanned = 0;
    let repairedFromTurn = 0;
    let repairedFromThread = 0;
    let repairConflicts = 0;
    let repairUnresolved = 0;
    let gcScanned = 0;
    let gcDeleted = 0;
    let gcProtected = 0;
    if (!claim.claimed) {
      return {
        claimed: false,
        batches,
        cycleComplete,
        nextPhase: phase,
        nextCursor: cursor,
        repairScanned,
        repairedFromTurn,
        repairedFromThread,
        repairConflicts,
        repairUnresolved,
        gcScanned,
        gcDeleted,
        gcProtected,
      };
    }

    try {
      while (batches < maxBatches && !cycleComplete) {
        if (phase === "repair") {
          const result = await ctx.runMutation(repairOwnershipRef, {
            cursor,
            limit: MAINTENANCE_PAGE_SIZE,
          });
          batches += 1;
          repairScanned += result.scanned;
          repairedFromTurn += result.repairedFromTurn;
          repairedFromThread += result.repairedFromThread;
          repairConflicts += result.conflicts;
          repairUnresolved += result.unresolved;
          phase = result.done ? "gc" : "repair";
          cursor = result.done ? null : result.cursor;
        } else {
          const result = await ctx.runMutation(gcUnattributedRef, {
            cursor,
            limit: MAINTENANCE_PAGE_SIZE,
          });
          batches += 1;
          gcScanned += result.scanned;
          gcDeleted += result.deleted;
          repairedFromTurn += result.repairedFromTurn;
          repairedFromThread += result.repairedFromThread;
          gcProtected +=
            result.protectedByConflict + result.protectedByLiveSession;
          if (result.done) {
            phase = "repair";
            cursor = null;
            cycleComplete = true;
          } else {
            cursor = result.cursor;
          }
        }
        const advanced = await ctx.runMutation(advanceMaintenanceRef, {
          leaseId,
          phase,
          cursor,
          now: Date.now(),
        });
        if (!advanced) {
          throw new Error("Agent event ownership maintenance lease was lost.");
        }
      }
    } finally {
      await ctx.runMutation(releaseMaintenanceRef, {
        leaseId,
        now: Date.now(),
      });
    }

    return {
      claimed: true,
      batches,
      cycleComplete,
      nextPhase: phase,
      nextCursor: cursor,
      repairScanned,
      repairedFromTurn,
      repairedFromThread,
      repairConflicts,
      repairUnresolved,
      gcScanned,
      gcDeleted,
      gcProtected,
    };
  },
});
