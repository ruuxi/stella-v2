import { uiState } from "@/platform/ui-state";

const STORAGE_KEY_PREFIX = "stella:activeCloudConversationId:";
const CREATE_ID_KEY_PREFIX = "stella:miniCloudConversationCreateId:";
const MAX_ID_LENGTH = 64;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const CREATE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

const storageKey = (accountScope: string): string =>
  `${STORAGE_KEY_PREFIX}${encodeURIComponent(accountScope)}`;
const createIdStorageKey = (accountScope: string): string =>
  `${CREATE_ID_KEY_PREFIX}${encodeURIComponent(accountScope)}`;

const validConversationId = (value: string | null): value is string =>
  Boolean(value && value.length <= MAX_ID_LENGTH && ID_PATTERN.test(value));

/**
 * Cloud selection is account-scoped. A UUID from the previous Better Auth
 * identity must never be treated as the active conversation for the next one.
 */
export const readActiveCloudConversationIdCache = (
  accountScope: string,
): string | null => {
  if (typeof window === "undefined") return null;
  const value = uiState.getItem(storageKey(accountScope));
  return validConversationId(value) ? value : null;
};

export const writeActiveCloudConversationIdCache = (
  accountScope: string,
  conversationId: string,
): void => {
  if (typeof window === "undefined" || !validConversationId(conversationId)) {
    return;
  }
  uiState.setItem(storageKey(accountScope), conversationId);
};

/**
 * Persists the mutation key before dispatch. If the server commits but the
 * mini renderer closes before receiving the response, the next renderer
 * retries the same create instead of leaving a duplicate blank conversation.
 */
export const getMiniCloudConversationCreateId = (
  accountScope: string,
): string => {
  const key = createIdStorageKey(accountScope);
  const existing = uiState.getItem(key);
  if (existing && CREATE_ID_PATTERN.test(existing)) return existing;
  const created = `mini:${crypto.randomUUID()}`;
  uiState.setItem(key, created);
  return created;
};

/** Arms a fresh create key after a successful bootstrap (including a retry). */
export const rotateMiniCloudConversationCreateId = (
  accountScope: string,
): void => {
  uiState.setItem(
    createIdStorageKey(accountScope),
    `mini:${crypto.randomUUID()}`,
  );
};
