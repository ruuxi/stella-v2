/**
 * Whether Stella shows its voice/call controls at all.
 *
 * Voice is off until the user turns it on in Settings › Audio. The stored
 * value is `realtimeVoice.enabled` in `~/.stella/preferences.json`, so it
 * travels with the rest of the voice preferences. Dictation is a separate
 * feature and is never gated by this flag.
 *
 * Reads are served from a module-level cache so render paths (the composer,
 * the companion panel) stay synchronous; the cache is refreshed whenever
 * anything announces `stella:local-model-preferences-changed`.
 */
import { useEffect, useState } from "react";
import {
  isRealtimeVoiceEnabled,
  type RealtimeVoicePreferences,
} from "@stella/contracts/local-preferences";
import { platformCapabilities } from "@/platform/capabilities";

const PREFERENCES_CHANGED_EVENT = "stella:local-model-preferences-changed";

let cachedEnabled = false;
let loaded = false;
let inFlight: Promise<boolean> | null = null;

const listeners = new Set<(enabled: boolean) => void>();

const publish = (enabled: boolean) => {
  const changed = cachedEnabled !== enabled || !loaded;
  cachedEnabled = enabled;
  loaded = true;
  if (!changed) return;
  for (const listener of listeners) listener(enabled);
};

const readFromDisk = (): Promise<boolean> => {
  if (inFlight) return inFlight;
  const request = Promise.resolve(
    window.electronAPI?.system?.getLocalModelPreferences?.(),
  )
    .then((preferences) => {
      const enabled = isRealtimeVoiceEnabled(preferences?.realtimeVoice);
      publish(enabled);
      return enabled;
    })
    .catch(() => {
      publish(false);
      return false;
    })
    .finally(() => {
      inFlight = null;
    });
  inFlight = request;
  return request;
};

if (typeof window !== "undefined" && platformCapabilities.realtimeVoice) {
  window.addEventListener(PREFERENCES_CHANGED_EVENT, () => {
    void readFromDisk();
  });
}

/** Last known value. False until the first read resolves. */
export const realtimeVoiceVisible = (): boolean =>
  platformCapabilities.realtimeVoice && cachedEnabled;

/** Persist the toggle and tell every surface that reads it. */
export const setRealtimeVoiceVisible = async (
  enabled: boolean,
): Promise<void> => {
  const current = await window.electronAPI?.system?.getLocalModelPreferences?.();
  const next: RealtimeVoicePreferences = {
    ...(current?.realtimeVoice ?? { provider: "stella" }),
    enabled,
  };
  await window.electronAPI?.system?.setLocalModelPreferences?.({
    realtimeVoice: next,
  });
  publish(enabled);
  window.dispatchEvent(new CustomEvent(PREFERENCES_CHANGED_EVENT));
};

/** Subscribe a React tree to the toggle. */
export const useRealtimeVoiceVisible = (): boolean => {
  const [enabled, setEnabled] = useState(() => realtimeVoiceVisible());

  useEffect(() => {
    if (!platformCapabilities.realtimeVoice) return;
    const listener = (next: boolean) => setEnabled(next);
    listeners.add(listener);
    if (loaded) {
      setEnabled(cachedEnabled);
    } else {
      void readFromDisk();
    }
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return platformCapabilities.realtimeVoice && enabled;
};
