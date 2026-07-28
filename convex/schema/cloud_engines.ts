import { defineTable } from "convex/server";
import { v } from "convex/values";

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
  })
    .index("by_ownerId_and_provider", ["ownerId", "provider"])
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
    // "stella" (managed relay, default) | "anthropic" (Claude subscription).
    chatEngine: v.string(),
    updatedAt: v.number(),
  }).index("by_ownerId", ["ownerId"]),
};
