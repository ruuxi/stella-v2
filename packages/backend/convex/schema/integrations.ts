import { defineTable } from "convex/server";
import { v } from "convex/values";
import { jsonObjectValidator } from "../shared_validators";

export const integrationsSchema = {
  integrations_public: defineTable({
    id: v.string(),
    name: v.optional(v.string()),
    provider: v.string(),
    category: v.optional(v.string()),
    auth: v.optional(v.array(v.string())),
    catalogToolCount: v.optional(v.number()),
    // Actual number of canonical, schema-bearing actions published into the
    // child table below. Optional for migration safety: pre-existing catalog
    // rows remain valid, but are treated as non-executable until republished.
    actionCount: v.optional(v.number()),
    description: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
    iconUrl: v.optional(v.string()),
    connector: v.optional(jsonObjectValidator),
    enabled: v.boolean(),
    usagePolicy: v.string(),
    updatedAt: v.number(),
  })
    .index("by_integrationId", ["id"])
    // Gives Store catalog clients a bounded, deterministic recency ordering.
    .index("by_updatedAt", ["updatedAt"]),

  /**
   * Canonical Composio actions are intentionally stored one document per
   * action. Large toolkits contain hundreds of schemas and can approach the
   * 1 MiB Convex document limit if embedded in `integrations_public`.
   *
   * `inputSchemaJson` preserves arbitrarily deep JSON Schema documents without
   * weakening the app-wide bounded JSON validator or using `v.any()`.
   */
  integration_actions: defineTable({
    integrationId: v.string(),
    name: v.string(),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    /**
     * Provider-authored behavioral annotations captured at catalog publish
     * time. Optional is migration-safe and intentionally means "unknown".
     * Code execution admits only an explicitly read-only, non-destructive
     * action; it never guesses from the action slug or prose.
     */
    annotations: v.optional(
      v.object({
        readOnlyHint: v.boolean(),
        destructiveHint: v.boolean(),
        idempotentHint: v.boolean(),
        source: v.literal("composio_tool_tags"),
      }),
    ),
    /**
     * Stella's independently reviewed Code admission policy. Provider hints
     * above are useful evidence, but are never sufficient authority on their
     * own. Missing policy is deliberately direct-only.
     */
    codeModePolicy: v.optional(
      v.object({
        effect: v.literal("read"),
        requiresApproval: v.literal(false),
        policyVersion: v.string(),
        /** Exact dated Composio toolkit contract reviewed by Stella. */
        toolkitVersion: v.string(),
        /** Stella-owned, stricter schema independently reviewed for Code. */
        reviewedInputSchemaJson: v.string(),
        source: v.literal("stella_admin"),
      }),
    ),
    /**
     * Denormalized only by the canonical publisher. Queries use this field to
     * avoid taking an arbitrary prefix before applying the dual safety policy;
     * every describe/call path still revalidates the underlying annotations and
     * policy, so this bit is never authority by itself.
     */
    codeModeEligible: v.optional(v.boolean()),
    searchText: v.string(),
    inputSchemaJson: v.string(),
    updatedAt: v.number(),
  })
    .index("by_integrationId_and_name", ["integrationId", "name"])
    .index("by_integrationId_codeModeEligible_name", [
      "integrationId",
      "codeModeEligible",
      "name",
    ])
    .searchIndex("search_searchText", {
      searchField: "searchText",
      filterFields: ["integrationId", "codeModeEligible"],
    }),

  user_integrations: defineTable({
    ownerId: v.string(),
    provider: v.string(),
    mode: v.string(),
    externalId: v.optional(v.string()),
    config: jsonObjectValidator,
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_ownerId_and_provider", ["ownerId", "provider"])
    .index("by_ownerId_mode_updatedAt", ["ownerId", "mode", "updatedAt"]),

  /**
   * Durable authority for Composio session creation. The provider does not
   * expose an idempotency key or a session-list/reconciliation API, so a POST
   * that loses its response must remain explicit lifecycle debt instead of
   * being retried and silently creating a second long-lived session.
   */
  composio_session_provisioning_attempts: defineTable({
    ownerId: v.string(),
    ownerGeneration: v.string(),
    integrationId: v.string(),
    toolkit: v.string(),
    composioUserId: v.string(),
    attemptId: v.string(),
    leaseId: v.string(),
    state: v.union(
      v.literal("reserved"),
      v.literal("dispatching"),
      v.literal("outcome_unknown"),
      v.literal("locator_recorded"),
      v.literal("cleanup_pending"),
    ),
    sessionId: v.optional(v.string()),
    providerDeadlineAt: v.number(),
    quiescentAfterAt: v.number(),
    cleanupJobId: v.optional(v.id("_scheduled_functions")),
    cleanupAttempts: v.number(),
    nextCleanupAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_attemptId", ["attemptId"])
    .index("by_ownerId_and_integrationId", ["ownerId", "integrationId"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_state_and_nextCleanupAt", ["state", "nextCleanupAt"]),

  /**
   * Immutable operator evidence for resolving a provider create whose response
   * was lost. This survives deletion of the transient attempt so an unknown
   * outcome can only be retired by a recovered exact locator or documented
   * provider confirmation that no session was created.
   */
  composio_session_provisioning_resolutions: defineTable({
    ownerId: v.string(),
    ownerGeneration: v.string(),
    integrationId: v.string(),
    toolkit: v.string(),
    /** Domain-separated hashes retain exact audit equality without owner PII. */
    composioUserIdHash: v.string(),
    attemptId: v.string(),
    leaseId: v.string(),
    resolution: v.union(
      v.literal("recovered_session"),
      v.literal("provider_confirmed_not_created"),
    ),
    /** A provider locator is never retained in the completed audit row. */
    sessionIdHash: v.optional(v.string()),
    resolvedByHash: v.string(),
    evidenceHash: v.string(),
    resolvedAt: v.number(),
    cleanupCompletedAt: v.optional(v.number()),
  })
    .index("by_attemptId", ["attemptId"])
    .index("by_ownerId_and_resolvedAt", ["ownerId", "resolvedAt"]),

  /**
   * Durable owner-generation receipts for connected-tool provider calls. Code
   * uses stable exact-replay identities for reviewed read-only actions; native
   * direct dispatch also uses this table as a non-replayable physical lease so
   * reset/delete/migration cannot revoke a session while a provider action is
   * still live.
   */
  cloud_integration_call_receipts: defineTable({
    ownerId: v.string(),
    ownerGeneration: v.string(),
    requestId: v.string(),
    fingerprint: v.string(),
    toolName: v.string(),
    revision: v.string(),
    state: v.union(
      v.literal("dispatching"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("unknown"),
    ),
    leaseId: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    resultJson: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    attempts: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_generation_request", [
      "ownerId",
      "ownerGeneration",
      "requestId",
    ])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_ownerId_state_leaseExpiresAt", [
      "ownerId",
      "state",
      "leaseExpiresAt",
    ])
    .index("by_state_and_leaseExpiresAt", ["state", "leaseExpiresAt"]),

  connector_turn_payloads: defineTable({
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    requestId: v.string(),
    targetDeviceId: v.string(),
    payload: jsonObjectValidator,
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_requestId", ["requestId"])
    .index("by_conversationId", ["conversationId"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_expiresAt", ["expiresAt"]),

  x_oauth_states: defineTable({
    ownerId: v.string(),
    /** Optional only for schema rollout; callbacks normalize missing to legacy. */
    ownerGeneration: v.optional(v.string()),
    stateHash: v.string(),
    codeVerifier: v.string(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_stateHash", ["stateHash"])
    .index("by_ownerId_and_expiresAt", ["ownerId", "expiresAt"])
    .index("by_expiresAt", ["expiresAt"]),

  x_oauth_tokens: defineTable({
    ownerId: v.string(),
    /** Optional only until existing credential rows are generation-backfilled. */
    ownerGeneration: v.optional(v.string()),
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
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_ownerId_and_xUserId", ["ownerId", "xUserId"])
    .index("by_xUserId", ["xUserId"])
    .index("by_tokenKeyVersion", ["tokenKeyVersion"]),
};
