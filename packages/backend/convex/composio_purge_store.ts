import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { assertOwnerPurgeLease } from "./owner_lifecycle";
import { hashSha256Hex } from "./lib/crypto_utils";

const MAX_COMPOSIO_PURGE_BATCH = 4;
const MAX_COMPOSIO_READBACK = 24;
const SAFE_PROVIDER = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const SAFE_EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,191}$/u;
const SAFE_RESOLUTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SAFE_OPERATOR_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/u;
const MAX_OPERATOR_EVIDENCE_LENGTH = 1_024;

const optionalSafeString = (
  value: unknown,
  pattern: RegExp,
): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return pattern.test(trimmed) ? trimmed : undefined;
};

const rowSessionId = (row: {
  externalId?: string;
  config: Record<string, unknown>;
}): string | undefined =>
  optionalSafeString(row.externalId, SAFE_EXTERNAL_ID) ??
  optionalSafeString(row.config.sessionId, SAFE_EXTERNAL_ID);

const rowComposioUserId = (row: {
  config: Record<string, unknown>;
}): string | undefined =>
  optionalSafeString(row.config.composioUserId, SAFE_EXTERNAL_ID);

const purgeLocatorValidator = v.object({
  id: v.id("user_integrations"),
  provider: v.string(),
  toolkit: v.string(),
  sessionId: v.optional(v.string()),
  composioUserId: v.optional(v.string()),
  composioUserIds: v.array(v.string()),
  updatedAt: v.number(),
});

const principalResolutionHash = async (
  kind: "session" | "principal" | "operator" | "evidence",
  value: string,
) =>
  await hashSha256Hex(
    `stella-composio-principal-resolution-v1\0${kind}\0${value}`,
  );

/**
 * A small provider-owned locator page. `user_integrations` remains the durable
 * debt record until the action has confirmed both connected-account and
 * session deletion at Composio.
 */
export const getOwnerComposioPurgeBatchInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(purgeLocatorValidator),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("user_integrations")
      .withIndex("by_ownerId_mode_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("mode", "composio"),
      )
      .take(MAX_COMPOSIO_PURGE_BATCH);
    return await Promise.all(
      rows.map(async (row) => {
        if (
          row.config.composioUserId !== undefined &&
          rowComposioUserId(row) === undefined
        ) {
          throw new Error("Composio integration principal is malformed.");
        }
        const catalog = await ctx.db
          .query("integrations_public")
          .withIndex("by_integrationId", (q) => q.eq("id", row.provider))
          .unique();
        const connector =
          catalog?.connector &&
          typeof catalog.connector === "object" &&
          !Array.isArray(catalog.connector)
            ? (catalog.connector as Record<string, unknown>)
            : null;
        const toolkit =
          optionalSafeString(row.config.composioToolkit, SAFE_PROVIDER) ??
          optionalSafeString(connector?.toolkit, SAFE_PROVIDER) ??
          optionalSafeString(row.provider, SAFE_PROVIDER) ??
          "invalid";
        const composioUserId = rowComposioUserId(row);
        return {
          id: row._id,
          provider: SAFE_PROVIDER.test(row.provider) ? row.provider : "invalid",
          toolkit,
          sessionId: rowSessionId(row),
          composioUserId,
          composioUserIds: composioUserId ? [composioUserId] : [],
          updatedAt: row.updatedAt,
        };
      }),
    );
  },
});

const assertExactPurgeRow = async (
  ctx: MutationCtx,
  args: {
    id: import("./_generated/dataModel").Id<"user_integrations">;
    ownerId: string;
    provider: string;
    sessionId: string;
    updatedAt: number;
  },
) => {
  const row = await ctx.db.get(args.id);
  if (
    !row ||
    row.ownerId !== args.ownerId ||
    row.mode !== "composio" ||
    row.provider !== args.provider ||
    row.updatedAt !== args.updatedAt ||
    rowSessionId(row) !== args.sessionId
  ) {
    throw new Error("Composio purge locator changed before acknowledgement.");
  }
  return row;
};

/**
 * Durably capture a session principal before remote session deletion. A retry
 * can then enumerate the exact connected-account partition even after the
 * session GET itself permanently returns 404.
 */
export const recordOwnerComposioResolvedPrincipalInternal = internalMutation({
  args: {
    id: v.id("user_integrations"),
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    leaseId: v.string(),
    provider: v.string(),
    sessionId: v.string(),
    updatedAt: v.number(),
    composioUserId: v.string(),
    now: v.number(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    await assertOwnerPurgeLease(ctx, {
      ownerId: args.ownerId,
      operationId: args.operationId,
      generation: args.generation,
      stage: "core",
      leaseId: args.leaseId,
      mode: "delete",
    });
    if (!SAFE_EXTERNAL_ID.test(args.composioUserId)) {
      throw new Error("Composio session principal is invalid.");
    }
    const row = await assertExactPurgeRow(ctx, args);
    const existing = rowComposioUserId(row);
    if (existing && existing !== args.composioUserId) {
      throw new Error("Composio session principal changed before persistence.");
    }
    if (existing) return row.updatedAt;
    const updatedAt = Math.max(args.now, row.updatedAt + 1);
    await ctx.db.patch(row._id, {
      config: { ...row.config, composioUserId: args.composioUserId },
      updatedAt,
    });
    return updatedAt;
  },
});

/**
 * Hash-audited operator recovery for a legacy bound row whose session is
 * already 404 and whose pre-migration principal was never persisted.
 */
export const resolveOwnerComposioPrincipalInternal = internalMutation({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    sessionId: v.string(),
    composioUserId: v.string(),
    resolutionId: v.string(),
    resolvedBy: v.string(),
    evidence: v.string(),
    now: v.number(),
  },
  returns: v.object({ replayed: v.boolean() }),
  handler: async (ctx, args) => {
    const resolutionId = args.resolutionId.trim();
    const resolvedBy = args.resolvedBy.trim();
    const evidence = args.evidence.trim();
    const composioUserId = args.composioUserId.trim();
    if (
      !SAFE_PROVIDER.test(args.provider) ||
      !SAFE_EXTERNAL_ID.test(args.sessionId) ||
      !SAFE_EXTERNAL_ID.test(composioUserId) ||
      !SAFE_RESOLUTION_ID.test(resolutionId) ||
      !SAFE_OPERATOR_ID.test(resolvedBy) ||
      !evidence ||
      evidence.length > MAX_OPERATOR_EVIDENCE_LENGTH
    ) {
      throw new Error("Composio principal resolution evidence is invalid.");
    }
    const row = await ctx.db
      .query("user_integrations")
      .withIndex("by_ownerId_and_provider", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", args.provider),
      )
      .unique();
    if (
      !row ||
      row.mode !== "composio" ||
      rowSessionId(row) !== args.sessionId
    ) {
      throw new Error("Composio principal resolution locator changed.");
    }
    const [sessionHash, principalHash, resolvedByHash, evidenceHash] =
      await Promise.all([
        principalResolutionHash("session", args.sessionId),
        principalResolutionHash("principal", composioUserId),
        principalResolutionHash("operator", resolvedBy),
        principalResolutionHash("evidence", evidence),
      ]);
    const existingResolutionId = optionalSafeString(
      row.config.composioPrincipalResolutionId,
      SAFE_RESOLUTION_ID,
    );
    if (existingResolutionId) {
      if (
        existingResolutionId !== resolutionId ||
        rowComposioUserId(row) !== composioUserId ||
        row.config.composioPrincipalSessionHash !== sessionHash ||
        row.config.composioPrincipalHash !== principalHash ||
        row.config.composioPrincipalResolvedByHash !== resolvedByHash ||
        row.config.composioPrincipalEvidenceHash !== evidenceHash
      ) {
        throw new Error(
          "Composio principal resolution does not match its audit.",
        );
      }
      return { replayed: true };
    }
    const existingPrincipal = rowComposioUserId(row);
    if (existingPrincipal && existingPrincipal !== composioUserId) {
      throw new Error("Composio principal was already resolved differently.");
    }
    await ctx.db.patch(row._id, {
      config: {
        ...row.config,
        composioUserId,
        composioPrincipalResolutionId: resolutionId,
        composioPrincipalSessionHash: sessionHash,
        composioPrincipalHash: principalHash,
        composioPrincipalResolvedByHash: resolvedByHash,
        composioPrincipalEvidenceHash: evidenceHash,
        composioPrincipalResolvedAt: args.now,
      },
      updatedAt: Math.max(args.now, row.updatedAt + 1),
    });
    return { replayed: false };
  },
});

/** Delete the local locator last, transactionally ordered after the purge fence. */
export const acknowledgeOwnerComposioSessionDeletedInternal = internalMutation({
  args: {
    id: v.id("user_integrations"),
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    leaseId: v.string(),
    provider: v.string(),
    sessionId: v.string(),
    updatedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerPurgeLease(ctx, {
      ownerId: args.ownerId,
      operationId: args.operationId,
      generation: args.generation,
      stage: "core",
      leaseId: args.leaseId,
      mode: "delete",
    });
    const row = await assertExactPurgeRow(ctx, args);
    await ctx.db.delete(row._id);
    return null;
  },
});

/** Strict bounded account-deletion readback without returning provider IDs. */
export const remainingOwnerComposioSessionRowsInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("user_integrations")
      .withIndex("by_ownerId_mode_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("mode", "composio"),
      )
      .take(MAX_COMPOSIO_READBACK + 1);
    const result = rows
      .slice(0, MAX_COMPOSIO_READBACK)
      .map((row) =>
        SAFE_PROVIDER.test(row.provider)
          ? `composio_session:${row.provider}`
          : "composio_session:invalid_locator",
      );
    if (rows.length > MAX_COMPOSIO_READBACK) {
      result.push("composio_session:additional_rows");
    }
    return result;
  },
});
