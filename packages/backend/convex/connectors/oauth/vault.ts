import { internalMutation, internalQuery } from "../../_generated/server";
import { v } from "convex/values";
import {
  decryptSecret,
  encryptSecret,
  getActiveSecretKeyVersion,
  rotateSecretToActiveKey,
} from "../../data/secrets_crypto";
import {
  parseTokenSet,
  serializeTokenSet,
  unionScopes,
  type TokenSet,
} from "./token_set";
import { ConnectorError } from "../errors";
import { normalizeSnowflakeAccountOrigin } from "../snowflake";
import { REFRESH_LEASE_MS } from "./refresh_policy";

/**
 * Encrypted credential custody for provider accounts. Reuses the shared
 * versioned AES-256-GCM envelope key ring (`data/secrets_crypto.ts`). Only the
 * functions in this module and the refresh/callback actions decrypt token
 * material; no public/query surface returns ciphertext or plaintext tokens.
 *
 * Concurrency is controlled with an optimistic `generation` counter plus a
 * `refreshLeaseId`: a late refresh whose generation/lease no longer match a
 * newer reconnect or revocation is rejected at commit time.
 */

const CREDENTIAL_TOMBSTONE = "";

const incomingTokenValidator = v.object({
  accessToken: v.string(),
  refreshToken: v.optional(v.string()),
  tokenType: v.optional(v.string()),
  accessTokenExpiresAt: v.optional(v.number()),
  scopes: v.array(v.string()),
  resourceOrigin: v.optional(v.string()),
});

const readExistingTokenSet = async (
  encryptedTokenSet: string,
): Promise<TokenSet | null> => {
  if (!encryptedTokenSet || encryptedTokenSet === CREDENTIAL_TOMBSTONE) {
    return null;
  }
  try {
    return parseTokenSet(await decryptSecret(encryptedTokenSet));
  } catch {
    return null;
  }
};

/**
 * Transactionally upsert the provider account identity + encrypted credential
 * after a successful authorization-code exchange or incremental grant.
 *
 * - Scopes are a set union onto the account's granted set.
 * - A response that omits a refresh token preserves the existing one.
 * - `providerAccountIdIntent` enforces "extend this exact account" — a mismatch
 *   is rejected rather than silently creating/binding a different account.
 */
export const commitProviderAccountTokens = internalMutation({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    providerAccountId: v.string(),
    providerAccountIdIntent: v.optional(v.string()),
    tenantId: v.optional(v.string()),
    accountOrigin: v.optional(v.string()),
    displayLabel: v.optional(v.string()),
    displayEmail: v.optional(v.string()),
    registrationVersion: v.optional(v.number()),
    incoming: incomingTokenValidator,
  },
  returns: v.object({
    accountId: v.id("oauth_provider_accounts"),
    grantedScopes: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const accountOrigin =
      args.provider === "snowflake"
        ? normalizeSnowflakeAccountOrigin(args.accountOrigin)
        : args.accountOrigin;
    if (args.provider === "snowflake") {
      if (
        normalizeSnowflakeAccountOrigin(args.incoming.resourceOrigin) !==
        accountOrigin
      ) {
        throw new ConnectorError("account_mismatch");
      }
    }
    if (
      args.providerAccountIdIntent &&
      args.providerAccountIdIntent !== args.providerAccountId
    ) {
      throw new ConnectorError("account_mismatch");
    }
    const now = Date.now();
    const existingAccount = await ctx.db
      .query("oauth_provider_accounts")
      .withIndex("by_ownerId_and_provider_and_providerAccountId", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("provider", args.provider)
          .eq("providerAccountId", args.providerAccountId),
      )
      .unique();

    if (
      existingAccount?.accountOrigin &&
      accountOrigin !== existingAccount.accountOrigin
    ) {
      throw new ConnectorError("account_mismatch");
    }

    const grantedScopes = unionScopes(
      existingAccount?.grantedScopes ?? [],
      args.incoming.scopes,
    );

    let accountId = existingAccount?._id;
    if (existingAccount) {
      await ctx.db.patch(existingAccount._id, {
        tenantId: args.tenantId ?? existingAccount.tenantId,
        accountOrigin: accountOrigin ?? existingAccount.accountOrigin,
        displayLabel: args.displayLabel ?? existingAccount.displayLabel,
        displayEmail: args.displayEmail ?? existingAccount.displayEmail,
        grantedScopes,
        status: "active",
        registrationVersion:
          args.registrationVersion ?? existingAccount.registrationVersion,
        lastValidatedAt: now,
        revokedAt: undefined,
        updatedAt: now,
      });
    } else {
      accountId = await ctx.db.insert("oauth_provider_accounts", {
        ownerId: args.ownerId,
        provider: args.provider,
        providerAccountId: args.providerAccountId,
        tenantId: args.tenantId,
        accountOrigin,
        displayLabel: args.displayLabel,
        displayEmail: args.displayEmail,
        grantedScopes,
        status: "active",
        registrationVersion: args.registrationVersion,
        lastValidatedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (!accountId) throw new ConnectorError("internal_error");

    const existingCredential = await ctx.db
      .query("oauth_credentials")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .unique();
    const previousTokenSet = existingCredential
      ? await readExistingTokenSet(existingCredential.encryptedTokenSet)
      : null;

    const tokenSet: TokenSet = {
      accessToken: args.incoming.accessToken,
      // Preserve an omitted refresh token from the prior grant.
      refreshToken:
        args.incoming.refreshToken ?? previousTokenSet?.refreshToken,
      tokenType:
        args.incoming.tokenType ?? previousTokenSet?.tokenType ?? "Bearer",
      accessTokenExpiresAt: args.incoming.accessTokenExpiresAt,
      scope: grantedScopes.join(" ") || undefined,
      resourceOrigin:
        args.incoming.resourceOrigin ?? previousTokenSet?.resourceOrigin,
    };
    const encrypted = await encryptSecret(serializeTokenSet(tokenSet));
    const encryptedTokenSet = JSON.stringify(encrypted);

    if (existingCredential) {
      await ctx.db.patch(existingCredential._id, {
        encryptedTokenSet,
        keyVersion: encrypted.keyVersion,
        accessTokenExpiresAt: args.incoming.accessTokenExpiresAt,
        generation: existingCredential.generation + 1,
        status: "active",
        refreshLeaseId: undefined,
        refreshLeaseExpiresAt: undefined,
        lastRefreshErrorCode: undefined,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("oauth_credentials", {
        ownerId: args.ownerId,
        accountId,
        encryptedTokenSet,
        keyVersion: encrypted.keyVersion,
        accessTokenExpiresAt: args.incoming.accessTokenExpiresAt,
        generation: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    }

    return { accountId, grantedScopes };
  },
});

/**
 * Internal-only read that returns the encrypted token set for a refresh
 * attempt. The caller (a refresh action) decrypts in memory, calls the provider
 * token endpoint, then commits under the same generation/lease.
 */
export const getCredentialForRefresh = internalQuery({
  args: { accountId: v.id("oauth_provider_accounts") },
  returns: v.union(
    v.null(),
    v.object({
      ownerId: v.string(),
      provider: v.string(),
      providerAccountId: v.string(),
      accountOrigin: v.optional(v.string()),
      registrationVersion: v.optional(v.number()),
      grantedScopes: v.array(v.string()),
      accountStatus: v.string(),
      encryptedTokenSet: v.string(),
      keyVersion: v.number(),
      generation: v.number(),
      accessTokenExpiresAt: v.optional(v.number()),
      credentialStatus: v.string(),
      refreshLeaseId: v.optional(v.string()),
      refreshLeaseExpiresAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return null;
    const credential = await ctx.db
      .query("oauth_credentials")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .unique();
    if (!credential) return null;
    return {
      ownerId: account.ownerId,
      provider: account.provider,
      providerAccountId: account.providerAccountId,
      accountOrigin: account.accountOrigin,
      registrationVersion: account.registrationVersion,
      grantedScopes: account.grantedScopes,
      accountStatus: account.status,
      encryptedTokenSet: credential.encryptedTokenSet,
      keyVersion: credential.keyVersion,
      generation: credential.generation,
      accessTokenExpiresAt: credential.accessTokenExpiresAt,
      credentialStatus: credential.status,
      refreshLeaseId: credential.refreshLeaseId,
      refreshLeaseExpiresAt: credential.refreshLeaseExpiresAt,
    };
  },
});

export const claimRefreshLease = internalMutation({
  args: {
    accountId: v.id("oauth_provider_accounts"),
    expectedGeneration: v.number(),
    leaseId: v.string(),
    leaseTtlMs: v.optional(v.number()),
  },
  returns: v.object({
    ok: v.boolean(),
    reason: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const credential = await ctx.db
      .query("oauth_credentials")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .unique();
    if (!credential) return { ok: false, reason: "not_found" };
    if (credential.status !== "active") {
      return { ok: false, reason: "inactive" };
    }
    if (credential.generation !== args.expectedGeneration) {
      return { ok: false, reason: "generation_changed" };
    }
    const leaseActive =
      credential.refreshLeaseId &&
      typeof credential.refreshLeaseExpiresAt === "number" &&
      credential.refreshLeaseExpiresAt > now &&
      credential.refreshLeaseId !== args.leaseId;
    if (leaseActive) return { ok: false, reason: "busy" };
    const ttl = Math.min(
      Math.max(args.leaseTtlMs ?? REFRESH_LEASE_MS, 1000),
      120_000,
    );
    await ctx.db.patch(credential._id, {
      refreshLeaseId: args.leaseId,
      refreshLeaseExpiresAt: now + ttl,
      updatedAt: now,
    });
    return { ok: true };
  },
});

export const commitRefreshedTokens = internalMutation({
  args: {
    accountId: v.id("oauth_provider_accounts"),
    leaseId: v.string(),
    expectedGeneration: v.number(),
    incoming: incomingTokenValidator,
  },
  returns: v.object({ ok: v.boolean(), reason: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const credential = await ctx.db
      .query("oauth_credentials")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .unique();
    if (!credential) return { ok: false, reason: "not_found" };
    // A newer reconnect/revocation bumped the generation, or another worker
    // owns the lease: discard this late refresh instead of clobbering it.
    if (credential.generation !== args.expectedGeneration) {
      return { ok: false, reason: "generation_changed" };
    }
    if (credential.refreshLeaseId !== args.leaseId) {
      return { ok: false, reason: "lease_lost" };
    }
    const account = await ctx.db.get(args.accountId);
    if (account?.provider === "snowflake") {
      const accountOrigin = normalizeSnowflakeAccountOrigin(
        account.accountOrigin,
      );
      if (
        normalizeSnowflakeAccountOrigin(args.incoming.resourceOrigin) !==
        accountOrigin
      ) {
        throw new ConnectorError("account_mismatch");
      }
    }
    const previousTokenSet = await readExistingTokenSet(
      credential.encryptedTokenSet,
    );
    const grantedScopes = unionScopes(
      account?.grantedScopes ?? [],
      args.incoming.scopes,
    );
    const tokenSet: TokenSet = {
      accessToken: args.incoming.accessToken,
      refreshToken:
        args.incoming.refreshToken ?? previousTokenSet?.refreshToken,
      tokenType:
        args.incoming.tokenType ?? previousTokenSet?.tokenType ?? "Bearer",
      accessTokenExpiresAt: args.incoming.accessTokenExpiresAt,
      scope: grantedScopes.join(" ") || undefined,
      resourceOrigin:
        args.incoming.resourceOrigin ?? previousTokenSet?.resourceOrigin,
    };
    const encrypted = await encryptSecret(serializeTokenSet(tokenSet));
    await ctx.db.patch(credential._id, {
      encryptedTokenSet: JSON.stringify(encrypted),
      keyVersion: encrypted.keyVersion,
      accessTokenExpiresAt: args.incoming.accessTokenExpiresAt,
      generation: credential.generation + 1,
      status: "active",
      refreshLeaseId: undefined,
      refreshLeaseExpiresAt: undefined,
      lastRefreshedAt: now,
      lastRefreshErrorCode: undefined,
      updatedAt: now,
    });
    if (account) {
      await ctx.db.patch(account._id, {
        grantedScopes,
        status: "active",
        lastValidatedAt: now,
        updatedAt: now,
      });
    }
    return { ok: true };
  },
});

export const releaseRefreshLease = internalMutation({
  args: {
    accountId: v.id("oauth_provider_accounts"),
    leaseId: v.string(),
    errorCode: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const credential = await ctx.db
      .query("oauth_credentials")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .unique();
    if (!credential || credential.refreshLeaseId !== args.leaseId) return null;
    await ctx.db.patch(credential._id, {
      refreshLeaseId: undefined,
      refreshLeaseExpiresAt: undefined,
      lastRefreshErrorCode: args.errorCode,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * invalid_grant / missing refresh token: destroy ciphertext only if the
 * credential generation and, when present, active lease still belong to the
 * caller. A stale refresh must never tombstone a successor's rotated token.
 */
export const markAccountReauthRequired = internalMutation({
  args: {
    accountId: v.id("oauth_provider_accounts"),
    expectedGeneration: v.number(),
    expectedLeaseId: v.optional(v.string()),
  },
  returns: v.object({ ok: v.boolean(), reason: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const credential = await ctx.db
      .query("oauth_credentials")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .unique();
    if (!credential) return { ok: false, reason: "not_found" };
    if (credential.generation !== args.expectedGeneration) {
      return { ok: false, reason: "generation_changed" };
    }
    if (args.expectedLeaseId !== undefined) {
      if (credential.refreshLeaseId !== args.expectedLeaseId) {
        return { ok: false, reason: "lease_lost" };
      }
      if (
        typeof credential.refreshLeaseExpiresAt !== "number" ||
        credential.refreshLeaseExpiresAt <= now
      ) {
        return { ok: false, reason: "lease_expired" };
      }
    }

    const account = await ctx.db.get(args.accountId);
    await ctx.db.patch(credential._id, {
      encryptedTokenSet: CREDENTIAL_TOMBSTONE,
      keyVersion: 0,
      accessTokenExpiresAt: undefined,
      generation: credential.generation + 1,
      status: "reauth_required",
      refreshLeaseId: undefined,
      refreshLeaseExpiresAt: undefined,
      updatedAt: now,
    });
    if (account) {
      await ctx.db.patch(account._id, {
        status: "reauth_required",
        updatedAt: now,
      });
    }
    return { ok: true };
  },
});

/**
 * Key-rotation batch across `oauth_credentials`, mirroring
 * `data/secrets_rotation.ts` for the generic secrets table. Re-wraps ciphertext
 * onto the active master key without contacting any provider. Reports counts
 * only; never logs row ciphertext.
 */
export const rotateConnectorCredentialsBatch = internalMutation({
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
    const now = Date.now();
    const below = await ctx.db
      .query("oauth_credentials")
      .withIndex("by_keyVersion", (q) => q.lt("keyVersion", activeKeyVersion))
      .take(batchSize);
    const above = await ctx.db
      .query("oauth_credentials")
      .withIndex("by_keyVersion", (q) => q.gt("keyVersion", activeKeyVersion))
      .take(batchSize);
    const candidates = [...below, ...above].slice(0, batchSize);

    let rotated = 0;
    let skipped = 0;
    let failed = 0;
    for (const candidate of candidates) {
      if (
        !candidate.encryptedTokenSet ||
        candidate.encryptedTokenSet === CREDENTIAL_TOMBSTONE
      ) {
        skipped += 1;
        continue;
      }
      try {
        const result = await rotateSecretToActiveKey(
          candidate.encryptedTokenSet,
        );
        if (!result.changed) {
          skipped += 1;
          continue;
        }
        await ctx.db.patch(candidate._id, {
          encryptedTokenSet: result.serialized,
          keyVersion: result.keyVersion,
          updatedAt: now,
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
