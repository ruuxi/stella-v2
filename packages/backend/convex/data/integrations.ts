import { mutation, internalMutation, internalQuery, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { v, ConvexError, type Infer } from "convex/values";
import { requireUserId } from "../auth";
import {
  enforceMutationRateLimit,
  RATE_VERY_EXPENSIVE,
} from "../lib/rate_limits";
import { jsonObjectValidator } from "../shared_validators";
import { internal } from "../_generated/api";
import { encryptSecret } from "./secrets_crypto";
import {
  MAX_INTEGRATION_ACTIONS_PAGE_SIZE,
  MAX_INTEGRATION_ACTION_SCHEMA_BYTES,
  MAX_PUBLISHED_INTEGRATION_ACTIONS,
} from "../lib/native_integration_limits";
import {
  buildXAuthorizationUrl,
  buildXCodeChallenge,
  generateXCodeVerifier,
  generateXOAuthState,
  sha256Hex,
  X_OAUTH_SCOPES,
  X_OAUTH_STATE_TTL_MS,
  X_PROVIDER_ID,
} from "../lib/x_oauth";


const storeIntegrationConnectorValidator = v.object({
  type: v.literal("composio"),
  toolkit: v.string(),
  actionNamespace: v.optional(v.string()),
  provider: v.optional(v.string()),
});

const publishedIntegrationActionValidator = v.object({
  name: v.string(),
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  // Kept as a string because real JSON schemas can be much deeper than the
  // shared bounded JSON validator. HTTP ingestion validates/parses this once,
  // then this mutation stores each schema in its own bounded document.
  inputSchemaJson: v.string(),
});

const SAFE_INTEGRATION_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const SAFE_ACTION_NAME = /^[A-Z][A-Z0-9_]{1,127}$/u;

type ComposioConnector = {
  type: "composio";
  toolkit: string;
  actionNamespace?: string;
  provider?: string;
};

const isComposioConnector = (value: unknown): value is ComposioConnector => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "composio" &&
    typeof record.toolkit === "string" &&
    record.toolkit.trim().length > 0
  );
};

const isExecutableStoreIntegration = (record: {
  connector?: Record<string, unknown>;
  enabled: boolean;
  actionCount?: number;
}) =>
  record.enabled &&
  isComposioConnector(record.connector) &&
  typeof record.actionCount === "number" &&
  Number.isSafeInteger(record.actionCount) &&
  record.actionCount > 0 &&
  record.actionCount <= MAX_PUBLISHED_INTEGRATION_ACTIONS;

const storeIntegrationStatusValues = new Set(["ready", "hidden"]);

const normalizePublicIntegration = (record: {
  id: string;
  name?: string;
  provider: string;
  category?: string;
  auth?: string[];
  catalogToolCount?: number;
  actionCount?: number;
  description?: string;
  sourceUrl?: string;
  iconUrl?: string;
  connector?: Record<string, unknown>;
  enabled: boolean;
  usagePolicy: string;
  updatedAt: number;
}, options?: { includeConnector?: boolean }) => {
  const status = storeIntegrationStatusValues.has(record.usagePolicy)
    ? record.usagePolicy
    : record.enabled
      ? "ready"
      : "hidden";
  const connector = isComposioConnector(record.connector)
    ? record.connector
    : undefined;
  return {
    id: record.id,
    name: record.name ?? record.provider,
    provider: record.provider,
    category: record.category ?? "integrations",
    auth: record.auth ?? ["OAUTH2"],
    // The stored action set, rather than provider-reported marketing metadata,
    // is the authoritative executable tool count.
    catalogToolCount: record.actionCount ?? 0,
    description: record.description ?? `Connect ${record.provider} to Stella.`,
    ...(record.sourceUrl ? { sourceUrl: record.sourceUrl } : {}),
    ...(record.iconUrl ? { iconUrl: record.iconUrl } : {}),
    ...(options?.includeConnector && connector ? { connector } : {}),
    status,
    enabled: record.enabled,
    updatedAt: record.updatedAt,
  };
};

const store_integration_public_validator = v.object({
  id: v.string(),
  name: v.string(),
  provider: v.string(),
  category: v.string(),
  auth: v.array(v.string()),
  catalogToolCount: v.number(),
  description: v.string(),
  sourceUrl: v.optional(v.string()),
  iconUrl: v.optional(v.string()),
  status: v.string(),
  enabled: v.boolean(),
  updatedAt: v.number(),
});

const integrationPublicDocumentValidator = v.object({
  _id: v.id("integrations_public"),
  _creationTime: v.number(),
  id: v.string(),
  name: v.optional(v.string()),
  provider: v.string(),
  category: v.optional(v.string()),
  auth: v.optional(v.array(v.string())),
  catalogToolCount: v.optional(v.number()),
  actionCount: v.optional(v.number()),
  description: v.optional(v.string()),
  sourceUrl: v.optional(v.string()),
  iconUrl: v.optional(v.string()),
  connector: v.optional(jsonObjectValidator),
  enabled: v.boolean(),
  usagePolicy: v.string(),
  updatedAt: v.number(),
});

const userIntegrationDocumentValidator = v.object({
  _id: v.id("user_integrations"),
  _creationTime: v.number(),
  ownerId: v.string(),
  provider: v.string(),
  mode: v.string(),
  externalId: v.optional(v.string()),
  config: jsonObjectValidator,
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const listStoreIntegrations = query({
  args: {},
  returns: v.array(store_integration_public_validator),
  handler: async (ctx) => {
    const records = await ctx.db
      .query("integrations_public")
      .withIndex("by_updatedAt")
      .order("desc")
      .take(500);
    return records
      .filter(isExecutableStoreIntegration)
      .map((record) => normalizePublicIntegration(record));
  },
});

export const listStoreIntegrationsWithConnectors = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      id: v.string(),
      name: v.string(),
      provider: v.string(),
      category: v.string(),
      auth: v.array(v.string()),
      catalogToolCount: v.number(),
      description: v.string(),
      sourceUrl: v.optional(v.string()),
      iconUrl: v.optional(v.string()),
      status: v.string(),
      enabled: v.boolean(),
      updatedAt: v.number(),
      connector: v.optional(storeIntegrationConnectorValidator),
    }),
  ),
  handler: async (ctx) => {
    const records = await ctx.db
      .query("integrations_public")
      .withIndex("by_updatedAt")
      .order("desc")
      .take(500);
    return records
      .filter(isExecutableStoreIntegration)
      .map((record) =>
        normalizePublicIntegration(record, { includeConnector: true }),
      );
  },
});

export const upsertPublicIntegration = internalMutation({
  args: {
    id: v.string(),
    name: v.optional(v.string()),
    provider: v.string(),
    category: v.optional(v.string()),
    auth: v.optional(v.array(v.string())),
    catalogToolCount: v.optional(v.number()),
    actions: v.array(publishedIntegrationActionValidator),
    description: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
    iconUrl: v.optional(v.string()),
    connector: storeIntegrationConnectorValidator,
    enabled: v.boolean(),
    usagePolicy: v.string(),
  },
  returns: v.object({ actionCount: v.number() }),
  handler: async (ctx, args) => {
    const id = args.id.trim().toLowerCase();
    if (!SAFE_INTEGRATION_ID.test(id)) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Integration id is invalid.",
      });
    }
    if (
      args.provider.trim().toLowerCase() !== "composio" ||
      args.connector.toolkit.trim().toLowerCase() !== id ||
      (args.connector.provider &&
        args.connector.provider.trim().toLowerCase() !== "composio")
    ) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Only matching Composio Store integrations can be published.",
      });
    }
    if (args.actions.length === 0) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "At least one schema-bearing action is required.",
      });
    }
    if (args.actions.length > MAX_PUBLISHED_INTEGRATION_ACTIONS) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `Integration action count exceeds ${MAX_PUBLISHED_INTEGRATION_ACTIONS}.`,
      });
    }
    const actionNames = new Set<string>();
    for (const action of args.actions) {
      if (!SAFE_ACTION_NAME.test(action.name) || actionNames.has(action.name)) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: `Integration action name is invalid or duplicated: ${action.name}`,
        });
      }
      actionNames.add(action.name);
      if (
        new TextEncoder().encode(action.inputSchemaJson).byteLength >
        MAX_INTEGRATION_ACTION_SCHEMA_BYTES
      ) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: `Integration action schema is too large: ${action.name}`,
        });
      }
      try {
        const schema = JSON.parse(action.inputSchemaJson) as unknown;
        if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
          throw new Error("schema is not an object");
        }
      } catch {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: `Integration action schema is invalid: ${action.name}`,
        });
      }
    }

    const existing = await ctx.db
      .query("integrations_public")
      .withIndex("by_integrationId", (q) => q.eq("id", id))
      .unique();

    const existingActions = await ctx.db
      .query("integration_actions")
      .withIndex("by_integrationId_and_name", (q) =>
        q.eq("integrationId", id),
      )
      .take(MAX_PUBLISHED_INTEGRATION_ACTIONS + 1);
    if (existingActions.length > MAX_PUBLISHED_INTEGRATION_ACTIONS) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Existing integration action set exceeds the replacement bound.",
      });
    }

    // Convex mutations are transactional. Validate the full new set above,
    // then replace children and parent together so readers see either the old
    // complete publication or the new complete publication, never a partial.
    await Promise.all(existingActions.map((action) => ctx.db.delete(action._id)));
    const now = Date.now();
    await Promise.all(
      args.actions.map((action) =>
        ctx.db.insert("integration_actions", {
          integrationId: id,
          name: action.name,
          title: action.title,
          description: action.description,
          searchText: [action.name, action.title, action.description]
            .filter((value): value is string => Boolean(value))
            .join(" "),
          inputSchemaJson: action.inputSchemaJson,
          updatedAt: now,
        }),
      ),
    );

    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        provider: "composio",
        category: args.category,
        auth: args.auth,
        catalogToolCount: args.catalogToolCount,
        actionCount: args.actions.length,
        description: args.description,
        sourceUrl: args.sourceUrl,
        iconUrl: args.iconUrl,
        connector: { ...args.connector, toolkit: id, provider: "composio" },
        enabled: args.enabled,
        usagePolicy: args.usagePolicy,
        updatedAt: now,
      });
      return { actionCount: args.actions.length };
    }

    await ctx.db.insert("integrations_public", {
      id,
      name: args.name,
      provider: "composio",
      category: args.category,
      auth: args.auth,
      catalogToolCount: args.catalogToolCount,
      actionCount: args.actions.length,
      description: args.description,
      sourceUrl: args.sourceUrl,
      iconUrl: args.iconUrl,
      connector: { ...args.connector, toolkit: id, provider: "composio" },
      enabled: args.enabled,
      usagePolicy: args.usagePolicy,
      updatedAt: now,
    });
    return { actionCount: args.actions.length };
  },
});

const SLACK_OAUTH_SCOPE = "chat:write,im:history,im:read,im:write";
const SLACK_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
/**
 * On every state creation, opportunistically clean up at most this many of
 * the caller's own expired states. Bounded so creation latency stays flat.
 */
const SLACK_OAUTH_EXPIRED_CLEANUP_BATCH = 16;
const X_OAUTH_EXPIRED_CLEANUP_BATCH = 16;

const generateSecureState = (bytesLength = 24) => {
  const bytes = new Uint8Array(bytesLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const hashSha256Hex = sha256Hex;
type JsonObject = Infer<typeof jsonObjectValidator>;
const configuredOAuthSiteUrl = () =>
  process.env.STELLA_AUTH_BASE_URL || process.env.CONVEX_SITE_URL;

const upsertUserIntegrationForOwnerHandler = async (
  ctx: Pick<MutationCtx, "db">,
  args: {
    ownerId: string;
    provider: string;
    mode: string;
    externalId?: string;
    config: JsonObject;
  },
) => {
  const existing = await ctx.db
    .query("user_integrations")
    .withIndex("by_ownerId_and_provider", (q) =>
      q.eq("ownerId", args.ownerId).eq("provider", args.provider),
    )
    .unique();

  const now = Date.now();
  if (existing) {
    await ctx.db.patch(existing._id, {
      mode: args.mode,
      externalId: args.externalId,
      config: args.config,
      updatedAt: now,
    });
    return null;
  }

  await ctx.db.insert("user_integrations", {
    ownerId: args.ownerId,
    provider: args.provider,
    mode: args.mode,
    externalId: args.externalId,
    config: args.config,
    createdAt: now,
    updatedAt: now,
  });
  return null;
};

export const createSlackInstallUrl = mutation({
  args: {},
  returns: v.object({ url: v.string(), expiresAt: v.number() }),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);

    // Each call writes a `slack_oauth_states` row + crypto + cleanup work.
    // No legitimate UI needs to ask for new install URLs in tight loops.
    await enforceMutationRateLimit(
      ctx,
      "data_create_slack_install_url",
      ownerId,
      RATE_VERY_EXPENSIVE,
      "Too many Slack install requests. Please wait before trying again.",
    );

    const clientId = process.env.SLACK_CLIENT_ID;
    const convexSiteUrl = process.env.CONVEX_SITE_URL;

    if (!clientId || !convexSiteUrl) {
      throw new ConvexError({ code: "INTERNAL_ERROR", message: "Slack OAuth is not configured" });
    }

    const now = Date.now();
    const expiresAt = now + SLACK_OAUTH_STATE_TTL_MS;
    // 24 bytes (192 bits) of entropy — sufficient strength that we can store
    // sha256(state) directly without an additional per-row salt.
    const state = generateSecureState();
    const stateHash = await hashSha256Hex(state);

    // Best-effort cleanup of this owner's expired state rows so the table
    // doesn't accumulate dead nonces. Bounded; any leftovers get caught by
    // the next call or the periodic `purgeExpiredSlackOAuthStates` mutation.
    const expiredOwnRows = await ctx.db
      .query("slack_oauth_states")
      .withIndex("by_ownerId_and_expiresAt", (q) =>
        q.eq("ownerId", ownerId).lt("expiresAt", now),
      )
      .take(SLACK_OAUTH_EXPIRED_CLEANUP_BATCH);
    await Promise.all(expiredOwnRows.map((row) => ctx.db.delete(row._id)));

    await ctx.db.insert("slack_oauth_states", {
      ownerId,
      stateHash,
      expiresAt,
      createdAt: now,
    });

    const redirectUri = `${convexSiteUrl}/api/slack/oauth_callback`;
    const url =
      `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(clientId)}` +
      `&scope=${encodeURIComponent(SLACK_OAUTH_SCOPE)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}`;

    return { url, expiresAt };
  },
});

export const consumeSlackOAuthState = internalMutation({
  args: {
    state: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const stateHash = await hashSha256Hex(args.state);
    const candidate = await ctx.db
      .query("slack_oauth_states")
      .withIndex("by_stateHash", (q) => q.eq("stateHash", stateHash))
      .unique();

    if (!candidate) return null;
    if (candidate.usedAt !== undefined) return null;
    if (candidate.expiresAt <= now) return null;

    await ctx.db.patch(candidate._id, { usedAt: now });
    return { ownerId: candidate.ownerId };
  },
});

/**
 * Periodic cleanup for expired Slack OAuth state nonces. Returns
 * `hasMore: true` while there are more rows to delete and self-schedules a
 * follow-up via `ctx.scheduler.runAfter(0, ...)` so a single hourly cron tick
 * can drain a large backlog without blowing the per-mutation transaction
 * limits.
 */
export const purgeExpiredSlackOAuthStates = internalMutation({
  args: {
    batchSize: v.optional(v.number()),
  },
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const batchSize = Math.min(Math.max(Math.floor(args.batchSize ?? 200), 1), 1000);
    const now = Date.now();
    const expired = await ctx.db
      .query("slack_oauth_states")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(batchSize);
    await Promise.all(expired.map((row) => ctx.db.delete(row._id)));
    const hasMore = expired.length === batchSize;
    if (hasMore) {
      await ctx.scheduler.runAfter(
        0,
        internal.data.integrations.purgeExpiredSlackOAuthStates,
        { batchSize },
      );
    }
    return { deleted: expired.length, hasMore };
  },
});

export const createXConnectUrl = mutation({
  args: {},
  returns: v.object({ url: v.string(), expiresAt: v.number() }),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);

    await enforceMutationRateLimit(
      ctx,
      "data_create_x_connect_url",
      ownerId,
      RATE_VERY_EXPENSIVE,
      "Too many X connect requests. Please wait before trying again.",
    );

    const clientId = process.env.X_CLIENT_ID;
    const convexSiteUrl = configuredOAuthSiteUrl();

    if (!clientId || !convexSiteUrl) {
      throw new ConvexError({ code: "INTERNAL_ERROR", message: "X OAuth is not configured" });
    }

    const now = Date.now();
    const expiresAt = now + X_OAUTH_STATE_TTL_MS;
    const state = generateXOAuthState();
    const stateHash = await hashSha256Hex(state);
    const codeVerifier = generateXCodeVerifier();
    const codeChallenge = await buildXCodeChallenge(codeVerifier);

    const expiredOwnRows = await ctx.db
      .query("x_oauth_states")
      .withIndex("by_ownerId_and_expiresAt", (q) =>
        q.eq("ownerId", ownerId).lt("expiresAt", now),
      )
      .take(X_OAUTH_EXPIRED_CLEANUP_BATCH);
    await Promise.all(expiredOwnRows.map((row) => ctx.db.delete(row._id)));

    await ctx.db.insert("x_oauth_states", {
      ownerId,
      stateHash,
      codeVerifier,
      expiresAt,
      createdAt: now,
    });

    const redirectUri = `${convexSiteUrl}/api/x/oauth_callback`;
    const url = buildXAuthorizationUrl({
      clientId,
      redirectUri,
      state,
      codeChallenge,
      scopes: X_OAUTH_SCOPES,
    });

    return { url, expiresAt };
  },
});

export const consumeXOAuthState = internalMutation({
  args: {
    state: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      ownerId: v.string(),
      codeVerifier: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const stateHash = await hashSha256Hex(args.state);
    const candidate = await ctx.db
      .query("x_oauth_states")
      .withIndex("by_stateHash", (q) => q.eq("stateHash", stateHash))
      .unique();

    if (!candidate) return null;
    if (candidate.usedAt !== undefined) return null;
    if (candidate.expiresAt <= now) return null;

    await ctx.db.patch(candidate._id, { usedAt: now });
    return { ownerId: candidate.ownerId, codeVerifier: candidate.codeVerifier };
  },
});

export const upsertXOAuthTokensForOwner = internalMutation({
  args: {
    ownerId: v.string(),
    xUserId: v.string(),
    username: v.string(),
    name: v.optional(v.string()),
    tokenSet: jsonObjectValidator,
    scopes: v.array(v.string()),
    tokenType: v.string(),
    accessTokenExpiresAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const encryptedTokenSet = await encryptSecret(JSON.stringify(args.tokenSet));
    const existing = await ctx.db
      .query("x_oauth_tokens")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        xUserId: args.xUserId,
        username: args.username,
        name: args.name,
        encryptedTokenSet: JSON.stringify(encryptedTokenSet),
        tokenKeyVersion: encryptedTokenSet.keyVersion,
        scopes: args.scopes,
        tokenType: args.tokenType,
        accessTokenExpiresAt: args.accessTokenExpiresAt,
        updatedAt: now,
      });
      await upsertUserIntegrationForOwnerHandler(ctx, {
        ownerId: args.ownerId,
        provider: X_PROVIDER_ID,
        mode: "oauth",
        externalId: args.xUserId,
        config: {
          username: args.username,
          name: args.name ?? null,
          scopes: args.scopes,
          tokenRowId: existing._id,
        },
      });
      return null;
    }

    const tokenRowId = await ctx.db.insert("x_oauth_tokens", {
      ownerId: args.ownerId,
      xUserId: args.xUserId,
      username: args.username,
      name: args.name,
      encryptedTokenSet: JSON.stringify(encryptedTokenSet),
      tokenKeyVersion: encryptedTokenSet.keyVersion,
      scopes: args.scopes,
      tokenType: args.tokenType,
      accessTokenExpiresAt: args.accessTokenExpiresAt,
      createdAt: now,
      updatedAt: now,
    });

    await upsertUserIntegrationForOwnerHandler(ctx, {
      ownerId: args.ownerId,
      provider: X_PROVIDER_ID,
      mode: "oauth",
      externalId: args.xUserId,
      config: {
        username: args.username,
        name: args.name ?? null,
        scopes: args.scopes,
        tokenRowId,
      },
    });
    return null;
  },
});

export const getXOAuthTokenForOwner = internalQuery({
  args: {
    ownerId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("x_oauth_tokens"),
      _creationTime: v.number(),
      ownerId: v.string(),
      xUserId: v.string(),
      username: v.string(),
      name: v.optional(v.string()),
      encryptedTokenSet: v.string(),
      tokenKeyVersion: v.number(),
      scopes: v.array(v.string()),
      tokenType: v.string(),
      accessTokenExpiresAt: v.optional(v.number()),
      createdAt: v.number(),
      updatedAt: v.number(),
      lastRefreshedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("x_oauth_tokens")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();
  },
});

export const updateXOAuthTokenSetForOwner = internalMutation({
  args: {
    ownerId: v.string(),
    tokenSet: jsonObjectValidator,
    scopes: v.array(v.string()),
    tokenType: v.string(),
    accessTokenExpiresAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("x_oauth_tokens")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    if (!existing) return null;
    const encryptedTokenSet = await encryptSecret(JSON.stringify(args.tokenSet));
    await ctx.db.patch(existing._id, {
      encryptedTokenSet: JSON.stringify(encryptedTokenSet),
      tokenKeyVersion: encryptedTokenSet.keyVersion,
      scopes: args.scopes,
      tokenType: args.tokenType,
      accessTokenExpiresAt: args.accessTokenExpiresAt,
      updatedAt: Date.now(),
      lastRefreshedAt: Date.now(),
    });
    await upsertUserIntegrationForOwnerHandler(ctx, {
      ownerId: args.ownerId,
      provider: X_PROVIDER_ID,
      mode: "oauth",
      externalId: existing.xUserId,
      config: {
        username: existing.username,
        name: existing.name ?? null,
        scopes: args.scopes,
        tokenRowId: existing._id,
      },
    });
    return null;
  },
});

export const purgeExpiredXOAuthStates = internalMutation({
  args: {
    batchSize: v.optional(v.number()),
  },
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const batchSize = Math.min(Math.max(Math.floor(args.batchSize ?? 200), 1), 1000);
    const now = Date.now();
    const expired = await ctx.db
      .query("x_oauth_states")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(batchSize);
    await Promise.all(expired.map((row) => ctx.db.delete(row._id)));
    const hasMore = expired.length === batchSize;
    if (hasMore) {
      await ctx.scheduler.runAfter(
        0,
        internal.data.integrations.purgeExpiredXOAuthStates,
        { batchSize },
      );
    }
    return { deleted: expired.length, hasMore };
  },
});

export const listXConnections = query({
  args: {},
  returns: v.array(
    v.object({
      xUserId: v.string(),
      username: v.string(),
      name: v.optional(v.string()),
      scopes: v.array(v.string()),
      updatedAt: v.number(),
      accessTokenExpiresAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const rows = await ctx.db
      .query("x_oauth_tokens")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .take(1);
    return rows.map((row) => ({
      xUserId: row.xUserId,
      username: row.username,
      name: row.name,
      scopes: row.scopes,
      updatedAt: row.updatedAt,
      accessTokenExpiresAt: row.accessTokenExpiresAt,
    }));
  },
});

const getPublicIntegrationByIdHandler = async (ctx: Pick<QueryCtx, "db">, args: { id: string }) => {
  const record = await ctx.db
    .query("integrations_public")
    .withIndex("by_integrationId", (q) => q.eq("id", args.id))
    .unique();
  if (!record || !isExecutableStoreIntegration(record)) {
    return null;
  }
  return record;
};


export const getPublicIntegrationById = internalQuery({
  args: {
    id: v.string(),
  },
  returns: v.union(v.null(), integrationPublicDocumentValidator),
  handler: async (ctx, args) => {
    return await getPublicIntegrationByIdHandler(ctx, args);
  },
});

const storedIntegrationActionValidator = v.object({
  name: v.string(),
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  inputSchemaJson: v.string(),
});

export const listPublicIntegrationActions = internalQuery({
  args: {
    id: v.string(),
    cursor: v.union(v.string(), v.null()),
    limit: v.number(),
    query: v.optional(v.string()),
  },
  returns: v.union(
    v.null(),
    v.object({
      id: v.string(),
      actionCount: v.number(),
      updatedAt: v.number(),
      isDone: v.boolean(),
      continueCursor: v.string(),
      actions: v.array(storedIntegrationActionValidator),
    }),
  ),
  handler: async (ctx, args) => {
    const id = args.id.trim().toLowerCase();
    const integration = await getPublicIntegrationByIdHandler(ctx, { id });
    if (!integration || !isExecutableStoreIntegration(integration)) return null;
    const limit = Math.min(
      Math.max(Math.floor(args.limit), 1),
      MAX_INTEGRATION_ACTIONS_PAGE_SIZE,
    );
    const search = args.query?.trim();
    const page = search
      ? await ctx.db
          .query("integration_actions")
          .withSearchIndex("search_searchText", (q) =>
            q.search("searchText", search).eq("integrationId", id),
          )
          .paginate({ numItems: limit, cursor: args.cursor })
      : await ctx.db
          .query("integration_actions")
          .withIndex("by_integrationId_and_name", (q) =>
            q.eq("integrationId", id),
          )
          .paginate({ numItems: limit, cursor: args.cursor });
    return {
      id,
      actionCount: integration.actionCount!,
      updatedAt: integration.updatedAt,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      actions: page.page.map((action) => ({
        name: action.name,
        title: action.title,
        description: action.description,
        inputSchemaJson: action.inputSchemaJson,
      })),
    };
  },
});

export const getPublicIntegrationAction = internalQuery({
  args: { id: v.string(), name: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      id: v.string(),
      connector: storeIntegrationConnectorValidator,
      action: storedIntegrationActionValidator,
    }),
  ),
  handler: async (ctx, args) => {
    const id = args.id.trim().toLowerCase();
    const integration = await getPublicIntegrationByIdHandler(ctx, { id });
    if (!integration || !isExecutableStoreIntegration(integration)) return null;
    const action = await ctx.db
      .query("integration_actions")
      .withIndex("by_integrationId_and_name", (q) =>
        q.eq("integrationId", id).eq("name", args.name),
      )
      .unique();
    return action && isComposioConnector(integration.connector)
      ? {
          id,
          connector: integration.connector,
          action: {
            name: action.name,
            title: action.title,
            description: action.description,
            inputSchemaJson: action.inputSchemaJson,
          },
        }
      : null;
  },
});

export const getUserIntegrationByOwnerAndProvider = internalQuery({
  args: {
    ownerId: v.string(),
    provider: v.string(),
  },
  returns: v.union(v.null(), userIntegrationDocumentValidator),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("user_integrations")
      .withIndex("by_ownerId_and_provider", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", args.provider),
      )
      .unique();
  },
});

export const listUserIntegrations = internalQuery({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    return await ctx.db
      .query("user_integrations")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(200);
  },
});

export const upsertUserIntegration = internalMutation({
  args: {
    provider: v.string(),
    mode: v.string(),
    externalId: v.optional(v.string()),
    config: jsonObjectValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    return await upsertUserIntegrationForOwnerHandler(ctx, {
      ownerId,
      provider: args.provider,
      mode: args.mode,
      externalId: args.externalId,
      config: args.config,
    });
  },
});

export const upsertUserIntegrationForOwner = internalMutation({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    mode: v.string(),
    externalId: v.optional(v.string()),
    config: jsonObjectValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    return await upsertUserIntegrationForOwnerHandler(ctx, args);
  },
});
