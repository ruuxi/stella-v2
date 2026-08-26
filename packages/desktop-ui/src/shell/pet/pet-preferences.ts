import { uiState } from "@/platform/ui-state";

const PET_OPEN_KEY = "stella:pet:open";
const PET_LAST_SEEN_ASSISTANT_MESSAGE_KEY =
  "stella:pet:lastSeenAssistantMessageId";

const safeRead = (key: string): string | null => {
  if (typeof window === "undefined") return null;
  return uiState.getItem(key);
};

const safeWrite = (key: string, value: string): void => {
  if (typeof window === "undefined") return;
  uiState.setItem(key, value);
};

/** Whether the pet should be visible on next overlay mount. */
export const readPetOpenPreference = (): boolean =>
  safeRead(PET_OPEN_KEY) === "1";

export const writePetOpenPreference = (open: boolean): void => {
  safeWrite(PET_OPEN_KEY, open ? "1" : "0");
};

/** Last assistant message id the pet has already surfaced as an idle bubble. */
export const readLastSeenPetAssistantMessageId = (): string | null =>
  safeRead(PET_LAST_SEEN_ASSISTANT_MESSAGE_KEY);

export const writeLastSeenPetAssistantMessageId = (id: string): void => {
  safeWrite(PET_LAST_SEEN_ASSISTANT_MESSAGE_KEY, id);
};
