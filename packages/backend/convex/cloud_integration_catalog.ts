import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { hasOwnerMigrationSourceFence } from "./auth";
import { assertOwnerDataWriteAllowed } from "./owner_lifecycle";
import { sha256Hex } from "./lib/x_oauth";

const MAX_CONNECTED_INTEGRATIONS = 24;
const MAX_CODE_TOOL_RESULTS = 24;
const MAX_CODE_TOOL_SCAN_PER_INTEGRATION = 24;
const MAX_RECEIPT_JSON_CHARS = 128 * 1024;
// Covers the bounded connection-status check plus bounded tool execution with
// margin; a purge/migration waits rather than deleting an in-flight receipt.
const DISPATCH_LEASE_MS = 90_000;
const SAFE_INTEGRATION_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const SAFE_ACTION_NAME = /^[A-Z][A-Z0-9_]{1,127}$/u;
const SAFE_COMPOSIO_TOOLKIT_VERSION = /^\d{8}_\d{2}$/u;
const TOOL_NAME_PREFIX = "native__";

const codeToolAnnotationsValidator = v.object({
  readOnlyHint: v.boolean(),
  destructiveHint: v.boolean(),
  idempotentHint: v.boolean(),
  source: v.literal("composio_tool_tags"),
});

const codeModePolicyValidator = v.object({
  effect: v.literal("read"),
  requiresApproval: v.literal(false),
  policyVersion: v.string(),
  toolkitVersion: v.string(),
  source: v.literal("stella_admin"),
});

const codeIntegrationToolValidator = v.object({
  name: v.string(),
  integrationId: v.string(),
  action: v.string(),
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  revision: v.string(),
  annotations: codeToolAnnotationsValidator,
  codeModePolicy: codeModePolicyValidator,
});

const codeIntegrationActionValidator = v.object({
  name: v.string(),
  integrationId: v.string(),
  action: v.string(),
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  revision: v.string(),
  annotations: codeToolAnnotationsValidator,
  codeModePolicy: codeModePolicyValidator,
  inputSchemaJson: v.string(),
  reviewedInputSchemaJson: v.string(),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isObjectSchemaJson = (value: string): boolean => {
  try {
    return isRecord(JSON.parse(value) as unknown);
  } catch {
    return false;
  }
};

const isCodeReadOnly = (value: unknown): value is {
  readOnlyHint: true;
  destructiveHint: false;
  idempotentHint: boolean;
  source: "composio_tool_tags";
} =>
  isRecord(value) &&
  value.source === "composio_tool_tags" &&
  value.readOnlyHint === true &&
  value.destructiveHint === false &&
  typeof value.idempotentHint === "boolean";

const isStellaCodeReadPolicy = (value: unknown): value is {
  effect: "read";
  requiresApproval: false;
  policyVersion: string;
  toolkitVersion: string;
  reviewedInputSchemaJson: string;
  source: "stella_admin";
} =>
  isRecord(value) &&
  value.effect === "read" &&
  value.requiresApproval === false &&
  value.source === "stella_admin" &&
  typeof value.policyVersion === "string" &&
  /^[A-Za-z0-9._:-]{1,128}$/u.test(value.policyVersion) &&
  typeof value.toolkitVersion === "string" &&
  SAFE_COMPOSIO_TOOLKIT_VERSION.test(value.toolkitVersion) &&
  typeof value.reviewedInputSchemaJson === "string" &&
  value.reviewedInputSchemaJson.length > 0;

const actionRevision = async (action: {
  integrationId: string;
  name: string;
  inputSchemaJson: string;
  annotations?: unknown;
  codeModePolicy?: unknown;
}): Promise<string | null> => {
  if (
    !isCodeReadOnly(action.annotations) ||
    !isStellaCodeReadPolicy(action.codeModePolicy)
  ) {
    return null;
  }
  // Fixed key order makes this a content revision, not a timestamp alias. Any
  // provider schema/annotation or Stella policy/schema byte change invalidates
  // discovery results even if a buggy publisher reuses `updatedAt`.
  const material = JSON.stringify({
    version: 2,
    integrationId: action.integrationId,
    action: action.name,
    providerAnnotations: {
      readOnlyHint: action.annotations.readOnlyHint,
      destructiveHint: action.annotations.destructiveHint,
      idempotentHint: action.annotations.idempotentHint,
      source: action.annotations.source,
    },
    providerInputSchemaJson: action.inputSchemaJson,
    stellaPolicy: {
      effect: action.codeModePolicy.effect,
      requiresApproval: action.codeModePolicy.requiresApproval,
      policyVersion: action.codeModePolicy.policyVersion,
      toolkitVersion: action.codeModePolicy.toolkitVersion,
      reviewedInputSchemaJson:
        action.codeModePolicy.reviewedInputSchemaJson,
      source: action.codeModePolicy.source,
    },
  });
  return `v2:${await sha256Hex(material)}`;
};

const publicCodeModePolicy = (policy: {
  effect: "read";
  requiresApproval: false;
  policyVersion: string;
  toolkitVersion: string;
  source: "stella_admin";
}) => ({
  effect: policy.effect,
  requiresApproval: policy.requiresApproval,
  policyVersion: policy.policyVersion,
  toolkitVersion: policy.toolkitVersion,
  source: policy.source,
});

export const codeIntegrationToolName = (
  integrationId: string,
  action: string,
): string => `${TOOL_NAME_PREFIX}${integrationId}__${action}`;

export const parseCodeIntegrationToolName = (
  name: string,
): { integrationId: string; action: string } | null => {
  if (!name.startsWith(TOOL_NAME_PREFIX)) return null;
  const separator = name.indexOf("__", TOOL_NAME_PREFIX.length);
  if (separator < 0) return null;
  const integrationId = name.slice(TOOL_NAME_PREFIX.length, separator);
  const action = name.slice(separator + 2);
  return SAFE_INTEGRATION_ID.test(integrationId) &&
    SAFE_ACTION_NAME.test(action)
    ? { integrationId, action }
    : null;
};

const assertNoOperationalOwnerMigration = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
): Promise<void> => {
  if (await hasOwnerMigrationSourceFence(ctx, ownerId)) {
    throw new ConvexError({
      code: "OWNERSHIP_MIGRATED",
      message: "This owner is no longer active.",
    });
  }
  const statuses = ["pending", "running", "failed"] as const;
  const incoming = await Promise.all(
    statuses.map((status) =>
      ctx.db
        .query("auth_owner_migrations")
        .withIndex("by_toOwnerId_and_status_and_updatedAt", (q) =>
          q.eq("toOwnerId", ownerId).eq("status", status),
        )
        .take(1),
    ),
  );
  if (incoming.some((rows) => rows.length > 0)) {
    throw new ConvexError({
      code: "OWNER_MIGRATION_ACTIVE",
      message: "Connected tools are unavailable while account data is moving.",
    });
  }
};

const assertOwnerCatalogAccess = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  ownerGeneration: string,
): Promise<void> => {
  await assertOwnerDataWriteAllowed(ctx, ownerId, ownerGeneration);
  await assertNoOperationalOwnerMigration(ctx, ownerId);
};

const loadAllowedAction = async (
  ctx: QueryCtx | MutationCtx,
  args: {
    ownerId: string;
    integrationId: string;
    action: string;
  },
) => {
  const connection = await ctx.db
    .query("user_integrations")
    .withIndex("by_ownerId_and_provider", (q) =>
      q.eq("ownerId", args.ownerId).eq("provider", args.integrationId),
    )
    .unique();
  if (!connection || connection.mode !== "composio") return null;

  const integration = await ctx.db
    .query("integrations_public")
    .withIndex("by_integrationId", (q) => q.eq("id", args.integrationId))
    .unique();
  const connector = isRecord(integration?.connector)
    ? integration?.connector
    : null;
  if (
    !integration?.enabled ||
    connector?.type !== "composio" ||
    connector.toolkit !== args.integrationId
  ) {
    return null;
  }

  const action = await ctx.db
    .query("integration_actions")
    .withIndex("by_integrationId_and_name", (q) =>
      q.eq("integrationId", args.integrationId).eq("name", args.action),
    )
    .unique();
  if (
    !action ||
    action.codeModeEligible !== true ||
    !isCodeReadOnly(action.annotations) ||
    !isStellaCodeReadPolicy(action.codeModePolicy) ||
    !isObjectSchemaJson(action.codeModePolicy.reviewedInputSchemaJson)
  ) {
    return null;
  }
  return { connection, action };
};

export const listCodeIntegrationToolsInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    query: v.optional(v.string()),
    limit: v.number(),
  },
  returns: v.array(codeIntegrationToolValidator),
  handler: async (ctx, args) => {
    await assertOwnerCatalogAccess(ctx, args.ownerId, args.ownerGeneration);
    const limit = Math.min(
      Math.max(Math.floor(args.limit), 1),
      MAX_CODE_TOOL_RESULTS,
    );
    const query = args.query?.trim().slice(0, 200);
    const connections = await ctx.db
      .query("user_integrations")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .order("desc")
      .take(MAX_CONNECTED_INTEGRATIONS);
    const candidates = await Promise.all(
      connections
        .filter(
          (connection) =>
            connection.mode === "composio" &&
            SAFE_INTEGRATION_ID.test(connection.provider),
        )
        .map(async (connection) => {
          const integration = await ctx.db
            .query("integrations_public")
            .withIndex("by_integrationId", (q) =>
              q.eq("id", connection.provider),
            )
            .unique();
          const connector = isRecord(integration?.connector)
            ? integration?.connector
            : null;
          if (
            !integration?.enabled ||
            connector?.type !== "composio" ||
            connector.toolkit !== connection.provider
          ) {
            return [];
          }
          return query
            ? await ctx.db
                .query("integration_actions")
                .withSearchIndex("search_searchText", (q) =>
                  q
                    .search("searchText", query)
                    .eq("integrationId", connection.provider)
                    .eq("codeModeEligible", true),
                )
                .take(MAX_CODE_TOOL_SCAN_PER_INTEGRATION)
            : await ctx.db
                .query("integration_actions")
                .withIndex("by_integrationId_codeModeEligible_name", (q) =>
                  q
                    .eq("integrationId", connection.provider)
                    .eq("codeModeEligible", true),
                )
                .take(MAX_CODE_TOOL_SCAN_PER_INTEGRATION);
        }),
    );
    const eligible = candidates
      .flat()
      .filter(
        (action) =>
          action.codeModeEligible === true &&
          isCodeReadOnly(action.annotations) &&
          isStellaCodeReadPolicy(action.codeModePolicy),
      )
      .sort((left, right) =>
        `${left.integrationId}:${left.name}`.localeCompare(
          `${right.integrationId}:${right.name}`,
        ),
      )
      .slice(0, limit);
    return await Promise.all(
      eligible.map(async (action) => ({
        name: codeIntegrationToolName(action.integrationId, action.name),
        integrationId: action.integrationId,
        action: action.name,
        title: action.title,
        description: action.description,
        revision: (await actionRevision(action))!,
        annotations: action.annotations!,
        codeModePolicy: publicCodeModePolicy(action.codeModePolicy!),
      })),
    );
  },
});

/** Lexicographic page used by the standard MCP `tools/list` operation. */
export const listCodeIntegrationToolsPageInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    afterName: v.optional(v.string()),
    limit: v.number(),
  },
  returns: v.object({
    tools: v.array(codeIntegrationToolValidator),
    nextAfterName: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    await assertOwnerCatalogAccess(ctx, args.ownerId, args.ownerGeneration);
    const limit = Math.min(
      Math.max(Math.floor(args.limit), 1),
      MAX_CODE_TOOL_RESULTS,
    );
    const after = args.afterName
      ? parseCodeIntegrationToolName(args.afterName)
      : null;
    if (args.afterName && !after) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Connected-tool cursor is invalid.",
      });
    }
    const connections = await ctx.db
      .query("user_integrations")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .order("desc")
      .take(MAX_CONNECTED_INTEGRATIONS);
    const candidates = await Promise.all(
      connections
        .filter(
          (connection) =>
            connection.mode === "composio" &&
            SAFE_INTEGRATION_ID.test(connection.provider) &&
            (!after ||
              connection.provider.localeCompare(after.integrationId) >= 0),
        )
        .map(async (connection) => {
          const integration = await ctx.db
            .query("integrations_public")
            .withIndex("by_integrationId", (q) =>
              q.eq("id", connection.provider),
            )
            .unique();
          const connector = isRecord(integration?.connector)
            ? integration.connector
            : null;
          if (
            !integration?.enabled ||
            connector?.type !== "composio" ||
            connector.toolkit !== connection.provider
          ) {
            return [];
          }
          return await ctx.db
            .query("integration_actions")
            .withIndex("by_integrationId_codeModeEligible_name", (q) => {
              const indexed = q
                .eq("integrationId", connection.provider)
                .eq("codeModeEligible", true);
              return after && connection.provider === after.integrationId
                ? indexed.gt("name", after.action)
                : indexed;
            })
            .take(limit + 1);
        }),
    );
    const eligible = candidates
      .flat()
      .filter(
        (action) =>
          action.codeModeEligible === true &&
          isCodeReadOnly(action.annotations) &&
          isStellaCodeReadPolicy(action.codeModePolicy),
      )
      .sort((left, right) =>
        `${left.integrationId}:${left.name}`.localeCompare(
          `${right.integrationId}:${right.name}`,
        ),
      );
    const page = eligible.slice(0, limit);
    const tools = await Promise.all(
      page.map(async (action) => ({
        name: codeIntegrationToolName(action.integrationId, action.name),
        integrationId: action.integrationId,
        action: action.name,
        title: action.title,
        description: action.description,
        revision: (await actionRevision(action))!,
        annotations: action.annotations!,
        codeModePolicy: publicCodeModePolicy(action.codeModePolicy!),
      })),
    );
    return {
      tools,
      ...(eligible.length > limit && tools.length > 0
        ? { nextAfterName: tools[tools.length - 1]!.name }
        : {}),
    };
  },
});

export const getCodeIntegrationActionInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    name: v.string(),
  },
  returns: v.union(v.null(), codeIntegrationActionValidator),
  handler: async (ctx, args) => {
    await assertOwnerCatalogAccess(ctx, args.ownerId, args.ownerGeneration);
    const parsed = parseCodeIntegrationToolName(args.name);
    if (!parsed) return null;
    const resolved = await loadAllowedAction(ctx, {
      ownerId: args.ownerId,
      ...parsed,
    });
    if (!resolved) return null;
    return {
      name: args.name,
      integrationId: parsed.integrationId,
      action: parsed.action,
      title: resolved.action.title,
      description: resolved.action.description,
      revision: (await actionRevision(resolved.action))!,
      annotations: resolved.action.annotations!,
      codeModePolicy: publicCodeModePolicy(resolved.action.codeModePolicy!),
      inputSchemaJson: resolved.action.inputSchemaJson,
      reviewedInputSchemaJson:
        resolved.action.codeModePolicy!.reviewedInputSchemaJson,
    };
  },
});

/**
 * Final transactional policy/fence/connection check immediately before the
 * HTTP action dispatches to Composio. The returned session id never leaves
 * the backend process.
 */
export const assertCodeIntegrationDispatchLeaseInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    requestId: v.string(),
    fingerprint: v.string(),
    leaseId: v.string(),
    name: v.string(),
    revision: v.string(),
    turnId: v.string(),
    expectedSessionId: v.string(),
    expectedComposioUserId: v.string(),
    now: v.number(),
  },
  returns: v.object({
    integrationId: v.string(),
    action: v.string(),
    sessionId: v.string(),
    composioUserId: v.string(),
    toolkitVersion: v.string(),
  }),
  handler: async (ctx, args) => {
    await assertOwnerCatalogAccess(ctx, args.ownerId, args.ownerGeneration);
    const parsed = parseCodeIntegrationToolName(args.name);
    if (!parsed) {
      throw new ConvexError({
        code: "TOOL_NOT_ALLOWED",
        message: "Connected tool is not allowed in Code.",
      });
    }
    const resolved = await loadAllowedAction(ctx, {
      ownerId: args.ownerId,
      ...parsed,
    });
    if (
      !resolved ||
      (await actionRevision(resolved.action)) !== args.revision
    ) {
      throw new ConvexError({
        code: "TOOL_POLICY_CHANGED",
        message: "Connected tool policy changed; search again.",
      });
    }
    const config = isRecord(resolved.connection.config)
      ? resolved.connection.config
      : {};
    const sessionId =
      (typeof resolved.connection.externalId === "string" &&
      resolved.connection.externalId.trim()
        ? resolved.connection.externalId.trim()
        : null) ??
      (typeof config.sessionId === "string" && config.sessionId.trim()
        ? config.sessionId.trim()
        : null);
    if (!sessionId || sessionId.length > 512) {
      throw new ConvexError({
        code: "CONNECT_REQUIRED",
        message: "Connect this integration before using it.",
      });
    }
    if (sessionId !== args.expectedSessionId) {
      throw new ConvexError({
        code: "CONNECTION_CHANGED",
        message: "Connected-tool session changed; search again.",
      });
    }
    const storedComposioUserId =
      typeof config.composioUserId === "string" &&
      config.composioUserId.trim()
        ? config.composioUserId.trim()
        : null;
    const expectedComposioUserId = args.expectedComposioUserId.trim();
    if (
      !expectedComposioUserId ||
      expectedComposioUserId.length > 512 ||
      (storedComposioUserId !== null &&
        storedComposioUserId !== expectedComposioUserId)
    ) {
      throw new ConvexError({
        code: "CONNECTION_CHANGED",
        message: "Connected-tool provider principal changed; search again.",
      });
    }
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
      receipt.toolName !== args.name ||
      receipt.revision !== args.revision ||
      receipt.state !== "dispatching" ||
      receipt.leaseId !== args.leaseId ||
      (receipt.leaseExpiresAt ?? 0) <= args.now
    ) {
      throw new ConvexError({
        code: "DISPATCH_LEASE_LOST",
        message: "Connected-tool dispatch lease is no longer current.",
      });
    }
    // The HTTP admission (a signed turn capability) can become stale while
    // the provider status and session metadata requests are in flight. The
    // projected turn row is the only thing that can say the turn has ended;
    // recheck it in this final transaction, immediately before renewing the
    // provider-dispatch lease.
    const turn = await ctx.db
      .query("agent_turns")
      .withIndex("by_turnId", (q) => q.eq("turnId", args.turnId))
      .unique();
    if (
      turn &&
      (turn.ownerId !== args.ownerId ||
        turn.ownerGeneration !== args.ownerGeneration ||
        turn.status !== "running" ||
        turn.terminalKind)
    ) {
      throw new ConvexError({
        code: "TURN_NOT_ACTIVE",
        message: "The orchestrator turn is no longer active.",
      });
    }
    // Renew immediately before external dispatch. Reset/delete/migration waits
    // on this live owner-scoped lease, including if the worker disappears
    // after this transaction but before recording the provider result.
    await ctx.db.patch(receipt._id, {
      leaseExpiresAt: args.now + DISPATCH_LEASE_MS,
      updatedAt: args.now,
    });
    return {
      integrationId: parsed.integrationId,
      action: parsed.action,
      sessionId,
      composioUserId: storedComposioUserId ?? expectedComposioUserId,
      toolkitVersion: resolved.action.codeModePolicy!.toolkitVersion,
    };
  },
});

const codeIntegrationCallClaimValidator = v.union(
  v.object({
    status: v.literal("dispatch"),
    integrationId: v.string(),
    action: v.string(),
    sessionId: v.string(),
    composioUserId: v.optional(v.string()),
  }),
  v.object({
    status: v.literal("replay"),
    resultJson: v.string(),
  }),
  v.object({
    status: v.literal("failed"),
    errorCode: v.string(),
  }),
  v.object({ status: v.literal("in_progress") }),
);

/**
 * Atomically claims one read-only provider dispatch. Reusing a request id for
 * different bytes is always a conflict. An expired/ambiguous read-only lease
 * may be reclaimed because the server has revalidated both the provider hint
 * and Stella's independently reviewed read policy in this same transaction.
 */
export const claimCodeIntegrationCallInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    requestId: v.string(),
    fingerprint: v.string(),
    name: v.string(),
    revision: v.string(),
    leaseId: v.string(),
    now: v.number(),
  },
  returns: codeIntegrationCallClaimValidator,
  handler: async (ctx, args) => {
    await assertOwnerCatalogAccess(ctx, args.ownerId, args.ownerGeneration);
    const parsed = parseCodeIntegrationToolName(args.name);
    const resolved = parsed
      ? await loadAllowedAction(ctx, {
          ownerId: args.ownerId,
          ...parsed,
        })
      : null;
    if (
      !parsed ||
      !resolved ||
      (await actionRevision(resolved.action)) !== args.revision
    ) {
      throw new ConvexError({
        code: "TOOL_POLICY_CHANGED",
        message: "Connected tool policy changed; search again.",
      });
    }

    const existing = await ctx.db
      .query("cloud_integration_call_receipts")
      .withIndex("by_owner_generation_request", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("ownerGeneration", args.ownerGeneration)
          .eq("requestId", args.requestId),
      )
      .unique();
    if (existing) {
      if (
        existing.fingerprint !== args.fingerprint ||
        existing.toolName !== args.name ||
        existing.revision !== args.revision
      ) {
        throw new ConvexError({
          code: "IDEMPOTENCY_CONFLICT",
          message: "Connected-tool request id was reused for different input.",
        });
      }
      if (existing.state === "succeeded" && existing.resultJson !== undefined) {
        return { status: "replay" as const, resultJson: existing.resultJson };
      }
      if (existing.state === "failed") {
        return {
          status: "failed" as const,
          errorCode: existing.errorCode ?? "provider_error",
        };
      }
      if (
        existing.state === "dispatching" &&
        (existing.leaseExpiresAt ?? 0) > args.now
      ) {
        return { status: "in_progress" as const };
      }
      await ctx.db.patch(existing._id, {
        state: "dispatching",
        leaseId: args.leaseId,
        leaseExpiresAt: args.now + DISPATCH_LEASE_MS,
        resultJson: undefined,
        errorCode: undefined,
        attempts: existing.attempts + 1,
        updatedAt: args.now,
      });
    } else {
      await ctx.db.insert("cloud_integration_call_receipts", {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        requestId: args.requestId,
        fingerprint: args.fingerprint,
        toolName: args.name,
        revision: args.revision,
        state: "dispatching",
        leaseId: args.leaseId,
        leaseExpiresAt: args.now + DISPATCH_LEASE_MS,
        attempts: 1,
        createdAt: args.now,
        updatedAt: args.now,
      });
    }

    const config = isRecord(resolved.connection.config)
      ? resolved.connection.config
      : {};
    const sessionId =
      (typeof resolved.connection.externalId === "string" &&
      resolved.connection.externalId.trim()
        ? resolved.connection.externalId.trim()
        : null) ??
      (typeof config.sessionId === "string" && config.sessionId.trim()
        ? config.sessionId.trim()
        : null);
    if (!sessionId || sessionId.length > 512) {
      throw new ConvexError({
        code: "CONNECT_REQUIRED",
        message: "Connect this integration before using it.",
      });
    }
    return {
      status: "dispatch" as const,
      integrationId: parsed.integrationId,
      action: parsed.action,
      sessionId,
      ...(typeof config.composioUserId === "string" &&
      config.composioUserId.trim()
        ? { composioUserId: config.composioUserId.trim() }
        : {}),
    };
  },
});

/** Durable MCP cancellation fence for a call that has not dispatched yet. */
export const cancelCodeIntegrationCallInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    requestId: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerCatalogAccess(ctx, args.ownerId, args.ownerGeneration);
    const receipt = await ctx.db
      .query("cloud_integration_call_receipts")
      .withIndex("by_owner_generation_request", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("ownerGeneration", args.ownerGeneration)
          .eq("requestId", args.requestId),
      )
      .unique();
    if (receipt?.state === "dispatching") {
      await ctx.db.patch(receipt._id, {
        state: "failed",
        leaseId: undefined,
        leaseExpiresAt: undefined,
        errorCode: "canceled_before_dispatch",
        updatedAt: args.now,
      });
    }
    return null;
  },
});

export const completeCodeIntegrationCallInternal = internalMutation({
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
    resultJson: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerCatalogAccess(ctx, args.ownerId, args.ownerGeneration);
    if (
      args.resultJson !== undefined &&
      args.resultJson.length > MAX_RECEIPT_JSON_CHARS
    ) {
      throw new ConvexError({
        code: "RESULT_TOO_LARGE",
        message: "Connected-tool result exceeded its receipt limit.",
      });
    }
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
      receipt.state !== "dispatching" ||
      receipt.leaseId !== args.leaseId
    ) {
      throw new ConvexError({
        code: "DISPATCH_LEASE_LOST",
        message: "Connected-tool dispatch lease is no longer current.",
      });
    }
    await ctx.db.patch(receipt._id, {
      state: args.outcome,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      resultJson:
        args.outcome === "succeeded" ? args.resultJson : undefined,
      errorCode:
        args.outcome === "succeeded" ? undefined : args.errorCode,
      updatedAt: args.now,
    });
    return null;
  },
});
