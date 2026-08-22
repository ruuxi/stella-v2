import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { auditRetentionMs } from "./env";

/**
 * Metadata-only connector audit trail. The schema deliberately has no free-form
 * JSON field, so tokens, codes, state, verifiers, provider bodies, URLs, and
 * user content cannot be stored by construction. Callers pass classified enums
 * and bounded numbers only.
 */

export const CONNECTOR_AUDIT_EVENTS = [
  "connect_attempt_started",
  "connect_attempt_succeeded",
  "connect_attempt_denied",
  "connect_attempt_failed",
  "connect_attempt_expired",
  "account_bound",
  "account_unbound",
  "scope_changed",
  "token_refreshed",
  "account_revoked",
  "route_resolved",
  "execution",
] as const;

export const CONNECTOR_AUDIT_OUTCOMES = [
  "ok",
  "denied",
  "error",
  "refused",
  "rate_limited",
  "reauth_required",
  "skipped",
] as const;

const auditEventValidator = v.union(
  ...CONNECTOR_AUDIT_EVENTS.map((event) => v.literal(event)),
);
const auditOutcomeValidator = v.union(
  ...CONNECTOR_AUDIT_OUTCOMES.map((outcome) => v.literal(outcome)),
);

const MAX_SCOPE_GROUPS = 32;

export const recordConnectorAuditEvent = internalMutation({
  args: {
    ownerId: v.optional(v.string()),
    accountId: v.optional(v.string()),
    connectorId: v.optional(v.string()),
    action: v.optional(v.string()),
    provider: v.optional(v.string()),
    executor: v.optional(v.string()),
    event: auditEventValidator,
    outcome: auditOutcomeValidator,
    requestId: v.optional(v.string()),
    routeVersion: v.optional(v.number()),
    schemaVersion: v.optional(v.number()),
    scopeGroups: v.optional(v.array(v.string())),
    latencyMs: v.optional(v.number()),
    providerStatusClass: v.optional(v.string()),
    errorCode: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("connector_audit_events", {
      ownerId: args.ownerId,
      accountId: args.accountId,
      connectorId: args.connectorId,
      action: args.action,
      provider: args.provider,
      executor: args.executor,
      event: args.event,
      outcome: args.outcome,
      requestId: args.requestId,
      routeVersion: args.routeVersion,
      schemaVersion: args.schemaVersion,
      scopeGroups: args.scopeGroups?.slice(0, MAX_SCOPE_GROUPS),
      latencyMs: args.latencyMs,
      providerStatusClass: args.providerStatusClass,
      errorCode: args.errorCode,
      createdAt: now,
      expiresAt: now + auditRetentionMs(),
    });
    return null;
  },
});

export const purgeExpiredConnectorAuditEvents = internalMutation({
  args: { batchSize: v.optional(v.number()) },
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const batchSize = Math.min(
      Math.max(Math.floor(args.batchSize ?? 500), 1),
      2000,
    );
    const now = Date.now();
    const expired = await ctx.db
      .query("connector_audit_events")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(batchSize);
    await Promise.all(expired.map((row) => ctx.db.delete(row._id)));
    const hasMore = expired.length === batchSize;
    if (hasMore) {
      await ctx.scheduler.runAfter(
        0,
        internal.connectors.audit.purgeExpiredConnectorAuditEvents,
        { batchSize },
      );
    }
    return { deleted: expired.length, hasMore };
  },
});
