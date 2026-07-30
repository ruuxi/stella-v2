/**
 * Legacy renderer-side cache of the active local conversation id.
 *
 * Kept so explicit recovery tooling can still identify older SQLite data.
 * Normal root and mini routing never read or write this key: anonymous and
 * connected sessions both use the account-scoped cloud cache instead.
 */

import { uiState } from "@/platform/ui-state";

const STORAGE_KEY = "stella:activeConversationId";

/** Conversation ids are ULIDs; cap and charset-check to reject junk. */
const MAX_LENGTH = 64;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Read the cached active conversation id, or `null` if missing/invalid. */
export function readActiveConversationIdCache(): string | null {
  if (typeof window === "undefined") return null;
  const raw = uiState.getItem(STORAGE_KEY);
  if (!raw || raw.length > MAX_LENGTH || !ID_PATTERN.test(raw)) return null;
  return raw;
}

/** Cache the active conversation id. Silently noops on storage errors. */
export function writeActiveConversationIdCache(conversationId: string): void {
  if (typeof window === "undefined") return;
  if (
    !conversationId ||
    conversationId.length > MAX_LENGTH ||
    !ID_PATTERN.test(conversationId)
  ) {
    return;
  }
  uiState.setItem(STORAGE_KEY, conversationId);
}
