import type { MobileCloudMemoryPreference } from "./cloud-memory-preference";

export type MobileCloudMemoryPreferenceUiState = {
  status: "loading" | "synced" | "saving" | "error";
  preference: MobileCloudMemoryPreference | null;
  memoryEnabled: boolean;
  issue: "load" | "save" | null;
};

export const loadingMobileCloudMemoryPreference = (
  previous: MobileCloudMemoryPreference | null = null,
): MobileCloudMemoryPreferenceUiState => ({
  status: "loading",
  preference: previous,
  memoryEnabled: previous?.memoryEnabled ?? true,
  issue: null,
});

export const syncedMobileCloudMemoryPreference = (
  preference: MobileCloudMemoryPreference,
): MobileCloudMemoryPreferenceUiState => ({
  status: "synced",
  preference,
  memoryEnabled: preference.memoryEnabled,
  issue: null,
});

export const savingMobileCloudMemoryPreference = (
  preference: MobileCloudMemoryPreference,
  memoryEnabled: boolean,
): MobileCloudMemoryPreferenceUiState => ({
  status: "saving",
  preference,
  memoryEnabled,
  issue: null,
});

/** A failed save always rolls the visible switch back to server authority. */
export const failedMobileCloudMemoryPreference = (
  preference: MobileCloudMemoryPreference | null,
  issue: "load" | "save",
): MobileCloudMemoryPreferenceUiState => ({
  status: "error",
  preference,
  memoryEnabled: preference?.memoryEnabled ?? true,
  issue,
});
