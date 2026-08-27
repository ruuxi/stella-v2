import { uiState } from "@/platform/ui-state";

const STORAGE_KEY = "stella:activeConversationId";

const MAX_LENGTH = 64;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function readActiveConversationIdCache(): string | null {
  if (typeof window === "undefined") return null;
  const raw = uiState.getItem(STORAGE_KEY);
  if (!raw || raw.length > MAX_LENGTH || !ID_PATTERN.test(raw)) return null;
  return raw;
}

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
