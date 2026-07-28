// Cloud scheduling: recurring and one-shot chat turns for the cloud
// orchestrator, the cloud analog of the desktop runtime's local scheduler
// (packages/runtime/kernel/local-scheduler-service.ts). Rows live in
// cloud_scheduled_turns; a Convex cron sweeps due rows every minute and
// dispatches each one through the shared chat-turn entry in cloud_apps.
//
// Two hard limits keep a schedule from becoming a token firehose: at most
// MAX_SCHEDULES_PER_OWNER live rows, and no schedule may fire more often than
// MIN_INTERVAL_MS (enforced for "every" directly and for "cron" by measuring
// the gap between its next two fires). A third limit — SCHEDULE_DAILY_FIRES —
// is the owner's daily budget for scheduled turns, held separately from the
// interactive chat budget so background work can never spend the allowance the
// person in front of the composer is about to need.

import { ConvexError, v } from "convex/values";
import { Cron } from "croner";
import { makeFunctionReference } from "convex/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { cronScheduleValidator } from "./schema/scheduling";
import type { SubscriptionPlan } from "./lib/billing_plans";

/** ConvexError carries its readable text in `data`, not in `message`. */
const readableError = (error: unknown): string => {
  const data = (error as { data?: unknown })?.data;
  if (typeof data === "string") return data;
  if (
    data &&
    typeof data === "object" &&
    typeof (data as { message?: unknown }).message === "string"
  ) {
    return (data as { message: string }).message;
  }
  return error instanceof Error ? error.message : String(error);
};

export type CloudSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

/**
 * Terminal status meaning "this owner's data is being deleted". It is not one
 * of the statuses a user can set (`updateScheduleInternal` rejects it) and it
 * is not "active", which is what `listDueSchedulesInternal` selects on — so
 * writing it is what stops a schedule firing, immediately and durably, before
 * anything else about the account has been touched.
 *
 * Deletion is not instantaneous and a schedule that outlives its owner is not
 * a stale row: it is a recurring model spend, billed to nobody, that recreates
 * conversations for an account that no longer exists. So the row is stopped
 * first and drained afterwards, and every path that could put it back — the
 * dispatcher's claim, the fire-retry re-arm, the conversation re-pin, the
 * Schedule tool's own create/update — refuses to touch a row in this state.
 */
export const SCHEDULE_STATUS_PURGED = "purged";

const MAX_SCHEDULES_PER_OWNER = 25;
const MIN_INTERVAL_MS = 15 * 60_000;
const MAX_PROMPT_CHARS = 4_000;
const MAX_DESCRIPTION_CHARS = 200;
const DISPATCH_BATCH = 25;
/** Rows per transaction for the owner-purge scans below. */
const PURGE_SCAN_BATCH = 100;
const MAX_ERROR_CHARS = 300;
/** A fire that failed for a transient reason is retried this soon. */
const FIRE_RETRY_DELAY_MS = 5 * 60_000;
/** …at most this many times, then the schedule waits for its next slot. */
const MAX_FIRE_RETRIES = 3;

/**
 * Scheduled fires per owner per day. Deliberately its own budget: schedules
 * run while nobody is watching, so spending them out of the interactive chat
 * bucket means an owner's own composer message is refused by their own
 * background work.
 */
const SCHEDULE_DAILY_FIRES: Record<SubscriptionPlan, number> = {
  free: 24,
  go: 60,
  pro: 120,
  plus: 200,
  ultra: 400,
  max: 800,
};

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

/** Mirrors `resolveCloudPlan` in cloud_apps.ts, against the schedule budget. */
const resolveScheduleBudget = async (
  ctx: Pick<MutationCtx, "db"> | Pick<QueryCtx, "db">,
  ownerId: string,
): Promise<{ plan: SubscriptionPlan; dailyFires: number }> => {
  const profile = await ctx.db
    .query("billing_profiles")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();
  const plan: SubscriptionPlan =
    profile?.usageMode === "unlimited"
      ? "max"
      : profile &&
          ACTIVE_SUBSCRIPTION_STATUSES.has(profile.subscriptionStatus) &&
          profile.activePlan !== "free"
        ? profile.activePlan
        : "free";
  return { plan, dailyFires: SCHEDULE_DAILY_FIRES[plan] };
};

export const getScheduleBudgetInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.object({ plan: v.string(), dailyFires: v.number() }),
  handler: async (ctx, args) => await resolveScheduleBudget(ctx, args.ownerId),
});

const startCloudChatTurnRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    conversationId?: string;
    prompt: string;
    hiddenMessage?: boolean;
    hiddenTurn?: boolean;
    source?: string;
    now: number;
  },
  { conversationId: string; turnId: string }
>("cloud_apps:startCloudChatTurnInternal");

const listDueSchedulesRef = makeFunctionReference<"query", any, any>(
  "cloud_schedule:listDueSchedulesInternal",
);
const markScheduleRanRef = makeFunctionReference<"mutation", any, any>(
  "cloud_schedule:markScheduleRanInternal",
);
const attachConversationRef = makeFunctionReference<"mutation", any, any>(
  "cloud_schedule:attachConversationInternal",
);
const finishScheduleFireRef = makeFunctionReference<"mutation", any, any>(
  "cloud_schedule:finishScheduleFireInternal",
);
const scheduleBudgetRef = makeFunctionReference<
  "query",
  { ownerId: string },
  { plan: string; dailyFires: number }
>("cloud_schedule:getScheduleBudgetInternal");

const scheduleRowValidator = v.object({
  scheduleId: v.string(),
  ownerId: v.string(),
  conversationId: v.optional(v.string()),
  prompt: v.string(),
  schedule: v.string(),
  nextRunAt: v.number(),
  lastRunAt: v.optional(v.number()),
  status: v.string(),
  description: v.string(),
  // Why the most recent fire did not run. The Schedule tool reads these back
  // to the model, which is the only way a dropped fire ever reaches the user.
  lastError: v.optional(v.string()),
  lastErrorAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

type ScheduleRow = {
  scheduleId: string;
  ownerId: string;
  conversationId?: string;
  prompt: string;
  schedule: string;
  nextRunAt: number;
  lastRunAt?: number;
  status: string;
  description: string;
  lastError?: string;
  lastErrorAt?: number;
  failureCount?: number;
  createdAt: number;
  updatedAt: number;
};

const toScheduleRow = (row: ScheduleRow) => ({
  scheduleId: row.scheduleId,
  ownerId: row.ownerId,
  conversationId: row.conversationId,
  prompt: row.prompt,
  schedule: row.schedule,
  nextRunAt: row.nextRunAt,
  lastRunAt: row.lastRunAt,
  status: row.status,
  description: row.description,
  lastError: row.lastError,
  lastErrorAt: row.lastErrorAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * Coerce untrusted JSON (the Schedule tool's argument, arriving over HTTP)
 * into a CloudSchedule, with the same readable errors the desktop scheduler
 * gives. Throws ConvexError on anything malformed.
 */
export const normalizeScheduleInput = (value: unknown): CloudSchedule => {
  if (!value || typeof value !== "object") {
    throw new ConvexError("schedule must be an object.");
  }
  const record = value as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind.trim() : "";
  if (kind === "at") {
    const atMs = Number(record.atMs);
    if (!Number.isFinite(atMs) || atMs <= 0) {
      throw new ConvexError('schedule.kind="at" requires atMs (epoch ms).');
    }
    return { kind: "at", atMs: Math.floor(atMs) };
  }
  if (kind === "every") {
    const everyMs = Number(record.everyMs);
    if (!Number.isFinite(everyMs) || everyMs <= 0) {
      throw new ConvexError('schedule.kind="every" requires everyMs (> 0).');
    }
    const anchorRaw = Number(record.anchorMs);
    const anchorMs =
      Number.isFinite(anchorRaw) && anchorRaw > 0 ? anchorRaw : undefined;
    return {
      kind: "every",
      everyMs: Math.floor(everyMs),
      ...(anchorMs ? { anchorMs: Math.floor(anchorMs) } : {}),
    };
  }
  if (kind === "cron") {
    const expr = typeof record.expr === "string" ? record.expr.trim() : "";
    if (!expr) throw new ConvexError('schedule.kind="cron" requires expr.');
    const tz = typeof record.tz === "string" ? record.tz.trim() : "";
    return { kind: "cron", expr, ...(tz ? { tz } : {}) };
  }
  throw new ConvexError('schedule.kind must be "at", "every", or "cron".');
};

const parseStoredSchedule = (value: string): CloudSchedule => {
  try {
    return normalizeScheduleInput(JSON.parse(value));
  } catch {
    throw new ConvexError("Stored schedule is unreadable.");
  }
};

const buildCron = (schedule: { expr: string; tz?: string }): Cron => {
  try {
    return new Cron(schedule.expr, {
      timezone: schedule.tz?.trim() || undefined,
      catch: false,
    });
  } catch {
    throw new ConvexError(
      `"${schedule.expr}" is not a cron expression Stella can read.`,
    );
  }
};

const computeNextRunAt = (schedule: CloudSchedule, nowMs: number): number => {
  if (schedule.kind === "at") {
    return schedule.atMs > nowMs ? schedule.atMs : nowMs;
  }
  if (schedule.kind === "every") {
    const everyMs = Math.max(1, Math.floor(schedule.everyMs));
    const anchor = Math.max(0, Math.floor(schedule.anchorMs ?? nowMs));
    if (nowMs < anchor) return anchor;
    const elapsed = nowMs - anchor;
    const steps = Math.max(1, Math.ceil(elapsed / everyMs));
    return anchor + steps * everyMs;
  }
  const next = buildCron(schedule).nextRun(new Date(nowMs));
  if (!next) {
    throw new ConvexError(
      `"${schedule.expr}" has no future run times — pick a different schedule.`,
    );
  }
  return next.getTime();
};

// The gap between consecutive fires, or null when the schedule fires once.
const scheduleIntervalMs = (
  schedule: CloudSchedule,
  nowMs: number,
): number | null => {
  if (schedule.kind === "at") return null;
  if (schedule.kind === "every") return schedule.everyMs;
  const cron = buildCron(schedule);
  const first = cron.nextRun(new Date(nowMs));
  const second = first ? cron.nextRun(first) : null;
  if (!first || !second) return null;
  return second.getTime() - first.getTime();
};

const assertScheduleAllowed = (schedule: CloudSchedule, nowMs: number) => {
  const interval = scheduleIntervalMs(schedule, nowMs);
  if (interval !== null && interval < MIN_INTERVAL_MS) {
    throw new ConvexError(
      `Schedules can run at most once every ${MIN_INTERVAL_MS / 60_000} minutes. Space this one out.`,
    );
  }
};

const cleanPrompt = (value: string): string => {
  const prompt = value.trim();
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) {
    throw new ConvexError(
      `A scheduled prompt needs 1–${MAX_PROMPT_CHARS} characters.`,
    );
  }
  return prompt;
};

const cleanDescription = (
  value: string | undefined,
  prompt: string,
): string => {
  const description = (value ?? "").trim() || prompt;
  return description.length > MAX_DESCRIPTION_CHARS
    ? `${description.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
    : description;
};

export const listOwnerSchedulesInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(scheduleRowValidator),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("cloud_scheduled_turns")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .order("desc")
      .take(MAX_SCHEDULES_PER_OWNER * 2);
    return rows
      .filter((row) => row.status !== SCHEDULE_STATUS_PURGED)
      .map(toScheduleRow);
  },
});

/**
 * Stop every one of this owner's schedules, now. Called at the top of account
 * deletion and reset, before any other drain: the sweep that eventually
 * deletes these rows runs minutes later and behind a conversation drain that
 * can itself take minutes, and every minute of that window is another fire.
 *
 * Idempotent and re-runnable — it is also the first thing a retried purge
 * does, which is what keeps a schedule created by a turn that raced the last
 * attempt from surviving into the next one.
 */
export const stopOwnerSchedulesInternal = internalMutation({
  args: { ownerId: v.string(), now: v.number() },
  returns: v.object({ stopped: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("cloud_scheduled_turns")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(PURGE_SCAN_BATCH);
    let stopped = 0;
    for (const row of rows) {
      if (row.status === SCHEDULE_STATUS_PURGED) continue;
      await ctx.db.patch(row._id, {
        status: SCHEDULE_STATUS_PURGED,
        // Nothing reads this back — the row is on its way out — but a stopped
        // schedule found in a backup should say why it stopped.
        lastError: "Stopped: this account's data is being deleted.",
        lastErrorAt: args.now,
        updatedAt: args.now,
      });
      stopped += 1;
    }
    // Progress, not page position: `updatedAt` moves under the index as rows
    // are patched, so the loop ends when a pass finds nothing left to stop.
    return { stopped, hasMore: stopped > 0 };
  },
});

/** Drains stopped rows. Deletion is the second step; stopping was the first. */
export const deleteOwnerSchedulesInternal = internalMutation({
  args: { ownerId: v.string() },
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("cloud_scheduled_turns")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(PURGE_SCAN_BATCH);
    for (const row of rows) await ctx.db.delete(row._id);
    return { deleted: rows.length, hasMore: rows.length === PURGE_SCAN_BATCH };
  },
});

/** Rows left for this owner, for the purge's own completeness check. */
export const hasOwnerSchedulesInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("cloud_scheduled_turns")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(1);
    return rows.length > 0;
  },
});

export const createScheduleInternal = internalMutation({
  args: {
    ownerId: v.string(),
    prompt: v.string(),
    schedule: cronScheduleValidator,
    description: v.optional(v.string()),
    conversationId: v.optional(v.string()),
    now: v.number(),
  },
  returns: scheduleRowValidator,
  handler: async (ctx, args) => {
    const prompt = cleanPrompt(args.prompt);
    const schedule = normalizeScheduleInput(args.schedule);
    assertScheduleAllowed(schedule, args.now);
    const existing = await ctx.db
      .query("cloud_scheduled_turns")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .order("desc")
      .take(MAX_SCHEDULES_PER_OWNER * 2);
    // A stopped row means a purge for this owner is in flight. Creating here
    // would hand it a schedule the purge has already walked past.
    if (existing.some((row) => row.status === SCHEDULE_STATUS_PURGED)) {
      throw new ConvexError(
        "This account's data is being deleted, so new schedules can't be created.",
      );
    }
    const live = existing.filter((row) => row.status !== "done");
    if (live.length >= MAX_SCHEDULES_PER_OWNER) {
      throw new ConvexError(
        `You already have ${MAX_SCHEDULES_PER_OWNER} schedules. Remove one before adding another.`,
      );
    }
    const scheduleId = `sch-${crypto.randomUUID().slice(0, 18)}`;
    const row = {
      scheduleId,
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      prompt,
      schedule: JSON.stringify(schedule),
      nextRunAt: computeNextRunAt(schedule, args.now),
      status: "active",
      description: cleanDescription(args.description, prompt),
      createdAt: args.now,
      updatedAt: args.now,
    };
    await ctx.db.insert("cloud_scheduled_turns", row);
    return toScheduleRow(row);
  },
});

export const updateScheduleInternal = internalMutation({
  args: {
    ownerId: v.string(),
    scheduleId: v.string(),
    prompt: v.optional(v.string()),
    schedule: v.optional(cronScheduleValidator),
    description: v.optional(v.string()),
    status: v.optional(v.string()),
    now: v.number(),
  },
  returns: scheduleRowValidator,
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("cloud_scheduled_turns")
      .withIndex("by_scheduleId", (q) => q.eq("scheduleId", args.scheduleId))
      .unique();
    // A stopped row is gone as far as everything above this module is
    // concerned; re-activating one would restart a schedule mid-deletion.
    if (
      !row ||
      row.ownerId !== args.ownerId ||
      row.status === SCHEDULE_STATUS_PURGED
    ) {
      throw new ConvexError(`No schedule with id ${args.scheduleId}.`);
    }
    if (args.status && !["active", "paused", "done"].includes(args.status)) {
      throw new ConvexError('status must be "active", "paused", or "done".');
    }
    const prompt =
      args.prompt === undefined ? row.prompt : cleanPrompt(args.prompt);
    let serialized = row.schedule;
    let nextRunAt = row.nextRunAt;
    if (args.schedule !== undefined) {
      const schedule = normalizeScheduleInput(args.schedule);
      assertScheduleAllowed(schedule, args.now);
      serialized = JSON.stringify(schedule);
      nextRunAt = computeNextRunAt(schedule, args.now);
    }
    // Resuming a paused schedule re-anchors it to now, so a schedule that
    // slept through a dozen fires wakes up once rather than catching up.
    if (args.status === "active") {
      nextRunAt = computeNextRunAt(parseStoredSchedule(serialized), args.now);
    }
    const patch = {
      prompt,
      schedule: serialized,
      nextRunAt,
      status: args.status ?? row.status,
      description:
        args.description === undefined
          ? row.description
          : cleanDescription(args.description, prompt),
      updatedAt: args.now,
    };
    await ctx.db.patch(row._id, patch);
    return toScheduleRow({ ...row, ...patch });
  },
});

export const removeScheduleInternal = internalMutation({
  args: { ownerId: v.string(), scheduleId: v.string(), now: v.number() },
  returns: v.object({ removed: v.boolean() }),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("cloud_scheduled_turns")
      .withIndex("by_scheduleId", (q) => q.eq("scheduleId", args.scheduleId))
      .unique();
    if (
      !row ||
      row.ownerId !== args.ownerId ||
      row.status === SCHEDULE_STATUS_PURGED
    ) {
      return { removed: false };
    }
    await ctx.db.delete(row._id);
    return { removed: true };
  },
});

export const listDueSchedulesInternal = internalQuery({
  args: { now: v.number(), limit: v.optional(v.number()) },
  returns: v.array(scheduleRowValidator),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("cloud_scheduled_turns")
      .withIndex("by_status_and_nextRunAt", (q) =>
        q.eq("status", "active").lte("nextRunAt", args.now),
      )
      .take(
        Math.min(DISPATCH_BATCH, Math.max(1, args.limit ?? DISPATCH_BATCH)),
      );
    return rows.map(toScheduleRow);
  },
});

// Advances a fired row. Called BEFORE the turn is dispatched: a dispatch that
// throws must lose one fire, never re-fire the same row every minute.
//
// This is also the claim, and the claim is what makes stopping a schedule
// take effect immediately rather than at the end of the sweep that reads it.
// `listDueSchedulesInternal` ran in an earlier transaction, so its rows are a
// snapshot: re-reading the status here, inside the transaction that advances
// the row, is the only place a purge that landed in between can be seen.
// `claimed: false` means "do not dispatch this".
export const markScheduleRanInternal = internalMutation({
  args: {
    scheduleId: v.string(),
    lastRunAt: v.number(),
    nextRunAt: v.number(),
    status: v.string(),
  },
  returns: v.object({ claimed: v.boolean() }),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("cloud_scheduled_turns")
      .withIndex("by_scheduleId", (q) => q.eq("scheduleId", args.scheduleId))
      .unique();
    if (!row || row.status !== "active") return { claimed: false };
    await ctx.db.patch(row._id, {
      lastRunAt: args.lastRunAt,
      nextRunAt: args.nextRunAt,
      status: args.status,
      updatedAt: args.lastRunAt,
    });
    return { claimed: true };
  },
});

// The first fire of a schedule with no conversation creates one; pin it so
// every later fire reports into the same thread. Re-pinning is the same
// operation: when the pinned conversation has been deleted the dispatcher
// starts a fresh one, and refusing to move the pin then would leave the row
// naming a dead conversation and orphan one new thread per fire, forever.
export const attachConversationInternal = internalMutation({
  args: {
    scheduleId: v.string(),
    conversationId: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("cloud_scheduled_turns")
      .withIndex("by_scheduleId", (q) => q.eq("scheduleId", args.scheduleId))
      .unique();
    if (!row || row.conversationId === args.conversationId) return null;
    // Never re-pin a stopped row: the conversation it would name was created
    // by a fire that raced the purge and is itself about to be deleted.
    if (row.status === SCHEDULE_STATUS_PURGED) return null;
    await ctx.db.patch(row._id, {
      conversationId: args.conversationId,
      updatedAt: args.now,
    });
    return null;
  },
});

/**
 * Close out a fire. `markScheduleRanInternal` has already advanced the row, so
 * without this a fire that never ran is indistinguishable from one that did:
 * the failure is recorded on the row where the Schedule tool can read it back,
 * and a transient failure pulls `nextRunAt` forward so the run is retried
 * rather than lost until the next natural slot.
 */
export const finishScheduleFireInternal = internalMutation({
  args: {
    scheduleId: v.string(),
    now: v.number(),
    error: v.optional(v.string()),
    retryAt: v.optional(v.number()),
    oneShot: v.optional(v.boolean()),
    /** The row can never fire as written; stop it instead of re-arming it. */
    pause: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("cloud_scheduled_turns")
      .withIndex("by_scheduleId", (q) => q.eq("scheduleId", args.scheduleId))
      .unique();
    if (!row) return null;
    // The retry branch below re-arms `nextRunAt` and can move a one-shot back
    // to "active". Neither may happen to a row a purge has stopped.
    if (row.status === SCHEDULE_STATUS_PURGED) return null;
    if (!args.error) {
      if (row.lastError === undefined && !row.failureCount) return null;
      await ctx.db.patch(row._id, {
        lastError: undefined,
        lastErrorAt: undefined,
        failureCount: undefined,
        updatedAt: args.now,
      });
      return null;
    }
    const failureCount = (row.failureCount ?? 0) + 1;
    // A one-shot was marked "done" before the dispatch that failed, so its
    // nextRunAt is in the past: the recurring test (is the retry sooner than
    // the next natural slot?) would never let it retry.
    const retry =
      !args.pause &&
      args.retryAt !== undefined &&
      failureCount <= MAX_FIRE_RETRIES &&
      (args.oneShot ? row.status === "done" : args.retryAt < row.nextRunAt);
    await ctx.db.patch(row._id, {
      lastError: args.error.slice(0, MAX_ERROR_CHARS),
      lastErrorAt: args.now,
      failureCount,
      // Giving up on a one-shot has to leave it "done" rather than
      // active-and-overdue, which the sweep would re-fire every minute.
      ...(args.pause
        ? { status: "paused" }
        : retry
          ? {
              nextRunAt: args.retryAt!,
              ...(args.oneShot ? { status: "active" } : {}),
            }
          : args.oneShot
            ? { status: "done" }
            : {}),
      updatedAt: args.now,
    });
    return null;
  },
});

export const dispatchDueSchedulesInternal = internalAction({
  args: {},
  returns: v.object({ due: v.number(), dispatched: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const due = (await ctx.runQuery(listDueSchedulesRef, {
      now,
      limit: DISPATCH_BATCH,
    })) as ScheduleRow[];
    let dispatched = 0;
    for (const row of due) {
      let schedule: CloudSchedule;
      try {
        schedule = parseStoredSchedule(row.schedule);
      } catch (error) {
        // Nothing advances `nextRunAt` for a row that cannot even be parsed,
        // so leaving it active means re-reading the same broken row every
        // minute forever. Stop it, with the reason on the row.
        await ctx
          .runMutation(finishScheduleFireRef, {
            scheduleId: row.scheduleId,
            now,
            error: readableError(error),
            pause: true,
          })
          .catch(() => undefined);
        continue;
      }
      // "at" fires once and is done; recurring schedules re-anchor from now
      // so a deployment that slept through fires wakes up once, not N times.
      const oneShot = schedule.kind === "at";
      try {
        const claim = (await ctx.runMutation(markScheduleRanRef, {
          scheduleId: row.scheduleId,
          lastRunAt: now,
          nextRunAt: oneShot
            ? row.nextRunAt
            : computeNextRunAt(schedule, now + 1_000),
          status: oneShot ? "done" : "active",
        })) as { claimed: boolean };
        // Deleted, paused, or stopped by an owner purge since the due-list was
        // read. Nothing has been advanced, so there is nothing to record.
        if (!claim.claimed) continue;
        const budget = await ctx.runQuery(scheduleBudgetRef, {
          ownerId: row.ownerId,
        });
        const allowance = await ctx.runMutation(
          internal.rate_limits.consumeWebhookRateLimit,
          {
            scope: "cloud_schedule_fire",
            key: row.ownerId,
            limit: budget.dailyFires,
            windowMs: 24 * 60 * 60_000,
          },
        );
        // Exhausting the day's scheduled budget is a fact about the account,
        // not a transient failure: record it on the row and wait for the next
        // slot rather than retrying into the same wall.
        if (!allowance.allowed) {
          await ctx.runMutation(finishScheduleFireRef, {
            scheduleId: row.scheduleId,
            now,
            oneShot,
            error: `This run was skipped: today's ${budget.dailyFires} scheduled runs on the ${budget.plan === "free" ? "Free" : budget.plan} plan are used up.`,
          });
          continue;
        }
        const dispatch = (conversationId?: string) =>
          ctx.runMutation(startCloudChatTurnRef, {
            ownerId: row.ownerId,
            conversationId,
            prompt: row.prompt,
            // The two knobs pull apart here. The turn stays visible — a reply
            // with no row above it reads as a message from nowhere — but the
            // prompt is the model's own wake instruction, not the owner's
            // words, so the chat surface renders it as the scheduled run it is
            // (keyed off `source`) rather than as a message they sent. The
            // instruction stays in the transcript the model reads, which is
            // what `hiddenMessage: false` keeps.
            hiddenMessage: false,
            hiddenTurn: false,
            source: "schedule",
            now,
          });
        // The pinned conversation can be deleted from the web app while the
        // schedule lives on. Start a fresh one rather than letting the
        // schedule fail silently on every fire from then on.
        const started = await dispatch(row.conversationId).catch((error) => {
          const message = readableError(error);
          if (!row.conversationId || !/conversation not found/i.test(message)) {
            throw error;
          }
          return dispatch();
        });
        if (
          !row.conversationId ||
          started.conversationId !== row.conversationId
        ) {
          await ctx.runMutation(attachConversationRef, {
            scheduleId: row.scheduleId,
            conversationId: started.conversationId,
            now,
          });
        }
        await ctx.runMutation(finishScheduleFireRef, {
          scheduleId: row.scheduleId,
          now,
        });
        dispatched += 1;
      } catch (error) {
        const message = readableError(error);
        console.error(
          JSON.stringify({
            service: "convex-cloud-schedule",
            event: "schedule_dispatch_failed",
            scheduleId: row.scheduleId,
            message,
          }),
        );
        // markScheduleRanInternal already moved the row on, so a fire that
        // threw is gone unless it is written down and re-armed here.
        await ctx
          .runMutation(finishScheduleFireRef, {
            scheduleId: row.scheduleId,
            now,
            error: message,
            oneShot,
            retryAt: now + FIRE_RETRY_DELAY_MS,
          })
          .catch(() => undefined);
      }
    }
    return { due: due.length, dispatched };
  },
});
