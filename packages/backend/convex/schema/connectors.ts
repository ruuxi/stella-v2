import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * First-party connector / OAuth execution core.
 *
 * These tables sit *beside* the Composio-shaped `integrations_public`,
 * `integration_actions`, and `user_integrations` tables. They never replace
 * them: a single public connector id (e.g. `gmail`) may simultaneously have a
 * Composio session (`user_integrations`) and a first-party OAuth account
 * (`oauth_provider_accounts`). Which executor actually runs is resolved from
 * `connector_rollouts` at call time — see `connectors/routing.ts`.
 *
 * Invariants encoded here:
 *  - Long-lived credentials only ever live in `oauth_credentials` or
 *    `api_key_credentials`, encrypted with the shared versioned AES-256-GCM
 *    key ring (`data/secrets_crypto.ts`).
 *  - No public/query surface returns ciphertext; only internal actions decrypt.
 *  - Provider account identity is a stable native subject (`providerAccountId`),
 *    never email alone. Email/display are mutable presentation metadata.
 *  - Audit rows are metadata-only: strict enums/numbers, never tokens, codes,
 *    state, verifiers, provider bodies, URLs, or user content.
 */
export const connectorsSchema = {
  /**
   * Server-owned API keys. The encrypted envelope is never returned by a
   * public query; lifecycle APIs expose metadata only. One live row exists per
   * owner/provider and replacement overwrites the previous envelope.
   */
  api_key_credentials: defineTable({
    ownerId: v.string(),
    connectorId: v.string(),
    provider: v.string(),
    encryptedKey: v.string(),
    keyVersion: v.number(),
    status: v.union(v.literal("active"), v.literal("invalid")),
    generation: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    invalidatedAt: v.optional(v.number()),
  })
    .index("by_owner_provider", ["ownerId", "provider"])
    .index("by_owner_connector", ["ownerId", "connectorId"])
    .index("by_keyVersion", ["keyVersion"]),

  /**
   * One-time authorization transactions. Only the SHA-256 hash of the random
   * `state` is stored; the raw state exists only transiently in the provider
   * authorization URL. The PKCE verifier is stored encrypted and never leaves
   * the backend. Rows are short-lived and purged hourly.
   */
  oauth_connect_attempts: defineTable({
    ownerId: v.string(),
    provider: v.string(),
    connectorId: v.string(),
    scopeGroupIds: v.array(v.string()),
    stateHash: v.string(),
    encryptedVerifier: v.string(),
    keyVersion: v.number(),
    returnSurface: v.string(),
    // Non-secret registration + client-secret versions recorded so an in-flight
    // attempt survives a rotation that happens between start and callback.
    registrationVersion: v.optional(v.number()),
    clientSecretVersion: v.optional(v.number()),
    // Optional: the specific existing provider account the user intends to
    // extend with an incremental grant. Enforced at commit time.
    providerAccountIdIntent: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("exchanging"),
      v.literal("succeeded"),
      v.literal("denied"),
      v.literal("failed"),
      v.literal("expired"),
    ),
    // Populated only on success; the resolved account row id (as a string).
    resolvedAccountId: v.optional(v.string()),
    // Stable, classified failure reason. Never a raw provider error string.
    errorCode: v.optional(v.string()),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_stateHash", ["stateHash"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_expiresAt", ["expiresAt"]),

  /**
   * Provider account identity + status. No token material lives here.
   * Uniqueness is (ownerId, provider, providerAccountId); an owner may connect
   * multiple accounts for a provider without duplicate provider rows.
   */
  oauth_provider_accounts: defineTable({
    ownerId: v.string(),
    provider: v.string(),
    providerAccountId: v.string(),
    tenantId: v.optional(v.string()),
    // Presentation-only, owner-visible metadata. Mutable.
    displayLabel: v.optional(v.string()),
    displayEmail: v.optional(v.string()),
    grantedScopes: v.array(v.string()),
    status: v.union(
      v.literal("active"),
      v.literal("reauth_required"),
      v.literal("revoking"),
      v.literal("revoked"),
      v.literal("error"),
    ),
    registrationVersion: v.optional(v.number()),
    lastValidatedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_provider_and_updatedAt", [
      "ownerId",
      "provider",
      "updatedAt",
    ])
    .index("by_ownerId_and_provider_and_providerAccountId", [
      "ownerId",
      "provider",
      "providerAccountId",
    ])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"]),

  /**
   * Dedicated encrypted credential vault, one row per provider account.
   * `encryptedTokenSet` is the JSON envelope produced by
   * `data/secrets_crypto.ts#encryptSecret`. `generation` + `refreshLeaseId`
   * implement optimistic single-flight refresh so a late refresh cannot
   * overwrite a newer reconnect/revocation.
   */
  oauth_credentials: defineTable({
    ownerId: v.string(),
    accountId: v.id("oauth_provider_accounts"),
    encryptedTokenSet: v.string(),
    keyVersion: v.number(),
    accessTokenExpiresAt: v.optional(v.number()),
    generation: v.number(),
    status: v.union(
      v.literal("active"),
      v.literal("reauth_required"),
      v.literal("revoked"),
    ),
    refreshLeaseId: v.optional(v.string()),
    refreshLeaseExpiresAt: v.optional(v.number()),
    lastRefreshedAt: v.optional(v.number()),
    lastRefreshErrorCode: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_accountId", ["accountId"])
    .index("by_ownerId", ["ownerId"])
    .index("by_keyVersion", ["keyVersion"]),

  /**
   * Binds a canonical connector id to a provider account (default account per
   * connector) plus the scope groups that connector requires. Replaces the
   * provider-only readiness assumption for first-party connectors. Gmail,
   * Drive, Docs, Sheets, Calendar and Tasks can each bind to the same shared
   * Google account while requiring different scope groups.
   */
  connector_account_bindings: defineTable({
    ownerId: v.string(),
    connectorId: v.string(),
    provider: v.string(),
    accountId: v.id("oauth_provider_accounts"),
    enabled: v.boolean(),
    requiredScopeGroups: v.array(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_connectorId", ["ownerId", "connectorId"])
    .index("by_ownerId_and_accountId", ["ownerId", "accountId"]),

  /**
   * Per-connector rollout record. Admin-only writes. A global env kill switch
   * (`STELLA_FIRST_PARTY_CONNECTOR_EXECUTION_ENABLED`) overrides this to fail
   * closed. Absence of a row means `composio_only` (current behavior).
   */
  connector_rollouts: defineTable({
    connectorId: v.string(),
    mode: v.union(
      v.literal("composio_only"),
      v.literal("shadow"),
      v.literal("first_party_canary"),
      v.literal("first_party_preferred"),
      v.literal("first_party_only"),
      v.literal("disabled"),
    ),
    canaryPercent: v.optional(v.number()),
    saltVersion: v.optional(v.number()),
    allowedFallbacks: v.optional(v.array(v.string())),
    minimumClientVersion: v.optional(v.string()),
    routeVersion: v.number(),
    updatedAt: v.number(),
  }).index("by_connectorId", ["connectorId"]),

  /**
   * Metadata-only connector audit trail. A strict validator (no arbitrary JSON
   * payload field) keeps tokens/codes/state/verifiers/provider bodies and user
   * content out by construction. Rows carry `expiresAt` for bounded retention.
   */
  connector_audit_events: defineTable({
    ownerId: v.optional(v.string()),
    accountId: v.optional(v.string()),
    connectorId: v.optional(v.string()),
    action: v.optional(v.string()),
    provider: v.optional(v.string()),
    executor: v.optional(v.string()),
    event: v.string(),
    outcome: v.string(),
    requestId: v.optional(v.string()),
    routeVersion: v.optional(v.number()),
    schemaVersion: v.optional(v.number()),
    scopeGroups: v.optional(v.array(v.string())),
    latencyMs: v.optional(v.number()),
    providerStatusClass: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_requestId", ["requestId"])
    .index("by_connectorId_and_createdAt", ["connectorId", "createdAt"])
    .index("by_expiresAt", ["expiresAt"]),
};
