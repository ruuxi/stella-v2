import { useSyncExternalStore } from "react";
import { stripMarkdownForTts } from "./markdown-strip";
import { fetchReadAloudAudio, openReadAloudStream } from "./tts-client";
import {
  canStreamReadAloud,
  playReadAloud,
  playReadAloudStream,
  stopReadAloud,
} from "./read-aloud-player";
import { resolveReadAloudVoicePrefs } from "./read-aloud-voice-prefs";

export type ManualReadAloudStatus = "idle" | "loading" | "playing";

type ManualReadAloudState = {

  key: string | null;
  status: ManualReadAloudStatus;
};

const IDLE_STATE: ManualReadAloudState = { key: null, status: "idle" };

let state: ManualReadAloudState = IDLE_STATE;
let requestToken = 0;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

const setState = (next: ManualReadAloudState) => {
  if (next.key === state.key && next.status === state.status) return;
  state = next;
  emit();
};

const goIdle = () => setState(IDLE_STATE);

export async function toggleManualReadAloud(
  key: string,
  text: string,
): Promise<void> {

  if (state.key === key && state.status !== "idle") {
    requestToken += 1;
    stopReadAloud();
    goIdle();
    return;
  }

  const token = ++requestToken;
  stopReadAloud();

  const clean = stripMarkdownForTts(text);
  if (!clean) {
    goIdle();
    return;
  }

  setState({ key, status: "loading" });
  const onEnded = () => {
    if (token === requestToken) goIdle();
  };
  try {
    const prefs = await resolveReadAloudVoicePrefs();
    if (token !== requestToken) return;

    if (prefs.family === "inworld" && canStreamReadAloud()) {
      try {
        const response = await openReadAloudStream({
          text: clean,
          voice: prefs.voice,
          speed: prefs.speed,
        });
        if (token !== requestToken) {
          await response.body?.cancel().catch(() => undefined);
          return;
        }
        await playReadAloudStream(response, { onEnded });
        if (token === requestToken) setState({ key, status: "playing" });
        return;
      } catch (streamErr) {
        console.warn(
          "[manual-read-aloud] streaming failed, falling back:",
          streamErr,
        );
        if (token !== requestToken) return;
      }
    }

    const { audio } = await fetchReadAloudAudio({
      text: clean,
      voiceProvider: prefs.family,
      voice: prefs.voice,
      speed: prefs.speed,
    });
    if (token !== requestToken) return;
    setState({ key, status: "playing" });
    await playReadAloud(audio, { onEnded });
  } catch (err) {
    console.warn("[manual-read-aloud] playback failed:", err);
    if (token === requestToken) goIdle();
  }
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = (): ManualReadAloudState => state;

export function useManualReadAloudStatus(key: string): ManualReadAloudStatus {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return snapshot.key === key ? snapshot.status : "idle";
}
