/**
 * Companion-window subscriptions: the chat snapshot published by the full
 * shell, the realtime voice runtime's speaking flags, and the read-aloud
 * preference. Each is a `useSyncExternalStore`-style subscription so the
 * companion never polls.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  EMPTY_COMPANION_STATE,
  type CompanionState,
} from "@stella/contracts/desktop/companion";
import { readAloudPrefStore } from "@/features/voice/services/read-aloud/read-aloud-pref";

export function useCompanionState(): CompanionState {
  const [state, setState] = useState<CompanionState>(EMPTY_COMPANION_STATE);

  useEffect(() => {
    const api = window.electronAPI?.companion;
    if (!api) return;
    let cancelled = false;
    void api
      .getState()
      .then((initial) => {
        if (!cancelled && initial) setState(initial);
      })
      .catch(() => undefined);
    const unsubscribe = api.onState((next) => {
      if (!cancelled && next) setState(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return state;
}

export type VoiceSpeakingState = {
  isSpeaking: boolean;
  isUserSpeaking: boolean;
};

const IDLE_VOICE: VoiceSpeakingState = {
  isSpeaking: false,
  isUserSpeaking: false,
};

/**
 * Speaking flags from the realtime voice runtime (which lives in the overlay
 * window). Subscribed only while a voice session is active so an idle
 * companion carries no extra IPC traffic.
 */
export function useVoiceSpeakingState(active: boolean): VoiceSpeakingState {
  const [state, setState] = useState<VoiceSpeakingState>(IDLE_VOICE);

  useEffect(() => {
    const api = window.electronAPI?.voice;
    if (!active || !api) {
      setState(IDLE_VOICE);
      return;
    }
    let cancelled = false;
    const apply = (snapshot: {
      isSpeaking?: boolean;
      isUserSpeaking?: boolean;
    }) => {
      if (cancelled) return;
      const next = {
        isSpeaking: snapshot.isSpeaking === true,
        isUserSpeaking: snapshot.isUserSpeaking === true,
      };
      setState((prev) =>
        prev.isSpeaking === next.isSpeaking &&
        prev.isUserSpeaking === next.isUserSpeaking
          ? prev
          : next,
      );
    };
    void api
      .getRuntimeState()
      .then(apply)
      .catch(() => undefined);
    const unsubscribe = api.onRuntimeState(apply);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [active]);

  return state;
}

export function useReadAloudEnabled(): boolean {
  return useSyncExternalStore(
    readAloudPrefStore.subscribe,
    readAloudPrefStore.getSnapshot,
    readAloudPrefStore.getServerSnapshot,
  );
}
