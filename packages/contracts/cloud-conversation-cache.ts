/**
 * Desktop-only derived cache for the cloud Durable Object journal.
 *
 * These DTOs intentionally carry no JWT, cookie, session id, credential, or
 * provider token. The authority tuple is the same immutable product identity
 * fence used by the cloud outbox; `records` are already-decoded durable journal
 * rows and remain a rebuildable view, never a server/runtime input.
 */

export const MAX_CLOUD_CONVERSATION_CACHE_RECORDS = 3_000;
export const MAX_CLOUD_CONVERSATION_CACHE_CONVERSATIONS = 8;
export const MAX_CLOUD_CONVERSATION_CACHE_RECORD_BYTES = 512 * 1024;
export const MAX_CLOUD_CONVERSATION_CACHE_TOTAL_BYTES = 16 * 1024 * 1024;

export type CloudConversationCacheAuthority = {
  accountScope: string;
  ownerGeneration: string;
  conversationId: string;
};

export type CloudConversationCacheLifecycleAuthority = {
  accountScope: string;
  ownerGeneration: string;
};

/** Exact compare-and-swap token for one cached canonical window. */
export type CloudConversationCacheVersion = {
  epoch: number;
  headSeq: number;
  floorSeq: number;
  revision: number;
};

export type CloudConversationCacheSnapshot = CloudConversationCacheAuthority &
  CloudConversationCacheVersion & {
    title: string;
    cachedAtMs: number;
    /** Raw, validated journal rows in ascending, gapless `seq` order. */
    records: unknown[];
  };

export type CloudConversationCacheReplaceInput =
  CloudConversationCacheAuthority & {
    expected: CloudConversationCacheVersion | null;
    epoch: number;
    headSeq: number;
    floorSeq: number;
    title: string;
    /** Reuse this immutable span from `expected` (same epoch). Omit for a full
     * replacement. `records` then contains only the prefix/suffix outside it. */
    retainedRange?: { fromSeq: number; toSeq: number };
    /** Combined with retainedRange, an ascending gapless suffix at headSeq. */
    records: unknown[];
  };

export type CloudConversationCacheReplaceResult =
  | {
      status: "applied";
      version: CloudConversationCacheVersion;
    }
  | {
      status: "conflict" | "inactive";
      current: CloudConversationCacheVersion | null;
    };

export type CloudConversationCachePurgeResult = {
  purgedConversations: number;
};
