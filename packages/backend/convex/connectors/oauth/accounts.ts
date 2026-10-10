import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../../_generated/server";
import { internal } from "../../_generated/api";
import { v } from "convex/values";
import { requireUserId } from "../../auth";
import { decryptSecret } from "../../data/secrets_crypto";
import { parseTokenSet } from "./token_set";
import {
  getProviderManifest,
  grantedScopesSatisfy,
} from "./providers";

/**
 * Provider account inventory, scope-aware connection status, connector bindings
 * and disconnect/revoke. Status is derived from GRANTED SCOPES, never from token
 * presence, so a granular Google grant never makes unrelated Google connectors
 * look connected.
 */

const accountSafeValidator = v.object({
  accountId: v.id("oauth_provider_accounts"),
  provider: v.string(),
  providerAccountId: v.string(),
  displayLabel: v.optional(v.string()),
  displayEmail: v.optional(v.string()),
  status: v.string(),
  grantedScopeCount: v.number(),
  updatedAt: v.number(),
});

export const listConnectorAccounts = query({
  args: {},
  returns: v.array(accountSafeValidator),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const rows = await ctx.db
      .query("oauth_provider_accounts")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(200);
    return rows
      .filter((row) => row.status !== "revoked")
      .map((row) => ({
        accountId: row._id,
        provider: row.provider,
        providerAccountId: row.providerAccountId,
        displayLabel: row.displayLabel,
        displayEmail: row.displayEmail,
        status: row.status,
        grantedScopeCount: row.grantedScopes.length,
        updatedAt: row.updatedAt,
      }));
  },
});

/**
 * Scope-aware status for a single connector. Returns `connected: true` only
 * when a bound account is active AND its granted scopes are a superset of every
 * required scope group.
 */
export const getConnectorConnectionStatus = query({
  args: { connectorId: v.string() },
  returns: v.object({
    connected: v.boolean(),
    status: v.string(),
    provider: v.optional(v.string()),
    accountId: v.optional(v.id("oauth_provider_accounts")),
    displayEmail: v.optional(v.string()),
    missingScopeGroups: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const connectorId = args.connectorId.trim().toLowerCase();
    const binding = await ctx.db
      .query("connector_account_bindings")
      .withIndex("by_ownerId_and_connectorId", (q) =>
        q.eq("ownerId", ownerId).eq("connectorId", connectorId),
      )
      .unique();
    if (!binding || !binding.enabled) {
      return { connected: false, status: "not_connected", missingScopeGroups: [] };
    }
    const account = await ctx.db.get(binding.accountId);
    if (!account || account.status === "revoked") {
      return { connected: false, status: "not_connected", missingScopeGroups: [] };
    }
    if (account.status !== "active") {
      return {
        connected: false,
        status: account.status,
        provider: account.provider,
        accountId: account._id,
        displayEmail: account.displayEmail,
        missingScopeGroups: [],
      };
    }
    const manifest = getProviderManifest(account.provider);
    const missingScopeGroups: string[] = [];
    if (manifest) {
      for (const groupId of binding.requiredScopeGroups) {
        const group = manifest.scopeGroups[groupId];
        if (!group) {
          missingScopeGroups.push(groupId);
          continue;
        }
        if (!grantedScopesSatisfy(account.grantedScopes, group.scopes)) {
          missingScopeGroups.push(groupId);
        }
      }
    }
    const connected = missingScopeGroups.length === 0;
    return {
      connected,
      status: connected ? "connected" : "missing_scope",
      provider: account.provider,
      accountId: account._id,
      displayEmail: account.displayEmail,
      missingScopeGroups,
    };
  },
});

/**
 * Internal readiness check used by the execution router: does the owner have a
 * bound, active account whose granted scopes satisfy the connector's required
 * groups?
 */
export const getConnectorReadiness = internalQuery({
  args: { ownerId: v.string(), connectorId: v.string() },
  returns: v.object({
    ready: v.boolean(),
    accountId: v.optional(v.id("oauth_provider_accounts")),
    provider: v.optional(v.string()),
    requiredScopeGroups: v.array(v.string()),
    missingScopeGroups: v.array(v.string()),
    accountStatus: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const connectorId = args.connectorId.trim().toLowerCase();
    const binding = await ctx.db
      .query("connector_account_bindings")
      .withIndex("by_ownerId_and_connectorId", (q) =>
        q.eq("ownerId", args.ownerId).eq("connectorId", connectorId),
      )
      .unique();
    if (!binding || !binding.enabled) {
      return { ready: false, requiredScopeGroups: [], missingScopeGroups: [] };
    }
    const account = await ctx.db.get(binding.accountId);
    if (!account) {
      return {
        ready: false,
        requiredScopeGroups: binding.requiredScopeGroups,
        missingScopeGroups: binding.requiredScopeGroups,
      };
    }
    const manifest = getProviderManifest(account.provider);
    const missingScopeGroups: string[] = [];
    if (manifest) {
      for (const groupId of binding.requiredScopeGroups) {
        const group = manifest.scopeGroups[groupId];
        if (!group || !grantedScopesSatisfy(account.grantedScopes, group.scopes)) {
          missingScopeGroups.push(groupId);
        }
      }
    } else {
      missingScopeGroups.push(...binding.requiredScopeGroups);
    }
    return {
      ready: account.status === "active" && missingScopeGroups.length === 0,
      accountId: account._id,
      provider: account.provider,
      requiredScopeGroups: binding.requiredScopeGroups,
      missingScopeGroups,
      accountStatus: account.status,
    };
  },
});

/** Internal helper: verify an account belongs to an owner and return safe fields. */
export const getOwnedAccount = internalQuery({
  args: { ownerId: v.string(), accountId: v.id("oauth_provider_accounts") },
  returns: v.union(
    v.null(),
    v.object({
      accountId: v.id("oauth_provider_accounts"),
      provider: v.string(),
      providerAccountId: v.string(),
      status: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account || account.ownerId !== args.ownerId) return null;
    return {
      accountId: account._id,
      provider: account.provider,
      providerAccountId: account.providerAccountId,
      status: account.status,
    };
  },
});

export const setConnectorBinding = internalMutation({
  args: {
    ownerId: v.string(),
    connectorId: v.string(),
    provider: v.string(),
    accountId: v.id("oauth_provider_accounts"),
    requiredScopeGroups: v.array(v.string()),
    enabled: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const connectorId = args.connectorId.trim().toLowerCase();
    const now = Date.now();
    const existing = await ctx.db
      .query("connector_account_bindings")
      .withIndex("by_ownerId_and_connectorId", (q) =>
        q.eq("ownerId", args.ownerId).eq("connectorId", connectorId),
      )
      .unique();
    const patch = {
      ownerId: args.ownerId,
      connectorId,
      provider: args.provider,
      accountId: args.accountId,
      requiredScopeGroups: args.requiredScopeGroups,
      enabled: args.enabled ?? true,
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("connector_account_bindings", {
        ...patch,
        createdAt: now,
      });
    }
    return null;
  },
});

/** Authenticated: choose the default account for a connector. */
export const bindConnectorAccount = mutation({
  args: {
    connectorId: v.string(),
    accountId: v.id("oauth_provider_accounts"),
    requiredScopeGroups: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const account = await ctx.db.get(args.accountId);
    if (!account || account.ownerId !== ownerId) {
      throw new Error("Account not found");
    }
    const connectorId = args.connectorId.trim().toLowerCase();
    const now = Date.now();
    const existing = await ctx.db
      .query("connector_account_bindings")
      .withIndex("by_ownerId_and_connectorId", (q) =>
        q.eq("ownerId", ownerId).eq("connectorId", connectorId),
      )
      .unique();
    const patch = {
      ownerId,
      connectorId,
      provider: account.provider,
      accountId: args.accountId,
      requiredScopeGroups: args.requiredScopeGroups,
      enabled: true,
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("connector_account_bindings", {
        ...patch,
        createdAt: now,
      });
    }
    return null;
  },
});

/** Mark an account `revoking` and block new runs. */
export const beginAccountRevocation = internalMutation({
  args: { accountId: v.id("oauth_provider_accounts") },
  returns: v.union(
    v.null(),
    v.object({ encryptedTokenSet: v.string(), provider: v.string() }),
  ),
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return null;
    await ctx.db.patch(account._id, { status: "revoking", updatedAt: Date.now() });
    const credential = await ctx.db
      .query("oauth_credentials")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .unique();
    return {
      encryptedTokenSet: credential?.encryptedTokenSet ?? "",
      provider: account.provider,
    };
  },
});

/** Destroy ciphertext, mark account revoked, and remove its connector bindings. */
export const finalizeAccountRevocation = internalMutation({
  args: {
    accountId: v.id("oauth_provider_accounts"),
    revocationErrorCode: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const account = await ctx.db.get(args.accountId);
    if (!account) return null;
    await ctx.db.patch(account._id, {
      status: "revoked",
      revokedAt: now,
      grantedScopes: [],
      updatedAt: now,
    });
    const credential = await ctx.db
      .query("oauth_credentials")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .unique();
    if (credential) {
      await ctx.db.patch(credential._id, {
        encryptedTokenSet: "",
        keyVersion: 0,
        accessTokenExpiresAt: undefined,
        generation: credential.generation + 1,
        status: "revoked",
        refreshLeaseId: undefined,
        refreshLeaseExpiresAt: undefined,
        lastRefreshErrorCode: args.revocationErrorCode,
        updatedAt: now,
      });
    }
    const bindings = await ctx.db
      .query("connector_account_bindings")
      .withIndex("by_ownerId_and_accountId", (q) =>
        q.eq("ownerId", account.ownerId).eq("accountId", args.accountId),
      )
      .take(200);
    await Promise.all(bindings.map((binding) => ctx.db.delete(binding._id)));
    return null;
  },
});

/**
 * Authenticated disconnect + provider revocation. Sets the account `revoking`,
 * best-effort calls the provider revocation endpoint, then destroys ciphertext
 * and marks it `revoked`. Revocation-endpoint failure is recorded but never
 * leaves usable credentials on file.
 */
export const disconnectConnectorAccount = action({
  args: { accountId: v.id("oauth_provider_accounts") },
  returns: v.object({ revoked: v.boolean(), providerRevoked: v.boolean() }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const owned = await ctx.runQuery(
      internal.connectors.oauth.accounts.getOwnedAccount,
      { ownerId, accountId: args.accountId },
    );
    if (!owned) throw new Error("Account not found");

    const begun = await ctx.runMutation(
      internal.connectors.oauth.accounts.beginAccountRevocation,
      { accountId: args.accountId },
    );

    let providerRevoked = false;
    let revocationErrorCode: string | undefined;
    const manifest = getProviderManifest(owned.provider);
    if (manifest?.revocationEndpoint && begun && begun.encryptedTokenSet) {
      try {
        const tokenSet = parseTokenSet(await decryptSecret(begun.encryptedTokenSet));
        const token = tokenSet.refreshToken ?? tokenSet.accessToken;
        const response = await fetch(manifest.revocationEndpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }).toString(),
        });
        providerRevoked = response.ok;
        if (!response.ok) revocationErrorCode = "provider_revocation_failed";
      } catch {
        revocationErrorCode = "provider_revocation_failed";
      }
    }

    await ctx.runMutation(
      internal.connectors.oauth.accounts.finalizeAccountRevocation,
      { accountId: args.accountId, revocationErrorCode },
    );
    await ctx.runMutation(
      internal.connectors.audit.recordConnectorAuditEvent,
      {
        ownerId,
        accountId: String(args.accountId),
        provider: owned.provider,
        event: "account_revoked",
        outcome: revocationErrorCode ? "error" : "ok",
        errorCode: revocationErrorCode,
      },
    );
    return { revoked: true, providerRevoked };
  },
});
