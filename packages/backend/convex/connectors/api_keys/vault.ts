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
  DEFAULT_API_KEY_CREDENTIAL_SLOT,
  getApiKeyActionTarget,
  getApiKeyCredentialProfile,
  getApiKeyCredentialProfiles,
  getApiKeyProviderDescriptor,
  isApiKeyProviderVerified,
  requireReadyApiKeyProvider,
  validateApiKeyCredential,
} from "./providers";

const DESTROYED_CREDENTIAL = "";

const rowCredentialSlot = (credential: { credentialSlot?: string }) =>
  credential.credentialSlot ?? DEFAULT_API_KEY_CREDENTIAL_SLOT;

const credentialForSlot = <T extends { credentialSlot?: string }>(
  credentials: T[],
  credentialSlot: string,
): T | null => {
  const matches = credentials.filter(
    (credential) => rowCredentialSlot(credential) === credentialSlot,
  );
  if (matches.length > 1) throw new ConnectorError("internal_error");
  return matches[0] ?? null;
};

const requireOwnerId = async (ctx: {
  auth: { getUserIdentity: () => Promise<{ tokenIdentifier: string } | null> };
}) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConnectorError("unauthorized");
  return identity.tokenIdentifier;
};

const connectionStatus = (
  descriptor: NonNullable<ReturnType<typeof getApiKeyProviderDescriptor>>,
  credentials: Array<{
    credentialSlot?: string;
    status: "active" | "invalid";
    generation: number;
    updatedAt: number;
    encryptedKey: string;
  }>,
  action?: string,
) => {
  const providerEnabled = isProviderEnabled(descriptor.providerKey);
  const providerVerified = isApiKeyProviderVerified(descriptor.providerKey);
  const profiles = getApiKeyCredentialProfiles(descriptor);
  const profileStatuses = profiles.map((profile) => {
    const credential = credentialForSlot(credentials, profile.credentialSlot);
    const connected = Boolean(
      credential?.status === "active" && credential.encryptedKey,
    );
    return {
      credentialSlot: profile.credentialSlot,
      credentialLabel: profile.credentialLabel,
      connected,
      configured: Boolean(credential),
      accountStatus: credential?.status ?? "disconnected",
      generation: credential?.generation,
      updatedAt: credential?.updatedAt,
    };
  });
  const targetSlot = action
    ? getApiKeyActionTarget(descriptor, action)?.credentialSlot
    : undefined;
  const requiredProfiles = targetSlot
    ? profileStatuses.filter((profile) => profile.credentialSlot === targetSlot)
    : profileStatuses;
  const connected =
    requiredProfiles.length > 0 &&
    requiredProfiles.every((profile) => profile.connected);
  const configured = requiredProfiles.some((profile) => profile.configured);
  const singleCredential =
    requiredProfiles.length === 1
      ? credentialForSlot(credentials, requiredProfiles[0]!.credentialSlot)
      : null;
  const accountStatus = connected
    ? "active"
    : !configured
      ? "disconnected"
      : requiredProfiles.length === 1 && singleCredential?.status === "invalid"
        ? "invalid"
        : "incomplete";
  return {
    connectorId: descriptor.connectorId,
    provider: descriptor.providerKey,
    authType: "api_key" as const,
    connected,
    configured,
    accountStatus,
    generation: singleCredential?.generation,
    updatedAt: singleCredential?.updatedAt,
    providerEnabled,
    providerVerified,
    ready: connected && providerEnabled && providerVerified,
    credentialLabel: descriptor.credentialLabel,
    credentialProfiles: profileStatuses,
    missingCredentialSlots: requiredProfiles
      .filter((profile) => !profile.connected)
      .map((profile) => profile.credentialSlot),
  };
};

const credentialProfileStatusValidator = v.object({
  credentialSlot: v.string(),
  credentialLabel: v.string(),
  connected: v.boolean(),
  configured: v.boolean(),
  accountStatus: v.string(),
  generation: v.optional(v.number()),
  updatedAt: v.optional(v.number()),
});

const publicConnectionStatusValidator = v.object({
  connectorId: v.string(),
  provider: v.string(),
  authType: v.literal("api_key"),
  connected: v.boolean(),
  configured: v.boolean(),
  accountStatus: v.string(),
  generation: v.optional(v.number()),
  updatedAt: v.optional(v.number()),
  providerEnabled: v.boolean(),
  providerVerified: v.boolean(),
  ready: v.boolean(),
  credentialLabel: v.string(),
  credentialProfiles: v.array(credentialProfileStatusValidator),
  missingCredentialSlots: v.array(v.string()),
});

export const getApiKeyConnectionStatus = query({
  args: { connectorId: v.string() },
  returns: publicConnectionStatusValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const descriptor = getApiKeyProviderDescriptor(args.connectorId);
    if (!descriptor) throw new ConnectorError("provider_not_configured");
    const credentials = await ctx.db
      .query("api_key_credentials")
      .withIndex("by_owner_provider", (q) =>
        q.eq("ownerId", ownerId).eq("provider", descriptor.providerKey),
      )
      .collect();
    return connectionStatus(descriptor, credentials);
  },
});

export const getApiKeyReadiness = internalQuery({
  args: {
    ownerId: v.string(),
    connectorId: v.string(),
    action: v.optional(v.string()),
  },
  returns: v.union(v.null(), publicConnectionStatusValidator),
  handler: async (ctx, args) => {
    const descriptor = getApiKeyProviderDescriptor(args.connectorId);
    if (!descriptor) return null;
    const credentials = await ctx.db
      .query("api_key_credentials")
      .withIndex("by_owner_provider", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", descriptor.providerKey),
      )
      .collect();
    return connectionStatus(descriptor, credentials, args.action);
  },
});

export const getEncryptedApiKeyForExecution = internalQuery({
  args: { ownerId: v.string(), connectorId: v.string(), action: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      ownerId: v.string(),
      provider: v.string(),
      credentialSlot: v.string(),
      encryptedKey: v.string(),
      status: v.string(),
      generation: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const descriptor = getApiKeyProviderDescriptor(args.connectorId);
    if (!descriptor) return null;
    const target = getApiKeyActionTarget(descriptor, args.action);
    if (!target) return null;
    const credentials = await ctx.db
      .query("api_key_credentials")
      .withIndex("by_owner_provider", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", descriptor.providerKey),
      )
      .collect();
    const credential = credentialForSlot(credentials, target.credentialSlot);
    if (!credential) return null;
    return {
      ownerId: credential.ownerId,
      provider: credential.provider,
      credentialSlot: target.credentialSlot,
      encryptedKey: credential.encryptedKey,
      status: credential.status,
      generation: credential.generation,
    };
  },
});

export const commitEncryptedApiKey = internalMutation({
  args: {
    ownerId: v.string(),
    connectorId: v.string(),
    provider: v.string(),
    credentialSlot: v.string(),
    encryptedKey: v.string(),
    keyVersion: v.number(),
    expectedGeneration: v.optional(v.number()),
  },
  returns: v.object({ generation: v.number(), replaced: v.boolean() }),
  handler: async (ctx, args) => {
    const descriptor = getApiKeyProviderDescriptor(args.connectorId);
    if (!descriptor || descriptor.providerKey !== args.provider) {
      throw new ConnectorError("provider_not_configured");
    }
    if (!getApiKeyCredentialProfile(descriptor, args.credentialSlot)) {
      throw new ConnectorError("invalid_input");
    }
    const credentials = await ctx.db
      .query("api_key_credentials")
      .withIndex("by_owner_provider", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", args.provider),
      )
      .collect();
    const existing = credentialForSlot(credentials, args.credentialSlot);
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
        credentialSlot: args.credentialSlot,
        encryptedKey: args.encryptedKey,
        keyVersion: args.keyVersion,
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
    await ctx.db.insert("api_key_credentials", {
      ownerId: args.ownerId,
      connectorId: descriptor.connectorId,
      provider: descriptor.providerKey,
      credentialSlot: args.credentialSlot,
      encryptedKey: args.encryptedKey,
      keyVersion: args.keyVersion,
      status: "active",
      generation: 1,
      createdAt: now,
      updatedAt: now,
    });
    return { generation: 1, replaced: false };
  },
});

export const connectApiKey = action({
  args: {
    connectorId: v.string(),
    apiKey: v.string(),
    credentialSlot: v.optional(v.string()),
    expectedGeneration: v.optional(v.number()),
  },
  returns: v.object({
    connected: v.literal(true),
    provider: v.string(),
    credentialSlot: v.string(),
    generation: v.number(),
    replaced: v.boolean(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    connected: true;
    provider: string;
    credentialSlot: string;
    generation: number;
    replaced: boolean;
  }> => {
    const ownerId = await requireOwnerId(ctx);
    await enforceActionRateLimit(
      ctx,
      "connector_api_key_connect",
      ownerId,
      RATE_SENSITIVE,
      "Too many API-key changes. Please wait before trying again.",
    );
    const descriptor = requireReadyApiKeyProvider(args.connectorId);
    const profiles = getApiKeyCredentialProfiles(descriptor);
    const credentialSlot =
      args.credentialSlot ??
      (profiles.length === 1 ? profiles[0]!.credentialSlot : null);
    if (
      !credentialSlot ||
      !getApiKeyCredentialProfile(descriptor, credentialSlot)
    ) {
      throw new ConnectorError("invalid_input");
    }
    const key = validateApiKeyCredential(args.apiKey, descriptor.auth);
    const envelope = await encryptSecret(key);
    const result: { generation: number; replaced: boolean } =
      await ctx.runMutation(
        internal.connectors.api_keys.vault.commitEncryptedApiKey,
        {
          ownerId,
          connectorId: descriptor.connectorId,
          provider: descriptor.providerKey,
          credentialSlot,
          encryptedKey: JSON.stringify(envelope),
          keyVersion: envelope.keyVersion,
          expectedGeneration: args.expectedGeneration,
        },
      );
    await ctx.runMutation(internal.connectors.audit.recordConnectorAuditEvent, {
      ownerId,
      connectorId: descriptor.connectorId,
      provider: descriptor.providerKey,
      executor: "first_party",
      event: result.replaced ? "api_key_replaced" : "api_key_connected",
      outcome: "ok",
    });
    return {
      connected: true,
      provider: descriptor.providerKey,
      credentialSlot,
      generation: result.generation,
      replaced: result.replaced,
    };
  },
});

export const deleteApiKey = internalMutation({
  args: { ownerId: v.string(), connectorId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const descriptor = getApiKeyProviderDescriptor(args.connectorId);
    if (!descriptor) throw new ConnectorError("provider_not_configured");
    const credentials = await ctx.db
      .query("api_key_credentials")
      .withIndex("by_owner_provider", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", descriptor.providerKey),
      )
      .collect();
    for (const credential of credentials) {
      await ctx.db.delete(credential._id);
    }
    return credentials.length > 0;
  },
});

export const disconnectApiKey = action({
  args: { connectorId: v.string() },
  returns: v.object({ connected: v.literal(false), disconnected: v.boolean() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ connected: false; disconnected: boolean }> => {
    const ownerId = await requireOwnerId(ctx);
    await enforceActionRateLimit(
      ctx,
      "connector_api_key_disconnect",
      ownerId,
      RATE_SENSITIVE,
      "Too many API-key changes. Please wait before trying again.",
    );
    const descriptor = getApiKeyProviderDescriptor(args.connectorId);
    if (!descriptor) throw new ConnectorError("provider_not_configured");
    const disconnected: boolean = await ctx.runMutation(
      internal.connectors.api_keys.vault.deleteApiKey,
      { ownerId, connectorId: descriptor.connectorId },
    );
    await ctx.runMutation(internal.connectors.audit.recordConnectorAuditEvent, {
      ownerId,
      connectorId: descriptor.connectorId,
      provider: descriptor.providerKey,
      executor: "first_party",
      event: "api_key_disconnected",
      outcome: disconnected ? "ok" : "skipped",
    });
    return { connected: false, disconnected };
  },
});

export const loadApiKeyForExecution = internalAction({
  args: { ownerId: v.string(), connectorId: v.string(), action: v.string() },
  returns: v.object({
    apiKey: v.string(),
    provider: v.string(),
    credentialSlot: v.string(),
    generation: v.number(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    apiKey: string;
    provider: string;
    credentialSlot: string;
    generation: number;
  }> => {
    const descriptor = requireReadyApiKeyProvider(args.connectorId);
    const target = getApiKeyActionTarget(descriptor, args.action);
    if (!target) throw new ConnectorError("action_not_found");
    const credential: {
      ownerId: string;
      provider: string;
      credentialSlot: string;
      encryptedKey: string;
      status: string;
      generation: number;
    } | null = await ctx.runQuery(
      internal.connectors.api_keys.vault.getEncryptedApiKeyForExecution,
      args,
    );
    if (!credential) throw new ConnectorError("not_connected");
    if (
      credential.ownerId !== args.ownerId ||
      credential.provider !== descriptor.providerKey ||
      credential.credentialSlot !== target.credentialSlot
    ) {
      throw new ConnectorError("account_mismatch");
    }
    if (credential.status !== "active" || !credential.encryptedKey) {
      throw new ConnectorError("invalid_credential");
    }
    try {
      const apiKey = validateApiKeyCredential(
        await decryptSecret(credential.encryptedKey),
      );
      return {
        apiKey,
        provider: credential.provider,
        credentialSlot: credential.credentialSlot,
        generation: credential.generation,
      };
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("invalid_credential");
    }
  },
});

export const markApiKeyInvalid = internalMutation({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    credentialSlot: v.string(),
    expectedGeneration: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const credentials = await ctx.db
      .query("api_key_credentials")
      .withIndex("by_owner_provider", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", args.provider),
      )
      .collect();
    const credential = credentialForSlot(credentials, args.credentialSlot);
    if (!credential || credential.generation !== args.expectedGeneration) {
      return false;
    }
    await ctx.db.patch(credential._id, {
      encryptedKey: DESTROYED_CREDENTIAL,
      keyVersion: 0,
      status: "invalid",
      generation: credential.generation + 1,
      invalidatedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const markApiKeyUsed = internalMutation({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    credentialSlot: v.string(),
    expectedGeneration: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const credentials = await ctx.db
      .query("api_key_credentials")
      .withIndex("by_owner_provider", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", args.provider),
      )
      .collect();
    const credential = credentialForSlot(credentials, args.credentialSlot);
    if (credential?.generation === args.expectedGeneration) {
      await ctx.db.patch(credential._id, {
        lastUsedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

export const rotateApiKeyCredentialsBatch = internalMutation({
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
      .query("api_key_credentials")
      .withIndex("by_keyVersion", (q) => q.lt("keyVersion", activeKeyVersion))
      .take(batchSize);
    const above = await ctx.db
      .query("api_key_credentials")
      .withIndex("by_keyVersion", (q) => q.gt("keyVersion", activeKeyVersion))
      .take(batchSize);
    const candidates = [...below, ...above]
      .filter((candidate) => Boolean(candidate.encryptedKey))
      .slice(0, batchSize);
    let rotated = 0;
    let skipped = 0;
    let failed = 0;
    for (const candidate of candidates) {
      try {
        const result = await rotateSecretToActiveKey(candidate.encryptedKey);
        if (!result.changed) {
          skipped += 1;
          continue;
        }
        await ctx.db.patch(candidate._id, {
          encryptedKey: result.serialized,
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
