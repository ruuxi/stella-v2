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
    searchText: v.string(),
    inputSchemaJson: v.string(),
    updatedAt: v.number(),
  })
    .index("by_integrationId_and_name", ["integrationId", "name"])
    .searchIndex("search_searchText", {
      searchField: "searchText",
      filterFields: ["integrationId"],
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
    .index("by_ownerId_and_provider", ["ownerId", "provider"]),

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
