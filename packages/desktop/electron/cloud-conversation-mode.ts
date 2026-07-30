type StorageModeCarrier = {
  storageMode?: "cloud" | "local";
};

/**
 * Main-process UI state is populated by the renderer only after the cloud
 * conversation index has validated the route. Empty state means cloud
 * selection is still booting; it must never be replaced with a SQLite id.
 */
export const selectedCloudConversationId = (
  value: string | null | undefined,
): string | null => value?.trim() || null;

/**
 * Bind a renderer or bridge request to the owner-validated conversation that
 * main currently exposes. This prevents a stale renderer session from writing
 * to the conversation that was selected before a route/account change.
 */
export const requireMatchingCloudConversationId = (
  requestedValue: unknown,
  selectedValue: string | null | undefined,
): string => {
  const selectedId = selectedCloudConversationId(selectedValue);
  if (!selectedId) {
    throw new Error("Select a cloud conversation before continuing.");
  }
  if (
    typeof requestedValue !== "string" ||
    selectedCloudConversationId(requestedValue) !== selectedId
  ) {
    throw new Error("The active cloud conversation changed. Try again.");
  }
  return selectedId;
};

/**
 * Electron's ordinary chat boundary is cloud-only. Keep the override in main
 * as well as the runtime so an older renderer cannot silently revive SQLite
 * transcript ownership by sending `storageMode: "local"`.
 */
export const withCloudConversationStorage = <T extends StorageModeCarrier>(
  payload: T,
): Omit<T, "storageMode"> & { storageMode: "cloud" } => ({
  ...payload,
  storageMode: "cloud",
});
