type StorageModeCarrier = {
  storageMode?: "cloud" | "local";
};

/**
 * Main-process UI state is populated only after the renderer has selected an
 * owner-validated cloud conversation. Empty state means selection is still
 * booting; it must never be replaced with a SQLite conversation id.
 */
export const selectedCloudConversationId = (
  value: string | null | undefined,
): string | null => value?.trim() || null;

/**
 * Bind a renderer or bridge request to the conversation main currently
 * exposes. A stale renderer must not write to the conversation that was
 * selected before a route or account change.
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
 * Electron's ordinary chat boundary is cloud-only. Keep this override in main
 * as well as the runtime so an older renderer cannot revive local transcript
 * ownership by sending `storageMode: "local"`.
 */
export const withCloudConversationStorage = <T extends StorageModeCarrier>(
  payload: T,
): Omit<T, "storageMode"> & { storageMode: "cloud" } => ({
  ...payload,
  storageMode: "cloud",
});
