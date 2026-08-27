export const UI_STATE_FILE_NAME = "ui-state.json";

export type UiStateSnapshot = Record<string, string>;

export type UiStateChanges = Record<string, string | null>;

export const UI_STATE_DEV_EVENT = "stella:ui-state-changed";

export const UI_STATE_DEV_ENDPOINT = "/__stella/ui-state";

export type UiStateDevWriteRequest = {

  clientId?: string;
  changes?: UiStateChanges;
  clear?: boolean;
};

export type UiStateDevChangedEvent = {

  clientId: string | null;
  changes: UiStateChanges;
};

const MAX_KEY_LENGTH = 1024;

export const sanitizeUiStateChanges = (
  value: unknown,
): UiStateChanges | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const changes: UiStateChanges = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) continue;
    if (entry === null || typeof entry === "string") {
      changes[key] = entry;
    }
  }
  return changes;
};
