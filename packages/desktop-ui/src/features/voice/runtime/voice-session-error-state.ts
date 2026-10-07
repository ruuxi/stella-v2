/**
 * Why the current call failed, as an external store any surface can read.
 *
 * The voice runtime lives in the hidden overlay window, so the failure reason
 * has to travel through the main process to reach anything the user can see.
 * `voice-error-toast.ts` decides whether a failure deserves interrupting the
 * user; this is the plain state behind it, published for every failure so a
 * voice surface can say what actually went wrong instead of rendering blank.
 *
 * The backend's own words are kept verbatim — "Realtime voice is part of
 * Stella Pro.", a usage-limit message, "Voice sessions are not configured
 * yet." — because flattening them into a generic failure is what made the
 * card useless.
 */

let current = "";
let hydrated = false;
let unsubscribeIpc: (() => void) | null = null;
const listeners = new Set<() => void>();

const emit = (next: string): void => {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
};

const ensureAttached = (): void => {
  const api = window.electronAPI?.voice;
  if (!api) return;
  if (!unsubscribeIpc) {
    unsubscribeIpc =
      api.onSessionErrorState?.((message) => {
        emit(typeof message === "string" ? message.trim() : "");
      }) ?? null;
  }
  if (!hydrated && api.getSessionErrorState) {
    hydrated = true;
    void api
      .getSessionErrorState()
      .then((message) => {
        emit(typeof message === "string" ? message.trim() : "");
      })
      .catch(() => undefined);
  }
};

export const voiceSessionErrorStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    ensureAttached();
    return () => {
      listeners.delete(listener);
      if (listeners.size > 0) return;
      unsubscribeIpc?.();
      unsubscribeIpc = null;
    };
  },
  getSnapshot(): string {
    return current;
  },
  getServerSnapshot(): string {
    return "";
  },
};
