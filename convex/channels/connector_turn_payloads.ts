import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "../_generated/server";
import { v, type Infer } from "convex/values";
import { normalizeOptionalInt } from "../lib/number_utils";
import { connectorMediaRefArrayValidator } from "./connector_media_types";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TTL_MS = 15 * 60 * 1000;
const MIN_TTL_MS = 60_000;
const MAX_PURGE_BATCH_LIMIT = 5_000;

const connectorTurnPayloadValidator = v.object({
  conversationId: v.string(),
  text: v.string(),
  agentType: v.optional(v.string()),
  mediaRefs: v.optional(connectorMediaRefArrayValidator),
});

export type ConnectorTurnPayload = Infer<typeof connectorTurnPayloadValidator>;

const normalizeTtlMs = (ttlMs?: number) =>
  ttlMs != null
    ? Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, Math.floor(ttlMs)))
    : DEFAULT_TTL_MS;

export const store = internalMutation({
  args: {
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    requestId: v.string(),
    targetDeviceId: v.string(),
    payload: connectorTurnPayloadValidator,
    ttlMs: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("connector_turn_payloads", {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      requestId: args.requestId,
      targetDeviceId: args.targetDeviceId,
      payload: args.payload,
      createdAt: now,
      expiresAt: now + normalizeTtlMs(args.ttlMs),
    });
    return null;
  },
});

export const get = internalQuery({
  args: {
    requestId: v.string(),
  },
  returns: v.union(v.null(), connectorTurnPayloadValidator),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("connector_turn_payloads")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (!row || row.expiresAt <= Date.now()) {
      return null;
    }
    return row.payload as ConnectorTurnPayload;
  },
});

const deleteByRequestIdCore = async (
  ctx: MutationCtx,
  requestId: string,
): Promise<number> => {
  let deleted = 0;
  while (true) {
    const rows = await ctx.db
      .query("connector_turn_payloads")
      .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
      .take(200);
    if (rows.length === 0) break;
    for (const row of rows) {
      await ctx.db.delete(row._id);
      deleted += 1;
    }
    if (rows.length < 200) break;
  }
  return deleted;
};

export const deleteByRequestId = internalMutation({
  args: {
    requestId: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, args) => deleteByRequestIdCore(ctx, args.requestId),
});

export const purgeExpired = internalMutation({
  args: {
    nowMs: v.optional(v.number()),
    limit: v.optional(v.number()),
    maxBatches: v.optional(v.number()),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const nowMs = args.nowMs ?? Date.now();
    const limit = normalizeOptionalInt({
      value: args.limit,
      defaultValue: 500,
      min: 1,
      max: MAX_PURGE_BATCH_LIMIT,
    });
    const maxBatches = normalizeOptionalInt({
      value: args.maxBatches,
      defaultValue: 10,
      min: 1,
      max: 50,
    });

    let deleted = 0;
    for (let i = 0; i < maxBatches; i += 1) {
      const expired = await ctx.db
        .query("connector_turn_payloads")
        .withIndex("by_expiresAt", (q) => q.lte("expiresAt", nowMs))
        .take(limit);
      if (expired.length === 0) break;
      for (const row of expired) {
        await ctx.db.delete(row._id);
        deleted += 1;
      }
      if (expired.length < limit) break;
    }
    return deleted;
  },
});
