type StorageModeCarrier = {
  storageMode?: "cloud" | "local";
};

/**
 * Main-process UI state mirrors the selected conversation in the current
 * storage mode. Empty state means selection is still booting; callers must
 * not substitute a conversation from the other history.
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
    throw new Error("Select a conversation before continuing.");
  }
  if (
    typeof requestedValue !== "string" ||
    selectedCloudConversationId(requestedValue) !== selectedId
  ) {
    throw new Error("The active conversation changed. Try again.");
  }
  return selectedId;
};

/**
 * Bind a paired-phone bridge request to the conversation the phone asked for.
 * The phone owns its own conversation selection, so it must not be forced to
 * match whichever conversation the desktop window happens to show; the cloud
 * journal and history endpoints still enforce account ownership server-side
 * with the desktop's own token, and the active cache authority proves that a
 * signed-in owner generation exists to write under.
 */
export const requireRequestedCloudConversationId = (
  requestedValue: unknown,
  authority: { ownerGeneration?: string | null } | null | undefined,
): string => {
  const requestedId =
    typeof requestedValue === "string"
      ? selectedCloudConversationId(requestedValue)
      : null;
  if (!requestedId || requestedId.startsWith("local_")) {
    throw new Error("A cloud conversation id is required.");
  }
  if (!authority?.ownerGeneration?.trim()) {
    throw new Error(
      "Cloud conversation authority is not ready. Try again in a moment.",
    );
  }
  return requestedId;
};

/** Preserve explicit local ownership; omission continues to mean cloud. */
export const withConversationStorage = <T extends StorageModeCarrier>(
  payload: T,
) => ({
  ...payload,
  storageMode:
    payload.storageMode === "local" ? ("local" as const) : ("cloud" as const),
});
