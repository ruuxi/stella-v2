import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
} from "expo-audio";
import { File, Paths } from "expo-file-system";
import { env } from "../config/env";
import { assert } from "./assert";
import { getConvexToken } from "./auth-token";

const READ_ALOUD_KEY = "stella-mobile.read-aloud-enabled";
const TTS_PATH = "/api/voice/tts";

let cachedReadAloudEnabled = false;
const listeners = new Set<() => void>();
let currentPlayer: AudioPlayer | null = null;
let currentFile: File | null = null;
let playbackGeneration = 0;

const emit = () => {
  for (const listener of listeners) listener();
};

// Playback is a singleton (one clip at a time), so its state lives here rather
// than in a component. `messageId` is the message whose audio is loaded; the
// status drives that message's sound button — a spinner while the audio is
// fetched, then a pause/play toggle. `null` means nothing is loaded. Pausing
// keeps the clip and player alive so playback can resume in place instead of
// regenerating the audio from scratch.
export type ReadAloudStatus = "loading" | "playing" | "paused";
export type ReadAloudState = { messageId: string | null; status: ReadAloudStatus };

let playbackState: ReadAloudState | null = null;
const speakingListeners = new Set<() => void>();
const emitSpeaking = () => {
  for (const listener of speakingListeners) listener();
};
const setPlaybackState = (next: ReadAloudState | null) => {
  if (
    playbackState === next ||
    (playbackState != null &&
      next != null &&
      playbackState.messageId === next.messageId &&
      playbackState.status === next.status)
  ) {
    return;
  }
  playbackState = next;
  emitSpeaking();
};

const speakingStore = {
  subscribe(listener: () => void) {
    speakingListeners.add(listener);
    return () => {
      speakingListeners.delete(listener);
    };
  },
  getSnapshot() {
    return playbackState;
  },
};

/** Current read-aloud playback state, or `null` when nothing is loaded. */
export function useReadAloudState() {
  return useSyncExternalStore(
    speakingStore.subscribe,
    speakingStore.getSnapshot,
    speakingStore.getSnapshot,
  );
}

export const readAloudStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot() {
    return cachedReadAloudEnabled;
  },
};

export async function loadReadAloudPreference() {
  const raw = await AsyncStorage.getItem(READ_ALOUD_KEY);
  cachedReadAloudEnabled = raw === "1";
  emit();
  return cachedReadAloudEnabled;
}

export async function setReadAloudEnabled(enabled: boolean) {
  cachedReadAloudEnabled = enabled;
  emit();
  if (enabled) {
    await AsyncStorage.setItem(READ_ALOUD_KEY, "1");
  } else {
    await AsyncStorage.removeItem(READ_ALOUD_KEY);
    stopReadAloud();
  }
}

const stripForSpeech = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#*_>~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const readErrorMessage = async (response: Response) => {
  const text = await response.text().catch(() => "");
  if (!text) return "Could not read that reply aloud.";
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const message = parsed.error ?? parsed.message;
    return typeof message === "string" && message.trim()
      ? message.trim()
      : "Could not read that reply aloud.";
  } catch {
    return text.trim() || "Could not read that reply aloud.";
  }
};

const createAudioFile = (audio: ArrayBuffer, contentType: string) => {
  const ext = contentType.includes("mpeg") || contentType.includes("mp3")
    ? "mp3"
    : "wav";
  const file = new File(
    Paths.cache,
    `stella-read-aloud-${Date.now()}-${playbackGeneration}.${ext}`,
  );
  file.create({ overwrite: true, intermediates: true });
  file.write(new Uint8Array(audio));
  return file;
};

async function fetchInworldReadAloudAudio(text: string) {
  assert(env.convexSiteUrl, "EXPO_PUBLIC_CONVEX_SITE_URL is not configured.");
  const token = await getConvexToken();
  const response = await fetch(`${env.convexSiteUrl}${TTS_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      voiceProvider: "inworld",
      voice: "Wendy",
      model: "inworld-tts-2",
    }),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return {
    audio: await response.arrayBuffer(),
    contentType:
      response.headers.get("content-type")?.split(";")[0]?.trim() ?? "audio/wav",
  };
}

export function stopReadAloud() {
  playbackGeneration += 1;
  setPlaybackState(null);
  const player = currentPlayer;
  currentPlayer = null;
  if (player) {
    try {
      player.pause();
      player.remove();
      player.release();
    } catch {
      /* ignore */
    }
  }

  const file = currentFile;
  currentFile = null;
  if (file) {
    try {
      file.delete();
    } catch {
      /* ignore */
    }
  }
}

/** Pause the active clip, keeping it loaded so it can resume in place. */
export function pauseReadAloud() {
  if (!currentPlayer || playbackState?.status !== "playing") return;
  try {
    currentPlayer.pause();
  } catch {
    /* ignore */
  }
  setPlaybackState({ messageId: playbackState.messageId, status: "paused" });
}

/** Resume a clip that was paused with `pauseReadAloud`. */
export function resumeReadAloud() {
  if (!currentPlayer || playbackState?.status !== "paused") return;
  try {
    currentPlayer.play();
  } catch {
    /* ignore */
  }
  setPlaybackState({ messageId: playbackState.messageId, status: "playing" });
}

export async function speakReply(text: string, messageId?: string) {
  const spoken = stripForSpeech(text);
  if (!spoken) return;

  stopReadAloud();
  const generation = playbackGeneration;
  const id = messageId ?? null;
  // Mark the message as loading right away so its button reflects the active
  // request — without this, a second tap during generation would start a whole
  // new request instead of being treated as a pause/cancel.
  setPlaybackState({ messageId: id, status: "loading" });

  try {
    const { audio, contentType } = await fetchInworldReadAloudAudio(spoken);
    if (generation !== playbackGeneration) return;

    const file = createAudioFile(audio, contentType);
    if (generation !== playbackGeneration) {
      try {
        file.delete();
      } catch {
        /* ignore */
      }
      return;
    }

    await setAudioModeAsync({ playsInSilentMode: true });
    const player = createAudioPlayer({ uri: file.uri });
    currentFile = file;
    currentPlayer = player;
    // Reset the playback state when the clip finishes on its own so the
    // message's sound button flips back to play.
    player.addListener("playbackStatusUpdate", (status) => {
      if (generation !== playbackGeneration) return;
      if (status.didJustFinish) setPlaybackState(null);
    });
    setPlaybackState({ messageId: id, status: "playing" });
    player.play();
  } catch (error) {
    if (generation === playbackGeneration) setPlaybackState(null);
    console.warn("[read-aloud] playback failed", error);
  }
}

export function useReadAloudPreference() {
  const [enabled, setEnabled] = useState(readAloudStore.getSnapshot);

  useEffect(() => {
    void loadReadAloudPreference();
    return readAloudStore.subscribe(() => {
      setEnabled(readAloudStore.getSnapshot());
    });
  }, []);

  return useMemo(
    () => ({
      enabled,
      setEnabled: setReadAloudEnabled,
    }),
    [enabled],
  );
}
