let mirrorQueue: Promise<boolean> = Promise.resolve(true);

/**
 * Serializes the cloud-authoritative Memory bit into the local runtime gate.
 * Calls preserve invocation order so a late IPC completion can never re-enable
 * Memory after a newer fail-closed account transition.
 */
export const mirrorCloudMemoryPreferenceLocally = (
  memoryEnabled: boolean,
): Promise<boolean> => {
  mirrorQueue = mirrorQueue
    .catch(() => false)
    .then(async () => {
      const api = window.electronAPI?.system?.setLocalModelPreferences;
      // Standalone web has no local runtime to mirror into.
      if (!api) return true;
      const result = await api({ memoryEnabled });
      return result?.memoryEnabled === memoryEnabled;
    });
  return mirrorQueue;
};

export const resetCloudMemoryLocalMirrorForTests = (): void => {
  mirrorQueue = Promise.resolve(true);
};
