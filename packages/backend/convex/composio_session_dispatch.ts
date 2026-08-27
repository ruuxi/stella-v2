import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { assertOwnerMigrationWriteAllowed } from "./auth";
import { assertOwnerPurgeLease } from "./owner_lifecycle";

const COMPOSIO_SESSION_PROVIDER_TIMEOUT_MS = 30_000;
const COMPOSIO_SESSION_ABORT_GRACE_MS = 15_000;
const COMPOSIO_CLEANUP_WATCHDOG_MS = 5 * 60_000;
const MAX_CLEANUP_SWEEP_ROWS_PER_STATE = 32;
const MAX_PROVISIONING_ROWS_PER_PASS = 16;
const MAX_PENDING_LABELS = 24;
const SAFE_PROVIDER = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const SAFE_EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,191}$/u;
const SAFE_ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SAFE_OPERATOR_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/u;
const MAX_RESOLUTION_EVIDENCE_LENGTH = 512;

type ProvisioningRow = Doc<"composio_session_provisioning_attempts">;

const cleanupAttemptRef = makeFunctionReference<
  "action",
  { attemptId: string; leaseId: string },
  null
>("composio_session_cleanup:cleanupComposioSessionProvisioningInternal");

const provisioningStateValidator = v.union(
  v.literal("reserved"),
  v.literal("dispatching"),
  v.literal("outcome_unknown"),
  v.literal("locator_recorded"),
  v.literal("cleanup_pending"),
);

const pendingResultValidator = v.object({
  ready: v.boolean(),
  pending: v.array(v.string()),
  retryAt: v.union(v.number(), v.null()),
});

const conflict = (message: string) =>
  new ConvexError({ code: "COMPOSIO_SESSION_CONFLICT", message });

const composioAuditHash = async (
  kind: "user" | "session" | "operator" | "evidence",
  value: string,
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`stella-composio-audit-v1\0${kind}\0${value}`),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const validateProvisioningIdentity = (args: {
  integrationId: string;
  toolkit: string;
  composioUserId: string;
  attemptId: string;
  leaseId: string;
}) => {
  if (
    !SAFE_PROVIDER.test(args.integrationId) ||
    !SAFE_PROVIDER.test(args.toolkit) ||
    !SAFE_EXTERNAL_ID.test(args.composioUserId) ||
    !SAFE_ATTEMPT_ID.test(args.attemptId) ||
    !SAFE_ATTEMPT_ID.test(args.leaseId)
  ) {
    throw conflict("Composio session provisioning identity is invalid.");
  }
};

const integrationSessionId = (row: {
  externalId?: string;
  config: Record<string, unknown>;
}): string | null => {
  const external = row.externalId?.trim();
  if (external && SAFE_EXTERNAL_ID.test(external)) return external;
  const configured = row.config.sessionId;
  return typeof configured === "string" && SAFE_EXTERNAL_ID.test(configured)
    ? configured
    : null;
};

const readIntegration = async (
  ctx: MutationCtx,
  ownerId: string,
  integrationId: string,
) =>
  await ctx.db
    .query("user_integrations")
    .withIndex("by_ownerId_and_provider", (q) =>
      q.eq("ownerId", ownerId).eq("provider", integrationId),
    )
    .unique();

const matchingBoundSessionId = async (
  ctx: MutationCtx,
  row: ProvisioningRow,
): Promise<string | null> => {
  const integration = await readIntegration(
    ctx,
    row.ownerId,
    row.integrationId,
  );
  if (!integration || integration.mode !== "composio") return null;
  const sessionId = integrationSessionId(integration);
  if (!sessionId) return null;
  // Once POST may have crossed the provider boundary, only the exact captured
  // locator proves this integration resolves that attempt. A different bound
  // session must never erase unknown orphan-session debt.
  if (!row.sessionId) return row.state === "reserved" ? sessionId : null;
  return row.sessionId === sessionId ? sessionId : null;
};

const readAttempt = async (ctx: MutationCtx, attemptId: string) =>
  await ctx.db
    .query("composio_session_provisioning_attempts")
    .withIndex("by_attemptId", (q) => q.eq("attemptId", attemptId))
    .unique();

const assertExactAttempt = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    attemptId: string;
    leaseId: string;
  },
) => {
  const row = await readAttempt(ctx, args.attemptId);
  if (
    !row ||
    row.ownerId !== args.ownerId ||
    row.ownerGeneration !== args.ownerGeneration ||
    row.leaseId !== args.leaseId
  ) {
    throw conflict("Composio session provisioning receipt changed.");
  }
  return row;
};

const cancelCleanup = async (ctx: MutationCtx, row: ProvisioningRow) => {
  if (!row.cleanupJobId) return;
  try {
    await ctx.scheduler.cancel(row.cleanupJobId);
  } catch {
    // A scheduled action can already be running or complete. Exact row
    // identity, not scheduler state, remains the acknowledgement authority.
  }
};

const scheduleCleanup = async (
  ctx: MutationCtx,
  row: ProvisioningRow,
  at: number,
  updatedAt: number,
  options?: { cancelExisting?: boolean },
) => {
  if (row.cleanupJobId && options?.cancelExisting !== false) {
    await cancelCleanup(ctx, row);
  }
  const cleanupJobId = await ctx.scheduler.runAt(at, cleanupAttemptRef, {
    attemptId: row.attemptId,
    leaseId: row.leaseId,
  });
  await ctx.db.patch(row._id, {
    cleanupJobId,
    nextCleanupAt: at,
    updatedAt,
  });
  return cleanupJobId;
};

const reserveResultValidator = v.union(
  v.object({
    acquired: v.literal(true),
    status: v.literal("reserved"),
    providerDeadlineAt: v.number(),
    quiescentAfterAt: v.number(),
  }),
  v.object({
    acquired: v.literal(false),
    status: v.literal("busy"),
  }),
  v.object({
    acquired: v.literal(false),
    status: v.literal("outcome_unknown"),
  }),
  v.object({
    acquired: v.literal(false),
    status: v.literal("bound"),
    sessionId: v.string(),
  }),
);

const markStartedResultValidator = v.union(
  v.object({ started: v.literal(false) }),
  v.object({
    started: v.literal(true),
    providerDeadlineAt: v.number(),
    quiescentAfterAt: v.number(),
  }),
);

/**
 * Serializable pre-provider reservation. The lifecycle generation and both
 * migration roles are checked in the transaction that creates the durable
 * attempt. A second caller cannot cross the POST boundary for the same
 * owner/integration while any prior attempt remains unresolved.
 */
export const reserveComposioSessionProvisioningInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    integrationId: v.string(),
    toolkit: v.string(),
    composioUserId: v.string(),
    attemptId: v.string(),
    leaseId: v.string(),
    now: v.number(),
  },
  returns: reserveResultValidator,
  handler: async (ctx, args) => {
    validateProvisioningIdentity(args);
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );

    const bound = await readIntegration(ctx, args.ownerId, args.integrationId);
    if (bound?.mode === "composio") {
      const sessionId = integrationSessionId(bound);
      if (sessionId) {
        return {
          acquired: false as const,
          status: "bound" as const,
          sessionId,
        };
      }
    }

    const existing = await ctx.db
      .query("composio_session_provisioning_attempts")
      .withIndex("by_ownerId_and_integrationId", (q) =>
        q.eq("ownerId", args.ownerId).eq("integrationId", args.integrationId),
      )
      .unique();
    if (existing) {
      if (
        existing.ownerGeneration !== args.ownerGeneration ||
        existing.toolkit !== args.toolkit ||
        existing.composioUserId !== args.composioUserId
      ) {
        throw conflict("Composio session provisioning binding changed.");
      }
      const boundSessionId = await matchingBoundSessionId(ctx, existing);
      if (boundSessionId) {
        await cancelCleanup(ctx, existing);
        await ctx.db.delete(existing._id);
        return {
          acquired: false as const,
          status: "bound" as const,
          sessionId: boundSessionId,
        };
      }
      if (
        existing.state === "reserved" &&
        args.now >= existing.quiescentAfterAt
      ) {
        await cancelCleanup(ctx, existing);
        await ctx.db.delete(existing._id);
      } else {
        return existing.state === "outcome_unknown"
          ? { acquired: false as const, status: "outcome_unknown" as const }
          : { acquired: false as const, status: "busy" as const };
      }
    }

    const providerDeadlineAt = args.now + COMPOSIO_SESSION_PROVIDER_TIMEOUT_MS;
    const quiescentAfterAt =
      providerDeadlineAt + COMPOSIO_SESSION_ABORT_GRACE_MS;
    const cleanupJobId = await ctx.scheduler.runAt(
      quiescentAfterAt,
      cleanupAttemptRef,
      { attemptId: args.attemptId, leaseId: args.leaseId },
    );
    await ctx.db.insert("composio_session_provisioning_attempts", {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      integrationId: args.integrationId,
      toolkit: args.toolkit,
      composioUserId: args.composioUserId,
      attemptId: args.attemptId,
      leaseId: args.leaseId,
      state: "reserved",
      providerDeadlineAt,
      quiescentAfterAt,
      cleanupJobId,
      cleanupAttempts: 0,
      nextCleanupAt: quiescentAfterAt,
      createdAt: args.now,
      updatedAt: args.now,
    });
    return {
      acquired: true as const,
      status: "reserved" as const,
      providerDeadlineAt,
      quiescentAfterAt,
    };
  },
});

/** Last transaction before POST /session. */
export const markComposioSessionProvisioningMayHaveStartedInternal =
  internalMutation({
    args: {
      ownerId: v.string(),
      ownerGeneration: v.string(),
      attemptId: v.string(),
      leaseId: v.string(),
      now: v.number(),
    },
    returns: markStartedResultValidator,
    handler: async (ctx, args) => {
      await assertOwnerMigrationWriteAllowed(
        ctx,
        args.ownerId,
        args.ownerGeneration,
      );
      const row = await assertExactAttempt(ctx, args);
      if (row.state !== "reserved" || args.now >= row.providerDeadlineAt) {
        return { started: false as const };
      }
      const providerDeadlineAt =
        args.now + COMPOSIO_SESSION_PROVIDER_TIMEOUT_MS;
      const quiescentAfterAt =
        providerDeadlineAt + COMPOSIO_SESSION_ABORT_GRACE_MS;
      await cancelCleanup(ctx, row);
      const cleanupJobId = await ctx.scheduler.runAt(
        quiescentAfterAt,
        cleanupAttemptRef,
        { attemptId: row.attemptId, leaseId: row.leaseId },
      );
      await ctx.db.patch(row._id, {
        state: "dispatching",
        providerDeadlineAt,
        quiescentAfterAt,
        cleanupJobId,
        nextCleanupAt: quiescentAfterAt,
        updatedAt: args.now,
      });
      return {
        started: true as const,
        providerDeadlineAt,
        quiescentAfterAt,
      };
    },
  });

/** Receipt-authorized locator capture remains valid after lifecycle closure. */
export const recordComposioSessionProvisioningLocatorInternal =
  internalMutation({
    args: {
      ownerId: v.string(),
      ownerGeneration: v.string(),
      attemptId: v.string(),
      leaseId: v.string(),
      sessionId: v.string(),
      now: v.number(),
    },
    returns: v.boolean(),
    handler: async (ctx, args) => {
      if (!SAFE_EXTERNAL_ID.test(args.sessionId)) {
        throw conflict("Composio returned an invalid session locator.");
      }
      const row = await assertExactAttempt(ctx, args);
      if (row.sessionId && row.sessionId !== args.sessionId) {
        throw conflict("Composio session locator changed on replay.");
      }
      if (
        row.state === "locator_recorded" &&
        row.sessionId === args.sessionId
      ) {
        return true;
      }
      if (row.state !== "dispatching" && row.state !== "outcome_unknown") {
        throw conflict("Composio session locator arrived in an invalid state.");
      }
      await ctx.db.patch(row._id, {
        state: "locator_recorded",
        sessionId: args.sessionId,
        lastError: undefined,
        updatedAt: args.now,
      });
      if (row.state === "outcome_unknown") {
        await scheduleCleanup(
          ctx,
          {
            ...row,
            state: "locator_recorded",
            sessionId: args.sessionId,
          },
          Math.max(args.now, row.quiescentAfterAt),
          args.now,
        );
      }
      return true;
    },
  });

/**
 * Atomically publishes the durable local locator and retires the transient
 * provisioning receipt. A cleanup worker and a binder serialize on this row;
 * once cleanup wins, no late bind can resurrect a session being deleted.
 */
export const bindComposioSessionProvisioningInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    integrationId: v.string(),
    toolkit: v.string(),
    composioUserId: v.string(),
    attemptId: v.string(),
    leaseId: v.string(),
    sessionId: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const row = await assertExactAttempt(ctx, args);
    const operatorResolution = await ctx.db
      .query("composio_session_provisioning_resolutions")
      .withIndex("by_attemptId", (q) => q.eq("attemptId", args.attemptId))
      .unique();
    if (
      operatorResolution ||
      row.integrationId !== args.integrationId ||
      row.toolkit !== args.toolkit ||
      row.composioUserId !== args.composioUserId ||
      row.sessionId !== args.sessionId ||
      row.state !== "locator_recorded"
    ) {
      throw conflict("Composio session bind receipt changed.");
    }
    const existing = await readIntegration(
      ctx,
      args.ownerId,
      args.integrationId,
    );
    if (existing) {
      const existingSessionId = integrationSessionId(existing);
      if (
        existing.mode !== "composio" ||
        (existingSessionId && existingSessionId !== args.sessionId)
      ) {
        throw conflict("A different integration locator is already bound.");
      }
      await ctx.db.patch(existing._id, {
        mode: "composio",
        externalId: args.sessionId,
        config: {
          composioUserId: args.composioUserId,
          composioToolkit: args.toolkit,
        },
        updatedAt: args.now,
      });
    } else {
      await ctx.db.insert("user_integrations", {
        ownerId: args.ownerId,
        provider: args.integrationId,
        mode: "composio",
        externalId: args.sessionId,
        config: {
          composioUserId: args.composioUserId,
          composioToolkit: args.toolkit,
        },
        createdAt: args.now,
        updatedAt: args.now,
      });
    }
    await cancelCleanup(ctx, row);
    await ctx.db.delete(row._id);
    return true;
  },
});

/** Authoritative pre-dispatch or provider-rejected no-create settlement. */
export const settleComposioSessionProvisioningNotCreatedInternal =
  internalMutation({
    args: {
      ownerId: v.string(),
      ownerGeneration: v.string(),
      attemptId: v.string(),
      leaseId: v.string(),
    },
    returns: v.boolean(),
    handler: async (ctx, args) => {
      const row = await assertExactAttempt(ctx, args);
      if (row.sessionId || row.state === "locator_recorded") {
        throw conflict("A captured Composio session cannot be non-created.");
      }
      if (row.state !== "reserved" && row.state !== "dispatching") {
        return false;
      }
      await cancelCleanup(ctx, row);
      await ctx.db.delete(row._id);
      return true;
    },
  });

/**
 * Recovers a scheduled cleanup action that terminated before its first claim.
 * Each due row receives an immediate replacement plus a durable future wake,
 * so an at-most-once scheduler failure can delay cleanup but cannot strand it.
 */
export const sweepDueComposioSessionProvisioningCleanupInternal =
  internalMutation({
    args: {
      now: v.optional(v.number()),
      limitPerState: v.optional(v.number()),
    },
    returns: v.object({ scheduled: v.number() }),
    handler: async (ctx, args) => {
      const now = args.now ?? Date.now();
      const limitPerState = Math.min(
        MAX_CLEANUP_SWEEP_ROWS_PER_STATE,
        Math.max(1, Math.floor(args.limitPerState ?? 8)),
      );
      let scheduled = 0;
      for (const state of [
        "reserved",
        "dispatching",
        "locator_recorded",
        "cleanup_pending",
      ] as const) {
        const rows = await ctx.db
          .query("composio_session_provisioning_attempts")
          .withIndex("by_state_and_nextCleanupAt", (q) =>
            q
              .eq("state", state)
              .gte("nextCleanupAt", 0)
              .lte("nextCleanupAt", now),
          )
          .take(limitPerState);
        for (const row of rows) {
          await cancelCleanup(ctx, row);
          const cleanupJobId = await ctx.scheduler.runAfter(
            0,
            cleanupAttemptRef,
            { attemptId: row.attemptId, leaseId: row.leaseId },
          );
          await ctx.db.patch(row._id, {
            cleanupJobId,
            // If this replacement also dies before claiming, the next sweep
            // retries after a bounded watchdog interval instead of every cron.
            nextCleanupAt: now + COMPOSIO_CLEANUP_WATCHDOG_MS,
            updatedAt: now,
          });
          scheduled += 1;
        }
      }
      return { scheduled };
    },
  });

/**
 * A lost create response has no provider reconciliation API. Retain this debt
 * permanently and reject all redispatch until provider/manual reconciliation
 * supplies the missing locator or confirms non-creation.
 */
export const markComposioSessionProvisioningOutcomeUnknownInternal =
  internalMutation({
    args: {
      ownerId: v.string(),
      ownerGeneration: v.string(),
      attemptId: v.string(),
      leaseId: v.string(),
      now: v.number(),
      reason: v.string(),
    },
    returns: v.boolean(),
    handler: async (ctx, args) => {
      const row = await assertExactAttempt(ctx, args);
      if (row.sessionId) return false;
      if (row.state === "outcome_unknown") return true;
      if (row.state !== "dispatching") return false;
      await ctx.db.patch(row._id, {
        state: "outcome_unknown",
        lastError: args.reason.slice(0, 256),
        nextCleanupAt: undefined,
        updatedAt: args.now,
      });
      return true;
    },
  });

const operatorResolutionValidator = v.union(
  v.object({
    kind: v.literal("recovered_session"),
    sessionId: v.string(),
  }),
  v.object({ kind: v.literal("provider_confirmed_not_created") }),
);

const operatorResolutionResultValidator = v.object({
  resolution: v.union(
    v.literal("recovered_session"),
    v.literal("provider_confirmed_not_created"),
  ),
  replayed: v.boolean(),
});

/**
 * Exact, audited operator recovery for a create whose provider response was
 * lost. This deliberately has no arbitrary "drop" branch: the operator must
 * either supply the recovered session locator (which enters durable cleanup)
 * or record provider evidence that no session was created.
 */
export const resolveComposioSessionProvisioningOutcomeInternal =
  internalMutation({
    args: {
      ownerId: v.string(),
      ownerGeneration: v.string(),
      integrationId: v.string(),
      toolkit: v.string(),
      composioUserId: v.string(),
      attemptId: v.string(),
      leaseId: v.string(),
      resolution: operatorResolutionValidator,
      resolvedBy: v.string(),
      evidence: v.string(),
      now: v.number(),
    },
    returns: operatorResolutionResultValidator,
    handler: async (ctx, args) => {
      validateProvisioningIdentity(args);
      const resolvedBy = args.resolvedBy.trim();
      const evidence = args.evidence.trim();
      if (
        !SAFE_OPERATOR_ID.test(resolvedBy) ||
        !evidence ||
        evidence.length > MAX_RESOLUTION_EVIDENCE_LENGTH
      ) {
        throw conflict("Composio operator resolution evidence is invalid.");
      }
      const sessionId =
        args.resolution.kind === "recovered_session"
          ? args.resolution.sessionId.trim()
          : undefined;
      if (sessionId !== undefined && !SAFE_EXTERNAL_ID.test(sessionId)) {
        throw conflict("Recovered Composio session locator is invalid.");
      }
      const [composioUserIdHash, sessionIdHash, resolvedByHash, evidenceHash] =
        await Promise.all([
          composioAuditHash("user", args.composioUserId),
          sessionId === undefined
            ? Promise.resolve(undefined)
            : composioAuditHash("session", sessionId),
          composioAuditHash("operator", resolvedBy),
          composioAuditHash("evidence", evidence),
        ]);

      const existingResolution = await ctx.db
        .query("composio_session_provisioning_resolutions")
        .withIndex("by_attemptId", (q) => q.eq("attemptId", args.attemptId))
        .unique();
      if (existingResolution) {
        if (
          existingResolution.ownerId !== args.ownerId ||
          existingResolution.ownerGeneration !== args.ownerGeneration ||
          existingResolution.integrationId !== args.integrationId ||
          existingResolution.toolkit !== args.toolkit ||
          existingResolution.composioUserIdHash !== composioUserIdHash ||
          existingResolution.leaseId !== args.leaseId ||
          existingResolution.resolution !== args.resolution.kind ||
          existingResolution.sessionIdHash !== sessionIdHash ||
          existingResolution.resolvedByHash !== resolvedByHash ||
          existingResolution.evidenceHash !== evidenceHash
        ) {
          throw conflict(
            "Composio operator resolution does not match its audit.",
          );
        }
        return {
          resolution: existingResolution.resolution,
          replayed: true,
        };
      }

      const row = await assertExactAttempt(ctx, args);
      if (
        row.integrationId !== args.integrationId ||
        row.toolkit !== args.toolkit ||
        row.composioUserId !== args.composioUserId ||
        row.state !== "outcome_unknown" ||
        row.sessionId
      ) {
        throw conflict(
          "Only an exact unknown Composio outcome can be resolved.",
        );
      }

      await ctx.db.insert("composio_session_provisioning_resolutions", {
        ownerId: row.ownerId,
        ownerGeneration: row.ownerGeneration,
        integrationId: row.integrationId,
        toolkit: row.toolkit,
        composioUserIdHash,
        attemptId: row.attemptId,
        leaseId: row.leaseId,
        resolution: args.resolution.kind,
        sessionIdHash,
        resolvedByHash,
        evidenceHash,
        resolvedAt: args.now,
      });

      if (sessionId === undefined) {
        await cancelCleanup(ctx, row);
        await ctx.db.delete(row._id);
      } else {
        await ctx.db.patch(row._id, {
          state: "locator_recorded",
          sessionId,
          lastError: "Operator recovered the exact Composio session locator.",
          updatedAt: args.now,
        });
        await scheduleCleanup(
          ctx,
          { ...row, state: "locator_recorded", sessionId },
          Math.max(args.now, row.quiescentAfterAt),
          args.now,
        );
      }
      return { resolution: args.resolution.kind, replayed: false };
    },
  });

/** Durable immediate cleanup request for a known, unbound provider locator. */
export const requestComposioSessionProvisioningCleanupInternal =
  internalMutation({
    args: {
      ownerId: v.string(),
      ownerGeneration: v.string(),
      attemptId: v.string(),
      leaseId: v.string(),
      sessionId: v.string(),
      now: v.number(),
      reason: v.string(),
    },
    returns: v.boolean(),
    handler: async (ctx, args) => {
      const row = await assertExactAttempt(ctx, args);
      if (row.sessionId !== args.sessionId) {
        throw conflict("Composio cleanup locator changed.");
      }
      if (row.state !== "locator_recorded" && row.state !== "cleanup_pending") {
        return false;
      }
      await ctx.db.patch(row._id, {
        state: "cleanup_pending",
        lastError: args.reason.slice(0, 256),
        updatedAt: args.now,
      });
      await scheduleCleanup(
        ctx,
        { ...row, state: "cleanup_pending" },
        args.now,
        args.now,
      );
      return true;
    },
  });

const cleanupClaimValidator = v.union(
  v.object({ kind: v.literal("absent") }),
  v.object({ kind: v.literal("bound") }),
  v.object({ kind: v.literal("outcome_unknown") }),
  v.object({ kind: v.literal("wait"), retryAt: v.number() }),
  v.object({
    kind: v.literal("cleanup"),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    integrationId: v.string(),
    toolkit: v.string(),
    composioUserId: v.string(),
    sessionId: v.string(),
  }),
);

/** Action-side claim that serializes remote deletion against local binding. */
export const claimComposioSessionProvisioningCleanupInternal = internalMutation(
  {
    args: { attemptId: v.string(), leaseId: v.string(), now: v.number() },
    returns: cleanupClaimValidator,
    handler: async (ctx, args) => {
      const row = await readAttempt(ctx, args.attemptId);
      if (!row || row.leaseId !== args.leaseId)
        return { kind: "absent" as const };
      const boundSessionId = await matchingBoundSessionId(ctx, row);
      if (boundSessionId) {
        await cancelCleanup(ctx, row);
        await ctx.db.delete(row._id);
        return { kind: "bound" as const };
      }
      if (!row.sessionId) {
        if (row.state === "reserved") {
          if (args.now < row.quiescentAfterAt) {
            await scheduleCleanup(ctx, row, row.quiescentAfterAt, args.now, {
              // The stored job is the action currently making this claim; a
              // scheduled function must never cancel itself while running.
              cancelExisting: false,
            });
            return { kind: "wait" as const, retryAt: row.quiescentAfterAt };
          }
          await cancelCleanup(ctx, row);
          await ctx.db.delete(row._id);
          return { kind: "absent" as const };
        }
        if (row.state === "dispatching" && args.now < row.quiescentAfterAt) {
          await scheduleCleanup(ctx, row, row.quiescentAfterAt, args.now, {
            cancelExisting: false,
          });
          return { kind: "wait" as const, retryAt: row.quiescentAfterAt };
        }
        if (row.state === "dispatching") {
          await ctx.db.patch(row._id, {
            state: "outcome_unknown",
            nextCleanupAt: undefined,
            lastError: "Composio create response was not captured.",
            updatedAt: args.now,
          });
        }
        return { kind: "outcome_unknown" as const };
      }
      if (row.state === "locator_recorded" && args.now < row.quiescentAfterAt) {
        await scheduleCleanup(ctx, row, row.quiescentAfterAt, args.now, {
          cancelExisting: false,
        });
        return { kind: "wait" as const, retryAt: row.quiescentAfterAt };
      }
      await ctx.db.patch(row._id, {
        state: "cleanup_pending",
        updatedAt: args.now,
      });
      // Publish the next wake before returning provider authority to the
      // action. A worker crash after this claim therefore cannot strand the
      // exact session locator outside an active purge.
      await scheduleCleanup(
        ctx,
        { ...row, state: "cleanup_pending" },
        args.now + COMPOSIO_CLEANUP_WATCHDOG_MS,
        args.now,
        { cancelExisting: false },
      );
      return {
        kind: "cleanup" as const,
        ownerId: row.ownerId,
        ownerGeneration: row.ownerGeneration,
        integrationId: row.integrationId,
        toolkit: row.toolkit,
        composioUserId: row.composioUserId,
        sessionId: row.sessionId,
      };
    },
  },
);

/** Delete the durable locator only after provider GET has confirmed 404. */
export const acknowledgeComposioSessionProvisioningDeletedInternal =
  internalMutation({
    args: {
      attemptId: v.string(),
      leaseId: v.string(),
      sessionId: v.string(),
      now: v.number(),
    },
    returns: v.boolean(),
    handler: async (ctx, args) => {
      const row = await readAttempt(ctx, args.attemptId);
      if (!row) return true;
      if (
        row.leaseId !== args.leaseId ||
        row.sessionId !== args.sessionId ||
        row.state !== "cleanup_pending"
      ) {
        throw conflict("Composio cleanup acknowledgement changed.");
      }
      const resolution = await ctx.db
        .query("composio_session_provisioning_resolutions")
        .withIndex("by_attemptId", (q) => q.eq("attemptId", row.attemptId))
        .unique();
      if (resolution) {
        const [composioUserIdHash, sessionIdHash] = await Promise.all([
          composioAuditHash("user", row.composioUserId),
          composioAuditHash("session", row.sessionId),
        ]);
        if (
          resolution.ownerId !== row.ownerId ||
          resolution.ownerGeneration !== row.ownerGeneration ||
          resolution.integrationId !== row.integrationId ||
          resolution.toolkit !== row.toolkit ||
          resolution.composioUserIdHash !== composioUserIdHash ||
          resolution.leaseId !== row.leaseId ||
          resolution.resolution !== "recovered_session" ||
          resolution.sessionIdHash !== sessionIdHash
        ) {
          throw conflict("Composio cleanup audit changed.");
        }
        await ctx.db.patch(resolution._id, {
          cleanupCompletedAt: args.now,
        });
      }
      await cancelCleanup(ctx, row);
      await ctx.db.delete(row._id);
      return true;
    },
  });

export const recordComposioSessionProvisioningCleanupFailureInternal =
  internalMutation({
    args: {
      attemptId: v.string(),
      leaseId: v.string(),
      sessionId: v.string(),
      now: v.number(),
      reason: v.string(),
    },
    returns: v.union(v.number(), v.null()),
    handler: async (ctx, args) => {
      const row = await readAttempt(ctx, args.attemptId);
      if (!row) return null;
      if (
        row.leaseId !== args.leaseId ||
        row.sessionId !== args.sessionId ||
        row.state !== "cleanup_pending"
      ) {
        throw conflict("Composio cleanup failure receipt changed.");
      }
      const cleanupAttempts = row.cleanupAttempts + 1;
      const backoffMs = Math.min(
        5 * 60_000,
        1_000 * 2 ** Math.min(cleanupAttempts - 1, 8),
      );
      const nextCleanupAt = args.now + backoffMs;
      await cancelCleanup(ctx, row);
      const cleanupJobId = await ctx.scheduler.runAt(
        nextCleanupAt,
        cleanupAttemptRef,
        { attemptId: row.attemptId, leaseId: row.leaseId },
      );
      await ctx.db.patch(row._id, {
        cleanupAttempts,
        cleanupJobId,
        nextCleanupAt,
        lastError: args.reason.slice(0, 256),
        updatedAt: args.now,
      });
      return nextCleanupAt;
    },
  });

export const getComposioSessionProvisioningAttemptInternal = internalQuery({
  args: { attemptId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      ownerId: v.string(),
      ownerGeneration: v.string(),
      integrationId: v.string(),
      toolkit: v.string(),
      composioUserId: v.string(),
      attemptId: v.string(),
      leaseId: v.string(),
      state: provisioningStateValidator,
      sessionId: v.optional(v.string()),
      providerDeadlineAt: v.number(),
      quiescentAfterAt: v.number(),
      cleanupAttempts: v.number(),
      nextCleanupAt: v.optional(v.number()),
      lastError: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("composio_session_provisioning_attempts")
      .withIndex("by_attemptId", (q) => q.eq("attemptId", args.attemptId))
      .unique();
    if (!row) return null;
    return {
      ownerId: row.ownerId,
      ownerGeneration: row.ownerGeneration,
      integrationId: row.integrationId,
      toolkit: row.toolkit,
      composioUserId: row.composioUserId,
      attemptId: row.attemptId,
      leaseId: row.leaseId,
      state: row.state,
      sessionId: row.sessionId,
      providerDeadlineAt: row.providerDeadlineAt,
      quiescentAfterAt: row.quiescentAfterAt,
      cleanupAttempts: row.cleanupAttempts,
      nextCleanupAt: row.nextCleanupAt,
      lastError: row.lastError,
    };
  },
});

/**
 * Transaction helper for reset/delete/migration owners. Callers must prove
 * their purge or dual-owner migration lease in the same mutation before this
 * helper. It never removes marked unknown debt and never removes a known
 * locator until provider cleanup or matching bound integration is proven.
 */
export const quiesceOwnerComposioSessionProvisioning = async (
  ctx: MutationCtx,
  args: { ownerId: string; now: number },
): Promise<{ ready: boolean; pending: string[]; retryAt: number | null }> => {
  const rows = await ctx.db
    .query("composio_session_provisioning_attempts")
    .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", args.ownerId))
    .take(MAX_PROVISIONING_ROWS_PER_PASS + 1);
  const pending: string[] = [];
  const retryTimes: number[] = [];
  for (const row of rows.slice(0, MAX_PROVISIONING_ROWS_PER_PASS)) {
    const boundSessionId = await matchingBoundSessionId(ctx, row);
    if (boundSessionId) {
      await cancelCleanup(ctx, row);
      await ctx.db.delete(row._id);
      continue;
    }
    if (row.state === "reserved") {
      await cancelCleanup(ctx, row);
      await ctx.db.delete(row._id);
      continue;
    }
    if (row.sessionId) {
      if (
        row.state !== "cleanup_pending" ||
        !row.nextCleanupAt ||
        row.nextCleanupAt <= args.now
      ) {
        await ctx.db.patch(row._id, {
          state: "cleanup_pending",
          updatedAt: args.now,
        });
        await scheduleCleanup(
          ctx,
          { ...row, state: "cleanup_pending" },
          args.now,
          args.now,
        );
      }
      pending.push(`composio_session_cleanup_pending:${row.integrationId}`);
      retryTimes.push(row.nextCleanupAt ?? args.now);
      continue;
    }
    const overdueDispatch =
      row.state === "dispatching" && args.now >= row.quiescentAfterAt;
    if (overdueDispatch) {
      await ctx.db.patch(row._id, {
        state: "outcome_unknown",
        nextCleanupAt: undefined,
        lastError: "Composio create response was not captured.",
        updatedAt: args.now,
      });
    }
    pending.push(
      row.state === "outcome_unknown" || overdueDispatch
        ? `composio_session_outcome_unknown:${row.integrationId}`
        : `composio_session_dispatching:${row.integrationId}`,
    );
    if (args.now < row.quiescentAfterAt) {
      retryTimes.push(row.quiescentAfterAt);
    }
  }
  if (rows.length > MAX_PROVISIONING_ROWS_PER_PASS) {
    pending.push("composio_session_provisioning:additional_rows");
    retryTimes.push(args.now);
  }
  return {
    ready: pending.length === 0,
    pending: pending.slice(0, MAX_PENDING_LABELS),
    retryAt:
      pending.length === 0 || retryTimes.length === 0
        ? null
        : Math.min(...retryTimes),
  };
};

export const quiesceOwnerComposioSessionProvisioningForPurgeInternal =
  internalMutation({
    args: {
      ownerId: v.string(),
      operationId: v.string(),
      generation: v.string(),
      leaseId: v.string(),
      mode: v.union(v.literal("reset"), v.literal("delete")),
      now: v.number(),
    },
    returns: pendingResultValidator,
    handler: async (ctx, args) => {
      await assertOwnerPurgeLease(ctx, { ...args, stage: "core" });
      const provisioning = await quiesceOwnerComposioSessionProvisioning(
        ctx,
        args,
      );
      if (!provisioning.ready) return provisioning;

      // Resolution audits are hash-only but still owner-scoped. Reset and
      // deletion remove them in a bounded, purge-lease-fenced pass after every
      // provider attempt/known locator is quiescent. This prevents stale owner
      // identity from surviving the lifecycle generation rotation.
      const resolutions = await ctx.db
        .query("composio_session_provisioning_resolutions")
        .withIndex("by_ownerId_and_resolvedAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .take(MAX_PROVISIONING_ROWS_PER_PASS + 1);
      await Promise.all(
        resolutions
          .slice(0, MAX_PROVISIONING_ROWS_PER_PASS)
          .map((row) => ctx.db.delete(row._id)),
      );
      if (resolutions.length > MAX_PROVISIONING_ROWS_PER_PASS) {
        return {
          ready: false,
          pending: ["composio_session_resolution_audit:additional_rows"],
          retryAt: args.now,
        };
      }
      return provisioning;
    },
  });

export const remainingOwnerComposioSessionProvisioningInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const [rows, resolutions] = await Promise.all([
      ctx.db
        .query("composio_session_provisioning_attempts")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .take(MAX_PENDING_LABELS + 1),
      ctx.db
        .query("composio_session_provisioning_resolutions")
        .withIndex("by_ownerId_and_resolvedAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .take(MAX_PENDING_LABELS + 1),
    ]);
    const labels = rows
      .slice(0, MAX_PENDING_LABELS)
      .map((row) =>
        row.state === "outcome_unknown"
          ? `composio_session_outcome_unknown:${row.integrationId}`
          : row.sessionId
            ? `composio_session_cleanup_pending:${row.integrationId}`
            : `composio_session_${row.state}:${row.integrationId}`,
      );
    const resolutionCapacity = Math.max(0, MAX_PENDING_LABELS - labels.length);
    for (const row of resolutions.slice(0, resolutionCapacity)) {
      labels.push(`composio_session_resolution_audit:${row.integrationId}`);
    }
    if (rows.length > MAX_PENDING_LABELS) {
      labels.push("composio_session_provisioning:additional_rows");
    } else if (resolutions.length > resolutionCapacity) {
      labels.push("composio_session_resolution_audit:additional_rows");
    }
    return labels.slice(0, MAX_PENDING_LABELS + 1);
  },
});
