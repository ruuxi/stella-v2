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
const TTS_STREAM_PREPARE_PATH = "/api/voice/tts/stream/prepare";
const TTS_STREAM_CANCEL_PATH = "/api/voice/tts/stream/cancel";
// The mobile player streams a live HLS playlist so audio starts while Inworld
// is still generating. The ticket authorizes the session; the playlist and its
// segments live under this prefix.
const ttsStreamHlsPlaylistPath = (ticket: string) =>
  `/api/voice/tts/stream/hls/${encodeURIComponent(ticket)}/playlist.m3u8`;
const INWORLD_READ_ALOUD_VOICE = "Wendy";
const INWORLD_READ_ALOUD_MODEL = "inworld-tts-2-flash";
// Safety net: if progressive playback has not begun within this window we
// abandon it and fall back to the one-shot buffered request.
const STREAM_START_TIMEOUT_MS = 8000;

let cachedReadAloudEnabled = false;
const listeners = new Set<() => void>();
let currentPlayer: AudioPlayer | null = null;
let currentFile: File | null = null;
// The active HLS session ticket, so `stop` can tell the backend to end the
// single background synthesis early (metered as interrupted) instead of letting
// it run to completion after the user has already stopped listening.
let currentStreamTicket: string | null = null;
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
export type ReadAloudState = {
  messageId: string | null;
  status: ReadAloudStatus;
};

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

// Pick the file extension from the audio's magic bytes first, falling back to
// the content-type. Inworld's one-shot endpoint labels MP3 output as
// `audio/wav`, so trusting the header alone would write a `.wav` file the
// native player cannot demux.
const detectAudioExt = (
  audio: ArrayBuffer,
  contentType: string,
): "mp3" | "wav" => {
  const b = new Uint8Array(audio);
  if (
    b.length >= 4 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46
  ) {
    return "wav"; // "RIFF"
  }
  if (b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    return "mp3"; // "ID3"
  }
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
    return "mp3"; // MPEG frame sync
  }
  return contentType.includes("mpeg") || contentType.includes("mp3")
    ? "mp3"
    : "wav";
};

const createAudioFile = (audio: ArrayBuffer, contentType: string) => {
  const ext = detectAudioExt(audio, contentType);
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
      voice: INWORLD_READ_ALOUD_VOICE,
      model: INWORLD_READ_ALOUD_MODEL,
    }),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return {
    audio: await response.arrayBuffer(),
    contentType:
      response.headers.get("content-type")?.split(";")[0]?.trim() ??
      "audio/wav",
  };
}

// Ask the backend to synthesize a read-aloud reply and hold it under an opaque
// ticket, so the native audio player can progressively stream it from a GET
// URL. The (long) assistant text is POSTed here and never appears in the URL.
async function prepareInworldReadAloudStream(text: string): Promise<string> {
  assert(env.convexSiteUrl, "EXPO_PUBLIC_CONVEX_SITE_URL is not configured.");
  const token = await getConvexToken();
  const response = await fetch(
    `${env.convexSiteUrl}${TTS_STREAM_PREPARE_PATH}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        voiceProvider: "inworld",
        voice: INWORLD_READ_ALOUD_VOICE,
        model: INWORLD_READ_ALOUD_MODEL,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  const data = (await response.json()) as { ticket?: unknown };
  if (typeof data.ticket !== "string" || !data.ticket) {
    throw new Error("Read-aloud stream ticket missing.");
  }
  return data.ticket;
}

// Best-effort stop beacon: tell the backend to end the background synthesis for
// a ticket so provider spend stops when the user stops listening. Fire and
// forget — a failure just means the synthesis runs to its (bounded) completion.
function cancelStreamSession(ticket: string) {
  if (!env.convexSiteUrl) return;
  void (async () => {
    try {
      const token = await getConvexToken();
      await fetch(`${env.convexSiteUrl}${TTS_STREAM_CANCEL_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ticket }),
      });
    } catch {
      /* ignore */
    }
  })();
}

// Release a streaming player without disturbing the global generation counter
// (used when a stream fails and we fall back to buffered playback). Also ends
// the background synthesis so it does not keep spending alongside the fallback.
function releaseStreamPlayer(player: AudioPlayer) {
  if (currentPlayer === player) currentPlayer = null;
  const ticket = currentStreamTicket;
  currentStreamTicket = null;
  if (ticket) cancelStreamSession(ticket);
  try {
    player.pause();
    player.remove();
    player.release();
  } catch {
    /* ignore */
  }
}

export function stopReadAloud() {
  playbackGeneration += 1;
  setPlaybackState(null);
  const ticket = currentStreamTicket;
  currentStreamTicket = null;
  if (ticket) cancelStreamSession(ticket);
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

  // Prefer progressive streaming so audio starts before the whole reply is
  // synthesized. Fall back to a one-shot buffered clip if streaming is
  // unavailable or fails before any audio is audible.
  try {
    const streamed = await tryStreamReply(spoken, id, generation);
    if (streamed) return;
  } catch (error) {
    console.warn("[read-aloud] streaming failed, falling back", error);
  }
  if (generation !== playbackGeneration) return;

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

// Attempt progressive playback. Resolves `true` when playback started (or the
// request was superseded/cancelled — nothing left to do), and `false` when the
// caller should fall back to the buffered path. Cleans up its own player on
// the fall-back path so nothing lingers.
async function tryStreamReply(
  text: string,
  id: string | null,
  generation: number,
): Promise<boolean> {
  const ticket = await prepareInworldReadAloudStream(text);
  if (generation !== playbackGeneration) {
    // Superseded before playback began — end the background synthesis so it
    // does not run to completion unheard.
    cancelStreamSession(ticket);
    return true;
  }

  assert(env.convexSiteUrl, "EXPO_PUBLIC_CONVEX_SITE_URL is not configured.");
  const token = await getConvexToken();
  // A live HLS playlist that grows as Inworld generates, so playback begins on
  // the first segment instead of waiting for the whole clip.
  const uri = `${env.convexSiteUrl}${ttsStreamHlsPlaylistPath(ticket)}`;

  await setAudioModeAsync({ playsInSilentMode: true });
  if (generation !== playbackGeneration) {
    cancelStreamSession(ticket);
    return true;
  }

  const player = createAudioPlayer({
    uri,
    headers: { Authorization: `Bearer ${token}` },
  });
  currentFile = null;
  currentPlayer = player;
  currentStreamTicket = ticket;

  return await new Promise<boolean>((resolve) => {
    let decided = false;
    const decide = (result: boolean) => {
      if (decided) return;
      decided = true;
      clearTimeout(timer);
      resolve(result);
    };
    // A single persistent listener drives both start/fail detection and the
    // natural-finish reset for the life of this player.
    player.addListener("playbackStatusUpdate", (status) => {
      if (generation !== playbackGeneration) return;
      if (status.didJustFinish) {
        setPlaybackState(null);
        return;
      }
      const state = (status.playbackState ?? "").toLowerCase();
      const errored = state.includes("error") || state.includes("fail");
      if (decided) return;
      if (status.playing || status.currentTime > 0) {
        setPlaybackState({ messageId: id, status: "playing" });
        decide(true);
      } else if (errored) {
        releaseStreamPlayer(player);
        decide(false);
      }
    });
    const timer = setTimeout(() => {
      if (generation !== playbackGeneration) {
        decide(true);
        return;
      }
      // Never became audible in time → tear down and fall back.
      releaseStreamPlayer(player);
      decide(false);
    }, STREAM_START_TIMEOUT_MS);
    player.play();
  });
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
