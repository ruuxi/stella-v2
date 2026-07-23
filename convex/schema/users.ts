import { defineTable } from "convex/server";
import { v } from "convex/values";

export const usersSchema = {
  user_preferences: defineTable({
    ownerId: v.string(),
    key: v.string(),
    value: v.string(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_key", ["ownerId", "key"])
    .index("by_key", ["key"]),

  /**
   * Cache of `(linq sender) → linq chat ID` so replies can be sent back into
   * the same conversation thread instead of creating a new chat each turn.
   *
   * The sender is stored as `phoneHash` (HMAC-SHA256 with the server pepper
   * `STELLA_PHONE_HASH_PEPPER`), never as the plaintext phone number —
   * Stella does not persist user phone numbers. Replies on the live webhook
   * path use the incoming chat ID directly; this cache only serves outbound
   * sends initiated by the desktop (where the user supplies their phone for
   * one request and we hash it to find a prior thread).
   */
  linq_chats: defineTable({
    phoneHash: v.string(),
    linqChatId: v.string(),
    createdAt: v.number(),
  })
    .index("by_phoneHash", ["phoneHash"]),

  /**
   * Denormalized per-owner counters. Singleton row per `ownerId` updated by
   * mutations that change the underlying row counts. Lets quota checks (e.g.
   * `MAX_CONVERSATIONS_PER_USER`) run in O(1) instead of scanning the
   * conversations table on every create.
   */
  user_counters: defineTable({
    ownerId: v.string(),
    conversationCount: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_ownerId", ["ownerId"]),

};
