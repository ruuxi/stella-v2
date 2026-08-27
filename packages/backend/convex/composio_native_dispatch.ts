import { ConvexError, v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { assertOwnerMigrationWriteAllowed } from "./auth";

const NATIVE_RUN_LEASE_MS = 90_000;
const NATIVE_RUN_ABORT_GRACE_MS = 15_000;
const NATIVE_RUN_TOOL_PREFIX = "native_http:";
const SAFE_INTEGRATION_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const SAFE_ACTION_NAME = /^[A-Z][A-Z0-9_]{1,127}$/u;
const SAFE_EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,191}$/u;
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/u;
const SAFE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_SHA256 = /^[0-9a-f]{64}$/u;

const conflict = (message: string) =>
  new ConvexError({ code: "COMPOSIO_NATIVE_RUN_CONFLICT", message });

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const integrationSessionId = (row: {
  externalId?: string;
  config: Record<string, unknown>;
}): string | null => {
  const externalId = row.externalId?.trim();
  if (externalId && SAFE_EXTERNAL_ID.test(externalId)) return externalId;
  const configured = row.config.sessionId;
  return typeof configured === "string" && SAFE_EXTERNAL_ID.test(configured)
    ? configured
    : null;
};

const nativeRunToolName = (integrationId: string, action: string) =>
  `${NATIVE_RUN_TOOL_PREFIX}${integrationId}:${action}`;

const assertNativeRunIdentity = (args: {
  integrationId: string;
  toolkit: string;
  action: string;
  expectedSessionId: string;
  requestId: string;
  fingerprint: string;
  leaseId: string;
  revision: string;
}) => {
  if (
    !SAFE_INTEGRATION_ID.test(args.integrationId) ||
    !SAFE_INTEGRATION_ID.test(args.toolkit) ||
    !SAFE_ACTION_NAME.test(args.action) ||
    !SAFE_EXTERNAL_ID.test(args.expectedSessionId) ||
    !SAFE_REQUEST_ID.test(args.requestId) ||
    !SAFE_UUID.test(args.leaseId) ||
    !SAFE_SHA256.test(args.fingerprint) ||
    !args.revision ||
    args.revision.length > 128
  ) {
    throw conflict("Composio native-run dispatch identity is invalid.");
  }
};

const nativeRunClaimValidator = v.object({
  sessionId: v.string(),
  providerDeadlineAt: v.number(),
  leaseExpiresAt: v.number(),
});

/**
 * Final transactional authority immediately before POST /session/:id/execute.
 *
 * This rechecks the lifecycle generation, both ownership-migration roles, the
 * exact bound session, connector toolkit, and action revision in the same
 * transaction that publishes the durable provider-operation lease. A purge or
 * migration that wins the race blocks the insert; one that starts afterward
 * must observe the indexed lease and wait for settlement or hard expiry.
 */
export const beginComposioNativeRunInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    integrationId: v.string(),
    toolkit: v.string(),
    action: v.string(),
    revision: v.string(),
    expectedSessionId: v.string(),
    requestId: v.string(),
    fingerprint: v.string(),
    leaseId: v.string(),
    now: v.number(),
  },
  returns: nativeRunClaimValidator,
  handler: async (ctx, args) => {
    assertNativeRunIdentity(args);
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );

    const [integration, action, connection, existingReceipt] =
      await Promise.all([
        ctx.db
          .query("integrations_public")
          .withIndex("by_integrationId", (q) => q.eq("id", args.integrationId))
          .unique(),
        ctx.db
          .query("integration_actions")
          .withIndex("by_integrationId_and_name", (q) =>
            q.eq("integrationId", args.integrationId).eq("name", args.action),
          )
          .unique(),
        ctx.db
          .query("user_integrations")
          .withIndex("by_ownerId_and_provider", (q) =>
            q.eq("ownerId", args.ownerId).eq("provider", args.integrationId),
          )
          .unique(),
        ctx.db
          .query("cloud_integration_call_receipts")
          .withIndex("by_owner_generation_request", (q) =>
            q
              .eq("ownerId", args.ownerId)
              .eq("ownerGeneration", args.ownerGeneration)
              .eq("requestId", args.requestId),
          )
          .unique(),
      ]);

    const connector = asRecord(integration?.connector);
    if (
      !integration?.enabled ||
      connector?.type !== "composio" ||
      connector.toolkit !== args.toolkit ||
      !action ||
      String(action.updatedAt) !== args.revision
    ) {
      throw conflict("Composio native-run catalog authority changed.");
    }
    if (
      !connection ||
      connection.mode !== "composio" ||
      integrationSessionId(connection) !== args.expectedSessionId
    ) {
      throw conflict("Composio native-run session authority changed.");
    }
    if (existingReceipt) {
      // Native HTTP calls are intentionally non-replayable because their
      // published catalog may include destructive actions. A UUID collision or
      // action retry must never cross the provider boundary a second time. The
      // fingerprint distinction is retained in the error so an identical
      // retry and a changed-body key collision are both rejected before I/O.
      throw conflict(
        existingReceipt.fingerprint === args.fingerprint
          ? "Composio native-run request was already admitted."
          : "Composio native-run request identity was reused with different input.",
      );
    }

    const leaseExpiresAt = args.now + NATIVE_RUN_LEASE_MS;
    const providerDeadlineAt = leaseExpiresAt - NATIVE_RUN_ABORT_GRACE_MS;
    await ctx.db.insert("cloud_integration_call_receipts", {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      requestId: args.requestId,
      fingerprint: args.fingerprint,
      toolName: nativeRunToolName(args.integrationId, args.action),
      revision: args.revision,
      state: "dispatching",
      leaseId: args.leaseId,
      leaseExpiresAt,
      attempts: 1,
      createdAt: args.now,
      updatedAt: args.now,
    });
    return {
      sessionId: args.expectedSessionId,
      providerDeadlineAt,
      leaseExpiresAt,
    };
  },
});

/** Final exact receipt/lifecycle recheck immediately before provider execute. */
export const claimComposioNativeRunExecuteInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    integrationId: v.string(),
    toolkit: v.string(),
    action: v.string(),
    revision: v.string(),
    expectedSessionId: v.string(),
    requestId: v.string(),
    fingerprint: v.string(),
    leaseId: v.string(),
    now: v.number(),
  },
  returns: v.object({
    providerDeadlineAt: v.number(),
    leaseExpiresAt: v.number(),
  }),
  handler: async (ctx, args) => {
    assertNativeRunIdentity(args);
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const [integration, action, connection, receipt] = await Promise.all([
      ctx.db
        .query("integrations_public")
        .withIndex("by_integrationId", (q) => q.eq("id", args.integrationId))
        .unique(),
      ctx.db
        .query("integration_actions")
        .withIndex("by_integrationId_and_name", (q) =>
          q.eq("integrationId", args.integrationId).eq("name", args.action),
        )
        .unique(),
      ctx.db
        .query("user_integrations")
        .withIndex("by_ownerId_and_provider", (q) =>
          q.eq("ownerId", args.ownerId).eq("provider", args.integrationId),
        )
        .unique(),
      ctx.db
        .query("cloud_integration_call_receipts")
        .withIndex("by_owner_generation_request", (q) =>
          q
            .eq("ownerId", args.ownerId)
            .eq("ownerGeneration", args.ownerGeneration)
            .eq("requestId", args.requestId),
        )
        .unique(),
    ]);
    const connector = asRecord(integration?.connector);
    if (
      !integration?.enabled ||
      connector?.type !== "composio" ||
      connector.toolkit !== args.toolkit ||
      !action ||
      String(action.updatedAt) !== args.revision ||
      !connection ||
      connection.mode !== "composio" ||
      integrationSessionId(connection) !== args.expectedSessionId ||
      !receipt ||
      receipt.fingerprint !== args.fingerprint ||
      receipt.toolName !== nativeRunToolName(args.integrationId, args.action) ||
      receipt.revision !== args.revision ||
      receipt.state !== "dispatching" ||
      receipt.leaseId !== args.leaseId ||
      receipt.leaseExpiresAt === undefined ||
      receipt.errorCode !== undefined
    ) {
      throw conflict("Composio native-run execute authority changed.");
    }
    const providerDeadlineAt =
      receipt.leaseExpiresAt - NATIVE_RUN_ABORT_GRACE_MS;
    if (args.now >= providerDeadlineAt) {
      throw conflict("Composio native-run execute lease expired.");
    }
    return { providerDeadlineAt, leaseExpiresAt: receipt.leaseExpiresAt };
  },
});

/**
 * Receipt-authorized settlement remains valid after reset/delete/migration has
 * closed the owner generation. It only releases the exact lease that crossed
 * the provider boundary; it cannot create, reclaim, or replay an attempt.
 */
export const settleComposioNativeRunInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    requestId: v.string(),
    fingerprint: v.string(),
    leaseId: v.string(),
    outcome: v.union(
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("unknown"),
    ),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx: MutationCtx, args) => {
    const receipt = await ctx.db
      .query("cloud_integration_call_receipts")
      .withIndex("by_owner_generation_request", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("ownerGeneration", args.ownerGeneration)
          .eq("requestId", args.requestId),
      )
      .unique();
    if (
      !receipt ||
      receipt.fingerprint !== args.fingerprint ||
      !receipt.toolName.startsWith(NATIVE_RUN_TOOL_PREFIX)
    ) {
      throw conflict("Composio native-run dispatch receipt changed.");
    }
    // An exact settlement retry is a no-op. This covers action restarts or a
    // lost mutation response without allowing a caller to rewrite the physical
    // provider outcome after the lease was released.
    if (receipt.state !== "dispatching") {
      const alreadySettled =
        receipt.state === args.outcome &&
        (args.outcome === "succeeded"
          ? receipt.errorCode === undefined
          : receipt.errorCode === "provider_rejected");
      if (alreadySettled) return true;
      throw conflict(
        "Composio native-run outcome changed on settlement replay.",
      );
    }
    if (receipt.leaseId !== args.leaseId) {
      throw conflict("Composio native-run dispatch lease changed.");
    }
    if (receipt.errorCode === "provider_outcome_unknown") {
      if (args.outcome === "unknown") return true;
      throw conflict(
        "An unknown Composio native-run outcome cannot be rewritten.",
      );
    }
    if (args.outcome === "unknown") {
      // A timeout/transport failure does not prove the provider operation has
      // stopped. Keep the original physical lease live through its hard
      // deadline so reset/delete/migration cannot revoke the session while a
      // late provider execution may still complete.
      await ctx.db.patch(receipt._id, {
        errorCode: "provider_outcome_unknown",
        updatedAt: args.now,
      });
    } else {
      await ctx.db.patch(receipt._id, {
        state: args.outcome,
        leaseId: undefined,
        leaseExpiresAt: undefined,
        errorCode:
          args.outcome === "succeeded" ? undefined : "provider_rejected",
        updatedAt: args.now,
      });
    }
    return true;
  },
});
