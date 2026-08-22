import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "../../_generated/server";
import { internal } from "../../_generated/api";
import {
  decryptSecret,
  encryptSecret,
  getActiveSecretKeyVersion,
  rotateSecretToActiveKey,
} from "../../data/secrets_crypto";
import { enforceActionRateLimit, RATE_SENSITIVE } from "../../lib/rate_limits";
import { ConnectorError } from "../errors";
import { isProviderEnabled } from "../env";
import {
  getHostedConnectProviderDescriptor,
  isHostedConnectProviderVerified,
  requireReadyHostedConnectProvider,
  validateHostedConnectToken,
} from "./providers";
import { normalizeHostedConnectOrigin } from "./origin";

const DESTROYED_CREDENTIAL = "";

const requireOwnerId = async (ctx: {
  auth: { getUserIdentity: () => Promise<{ tokenIdentifier: string } | null> };
}) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConnectorError("unauthorized");
  return identity.tokenIdentifier;
};

const connectionStatus = (
  descriptor: NonNullable<
    ReturnType<typeof getHostedConnectProviderDescriptor>
  >,
  credential: {
    status: "active" | "invalid";
    generation: number;
    updatedAt: number;
    encryptedToken: string;
    boundOrigin: string;
  } | null,
) => {
  const providerEnabled = isProviderEnabled(descriptor.providerKey);
  const providerVerified = isHostedConnectProviderVerified(
    descriptor.providerKey,
  );
  const connected = Boolean(
    credential?.status === "active" && credential.encryptedToken,
  );
  return {
    connectorId: descriptor.connectorId,
    provider: descriptor.providerKey,
    authType: "hosted_connect" as const,
    connected,
    configured: Boolean(credential),
    accountStatus: credential?.status ?? "disconnected",
    // The bound origin is not a secret; surfacing it lets the UI show which
    // Connect server is bound. The token envelope is never returned.
    boundOrigin: connected ? credential?.boundOrigin : undefined,
    generation: credential?.generation,
    updatedAt: credential?.updatedAt,
    providerEnabled,
    providerVerified,
    ready: connected && providerEnabled && providerVerified,
    credentialLabel: descriptor.credentialLabel,
    originLabel: descriptor.originLabel,
    originPlaceholder: descriptor.originPlaceholder,
  };
};

const publicConnectionStatusValidator = v.object({
  connectorId: v.string(),
  provider: v.string(),
  authType: v.literal("hosted_connect"),
  connected: v.boolean(),
  configured: v.boolean(),
  accountStatus: v.string(),
  boundOrigin: v.optional(v.string()),
  generation: v.optional(v.number()),
  updatedAt: v.optional(v.number()),
  providerEnabled: v.boolean(),
  providerVerified: v.boolean(),
  ready: v.boolean(),
  credentialLabel: v.string(),
  originLabel: v.string(),
  originPlaceholder: v.string(),
});

export const getHostedConnectStatus = query({
  args: { connectorId: v.string() },
  returns: publicConnectionStatusValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const descriptor = getHostedConnectProviderDescriptor(args.connectorId);
    if (!descriptor) throw new ConnectorError("provider_not_configured");
    const credential = await ctx.db
      .query("connector_hosted_profiles")
      .withIndex("by_owner_provider", (q) =>
        q.eq("ownerId", ownerId).eq("provider", descriptor.providerKey),
      )
      .unique();
    return connectionStatus(descriptor, credential);
  },
});

export const getHostedConnectReadiness = internalQuery({
  args: { ownerId: v.string(), connectorId: v.string() },
  returns: v.union(v.null(), publicConnectionStatusValidator),
  handler: async (ctx, args) => {
    const descriptor = getHostedConnectProviderDescriptor(args.connectorId);
    if (!descriptor) return null;
    const credential = await ctx.db
      .query("connector_hosted_profiles")
      .withIndex("by_owner_provider", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", descriptor.providerKey),
      )
      .unique();
    return connectionStatus(descriptor, credential);
  },
});

export const getEncryptedHostedConnectForExecution = internalQuery({
  args: { ownerId: v.string(), connectorId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      ownerId: v.string(),
      provider: v.string(),
      encryptedToken: v.string(),
      boundOrigin: v.string(),
      status: v.string(),
      generation: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const descriptor = getHostedConnectProviderDescriptor(args.connectorId);
    if (!descriptor) return null;
    const credential = await ctx.db
      .query("connector_hosted_profiles")
      .withIndex("by_owner_provider", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", descriptor.providerKey),
      )
      .unique();
    if (!credential) return null;
    return {
      ownerId: credential.ownerId,
      provider: credential.provider,
      encryptedToken: credential.encryptedToken,
      boundOrigin: credential.boundOrigin,
      status: credential.status,
      generation: credential.generation,
    };
  },
});

export const commitHostedConnectProfile = internalMutation({
  args: {
    ownerId: v.string(),
    connectorId: v.string(),
    provider: v.string(),
    encryptedToken: v.string(),
    keyVersion: v.number(),
    boundOrigin: v.string(),
    expectedGeneration: v.optional(v.number()),
  },
  returns: v.object({ generation: v.number(), replaced: v.boolean() }),
  handler: async (ctx, args) => {
    const descriptor = getHostedConnectProviderDescriptor(args.connectorId);
    if (!descriptor || descriptor.providerKey !== args.provider) {
      throw new ConnectorError("provider_not_configured");
    }
    const existing = await ctx.db
      .query("connector_hosted_profiles")
      .withIndex("by_owner_provider", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", args.provider),
      )
      .unique();
    const now = Date.now();
    if (existing) {
      if (
        args.expectedGeneration === undefined ||
        args.expectedGeneration !== existing.generation
      ) {
        throw new ConnectorError("credential_generation_conflict");
      }
      const generation = existing.generation + 1;
      await ctx.db.patch(existing._id, {
        connectorId: descriptor.connectorId,
        encryptedToken: args.encryptedToken,
        keyVersion: args.keyVersion,
        boundOrigin: args.boundOrigin,
        status: "active",
        generation,
        updatedAt: now,
        invalidatedAt: undefined,
      });
      return { generation, replaced: true };
    }
    if (args.expectedGeneration !== undefined) {
      throw new ConnectorError("credential_generation_conflict");
    }
    await ctx.db.insert("connector_hosted_profiles", {
      ownerId: args.ownerId,
      connectorId: descriptor.connectorId,
      provider: descriptor.providerKey,
      encryptedToken: args.encryptedToken,
      keyVersion: args.keyVersion,
      boundOrigin: args.boundOrigin,
      status: "active",
      generation: 1,
      createdAt: now,
      updatedAt: now,
    });
    return { generation: 1, replaced: false };
  },
});

export const connectHostedConnectProfile = action({
  args: {
    connectorId: v.string(),
    origin: v.string(),
    token: v.string(),
    expectedGeneration: v.optional(v.number()),
  },
  returns: v.object({
    connected: v.literal(true),
    provider: v.string(),
    boundOrigin: v.string(),
    generation: v.number(),
    replaced: v.boolean(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    connected: true;
    provider: string;
    boundOrigin: string;
    generation: number;
    replaced: boolean;
  }> => {
    const ownerId = await requireOwnerId(ctx);
    await enforceActionRateLimit(
      ctx,
      "connector_hosted_connect_connect",
      ownerId,
      RATE_SENSITIVE,
      "Too many connection changes. Please wait before trying again.",
    );
    const descriptor = requireReadyHostedConnectProvider(args.connectorId);
    // Validate the origin (SSRF) and token before any secret work.
    const boundOrigin = normalizeHostedConnectOrigin(args.origin);
    const token = validateHostedConnectToken(args.token);
    const envelope = await encryptSecret(token);
    const result: { generation: number; replaced: boolean } =
      await ctx.runMutation(
        internal.connectors.hosted_connect.vault.commitHostedConnectProfile,
        {
          ownerId,
          connectorId: descriptor.connectorId,
          provider: descriptor.providerKey,
          encryptedToken: JSON.stringify(envelope),
          keyVersion: envelope.keyVersion,
          boundOrigin,
          expectedGeneration: args.expectedGeneration,
        },
      );
    await ctx.runMutation(internal.connectors.audit.recordConnectorAuditEvent, {
      ownerId,
      connectorId: descriptor.connectorId,
      provider: descriptor.providerKey,
      executor: "first_party",
      event: result.replaced
        ? "hosted_connect_replaced"
        : "hosted_connect_connected",
      outcome: "ok",
    });
    return {
      connected: true,
      provider: descriptor.providerKey,
      boundOrigin,
      generation: result.generation,
      replaced: result.replaced,
    };
  },
});

export const deleteHostedConnectProfile = internalMutation({
  args: { ownerId: v.string(), connectorId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const descriptor = getHostedConnectProviderDescriptor(args.connectorId);
    if (!descriptor) throw new ConnectorError("provider_not_configured");
    const credential = await ctx.db
      .query("connector_hosted_profiles")
      .withIndex("by_owner_provider", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", descriptor.providerKey),
      )
      .unique();
    if (!credential) return false;
    await ctx.db.delete(credential._id);
    return true;
  },
});

export const disconnectHostedConnectProfile = action({
  args: { connectorId: v.string() },
  returns: v.object({ connected: v.literal(false), disconnected: v.boolean() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ connected: false; disconnected: boolean }> => {
    const ownerId = await requireOwnerId(ctx);
    await enforceActionRateLimit(
      ctx,
      "connector_hosted_connect_disconnect",
      ownerId,
      RATE_SENSITIVE,
      "Too many connection changes. Please wait before trying again.",
    );
    const descriptor = getHostedConnectProviderDescriptor(args.connectorId);
    if (!descriptor) throw new ConnectorError("provider_not_configured");
    const disconnected: boolean = await ctx.runMutation(
      internal.connectors.hosted_connect.vault.deleteHostedConnectProfile,
      { ownerId, connectorId: descriptor.connectorId },
    );
    await ctx.runMutation(internal.connectors.audit.recordConnectorAuditEvent, {
      ownerId,
      connectorId: descriptor.connectorId,
      provider: descriptor.providerKey,
      executor: "first_party",
      event: "hosted_connect_disconnected",
      outcome: disconnected ? "ok" : "skipped",
    });
    return { connected: false, disconnected };
  },
});

export const loadHostedConnectForExecution = internalAction({
  args: { ownerId: v.string(), connectorId: v.string() },
  returns: v.object({
    token: v.string(),
    boundOrigin: v.string(),
    provider: v.string(),
    generation: v.number(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    token: string;
    boundOrigin: string;
    provider: string;
    generation: number;
  }> => {
    const descriptor = requireReadyHostedConnectProvider(args.connectorId);
    const credential: {
      ownerId: string;
      provider: string;
      encryptedToken: string;
      boundOrigin: string;
      status: string;
      generation: number;
    } | null = await ctx.runQuery(
      internal.connectors.hosted_connect.vault
        .getEncryptedHostedConnectForExecution,
      args,
    );
    if (!credential) throw new ConnectorError("not_connected");
    if (
      credential.ownerId !== args.ownerId ||
      credential.provider !== descriptor.providerKey
    ) {
      throw new ConnectorError("account_mismatch");
    }
    if (credential.status !== "active" || !credential.encryptedToken) {
      throw new ConnectorError("invalid_credential");
    }
    // Re-validate the stored origin: a profile can never execute against an
    // origin that no longer passes SSRF validation.
    const boundOrigin = normalizeHostedConnectOrigin(credential.boundOrigin);
    try {
      const token = validateHostedConnectToken(
        await decryptSecret(credential.encryptedToken),
      );
      return {
        token,
        boundOrigin,
        provider: credential.provider,
        generation: credential.generation,
      };
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("invalid_credential");
    }
  },
});

export const markHostedConnectInvalid = internalMutation({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    expectedGeneration: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const credential = await ctx.db
      .query("connector_hosted_profiles")
      .withIndex("by_owner_provider", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", args.provider),
      )
      .unique();
    if (!credential || credential.generation !== args.expectedGeneration) {
      return false;
    }
    await ctx.db.patch(credential._id, {
      encryptedToken: DESTROYED_CREDENTIAL,
      keyVersion: 0,
      status: "invalid",
      generation: credential.generation + 1,
      invalidatedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const markHostedConnectUsed = internalMutation({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    expectedGeneration: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const credential = await ctx.db
      .query("connector_hosted_profiles")
      .withIndex("by_owner_provider", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", args.provider),
      )
      .unique();
    if (credential?.generation === args.expectedGeneration) {
      await ctx.db.patch(credential._id, {
        lastUsedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

export const rotateHostedConnectCredentialsBatch = internalMutation({
  args: { batchSize: v.optional(v.number()) },
  returns: v.object({
    activeKeyVersion: v.number(),
    rotated: v.number(),
    skipped: v.number(),
    failed: v.number(),
    hasMoreCandidates: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const activeKeyVersion = getActiveSecretKeyVersion();
    const batchSize = Math.min(
      Math.max(Math.floor(args.batchSize ?? 100), 1),
      500,
    );
    const below = await ctx.db
      .query("connector_hosted_profiles")
      .withIndex("by_keyVersion", (q) => q.lt("keyVersion", activeKeyVersion))
      .take(batchSize);
    const above = await ctx.db
      .query("connector_hosted_profiles")
      .withIndex("by_keyVersion", (q) => q.gt("keyVersion", activeKeyVersion))
      .take(batchSize);
    const candidates = [...below, ...above]
      .filter((candidate) => Boolean(candidate.encryptedToken))
      .slice(0, batchSize);
    let rotated = 0;
    let skipped = 0;
    let failed = 0;
    for (const candidate of candidates) {
      try {
        const result = await rotateSecretToActiveKey(candidate.encryptedToken);
        if (!result.changed) {
          skipped += 1;
          continue;
        }
        await ctx.db.patch(candidate._id, {
          encryptedToken: result.serialized,
          keyVersion: result.keyVersion,
          updatedAt: Date.now(),
        });
        rotated += 1;
      } catch {
        failed += 1;
      }
    }
    return {
      activeKeyVersion,
      rotated,
      skipped,
      failed,
      hasMoreCandidates: candidates.length === batchSize && rotated > 0,
    };
  },
});
