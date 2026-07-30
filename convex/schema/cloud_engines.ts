import { defineTable } from "convex/server";
import { v } from "convex/values";
import { cloudExecutionSelectionValidator } from "../lib/cloud_execution";

/**
 * Cloud engine credentials: the cloud analog of the desktop's
 * `llm_oauth_credentials.json`. Lets a user's Claude (Anthropic) or ChatGPT
 * (Codex) subscription power cloud turns. Tokens are encrypted at rest with
 * the server-held CLOUD_LLM_CREDENTIALS_KEY and are never returned to
 * clients or handed to sandboxes — the relay resolves and uses them
 * server-side, and refresh writes back here so credentials survive across
 * sandbox instances.
 */
export const cloudEnginesSchema = {
  // One row per (owner, provider). payloadEncrypted is AES-256-GCM over the
  // JSON {access, refresh, expires, accountId?}.
  cloud_llm_credentials: defineTable({
    ownerId: v.string(),
    // "anthropic" (Claude Pro/Max) | "openai-codex" (ChatGPT).
    provider: v.string(),
    payloadEncrypted: v.string(),
    label: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    // Short lease serializing rotating OAuth refresh tokens. Refresh commits
    // compare both this lease and the exact encrypted payload, so disconnect
    // or reconnect can never be undone by an in-flight action.
    refreshLeaseId: v.optional(v.string()),
    refreshLeaseExpiresAt: v.optional(v.number()),
    // Set only on a lossless account-link import that is not the active
    // credential for this provider. The encrypted copy remains recoverable.
    importedFromOwnerId: v.optional(v.string()),
  })
    .index("by_ownerId_and_provider", ["ownerId", "provider"])
    .index("by_ownerId_and_provider_and_importedFromOwnerId", [
      "ownerId",
      "provider",
      "importedFromOwnerId",
    ])
    .index("by_ownerId", ["ownerId"]),

  // Pending PKCE connect flows (verifier stays server-side; the client only
  // ever sees the authorize URL and pastes the resulting code back).
  cloud_engine_connects: defineTable({
    connectId: v.string(),
    ownerId: v.string(),
    provider: v.string(),
    verifier: v.string(),
    state: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_connectId", ["connectId"])
    .index("by_expiresAt", ["expiresAt"])
    // Account deletion drains by owner. A pending flow holds the PKCE verifier
    // for a connect the user started, and expiry is a floor on how long that
    // survives, never a deletion path.
    .index("by_ownerId", ["ownerId"]),

  // Per-owner engine choice for cloud chat/agent turns.
  cloud_engine_settings: defineTable({
    ownerId: v.string(),
    // Legacy coarse selector: "stella" | "anthropic" | "openai-codex".
    chatEngine: v.string(),
    /**
     * Exact default route for new cloud conversations. Optional during the
     * migration from the coarse `chatEngine` field above.
     */
    execution: v.optional(cloudExecutionSelectionValidator),
    // Imported settings are preserved as an inactive alternative. The row
    // with this field absent remains the active singleton.
    importedFromOwnerId: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_ownerId_and_importedFromOwnerId", [
      "ownerId",
      "importedFromOwnerId",
    ]),
};
