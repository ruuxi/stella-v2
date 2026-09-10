import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import { Alert } from "react-native";
import * as Crypto from "expo-crypto";
import { env } from "../config/env";
import { assert } from "./assert";
import { getConvexToken } from "./auth-token";
import { configurePlaybackAudioSession } from "./mobile-audio-session";

const READ_ALOUD_KEY = "stella-mobile.read-aloud-enabled";
const TTS_STREAM_PREPARE_PATH = "/api/voice/tts/stream/prepare";
const TTS_STREAM_CANCEL_PATH = "/api/voice/tts/stream/cancel";
// The mobile player streams a live HLS playlist so audio starts while Inworld
// is still generating. The ticket authorizes the session; the playlist and its
// segments live under this prefix.
const ttsStreamHlsPlaylistPath = (ticket: string) =>
  `/api/voice/tts/stream/hls/${encodeURIComponent(ticket)}/playlist.m3u8`;
// Voice and model for read-aloud are server-authoritative: the client omits
// them so the backend applies its default (Brooke / inworld-tts-2-flash),
// keeping mobile in lockstep with desktop. Only send an explicit value once
// the user can pick a voice here. (Removed the pinned "Wendy" voice that had
// drifted from the server default.)
// Reload a stalled native player from the same session, never synthesize again.
const STREAM_START_TIMEOUT_MS = 8000;
// Progressive HLS playback is resilient to transient segment/playlist/network
// failures. Native players (AVPlayer/ExoPlayer) give up on a segment fetch that
// fails past their small built-in retry budget, stalling mid-message. When that
// happens we recreate the player and seek back to the last played position —
// reusing the server-cached segments (no re-synthesis, no duplicated audio) —
// so playback continues instead of silently stopping partway.
const HLS_MAX_RECOVER_ATTEMPTS = 4; // mid-stream recoveries before giving up
const HLS_MAX_START_RETRIES = 3; // pre-audible reloads (e.g. empty first playlist)
const HLS_RECOVER_BACKOFF_MS = 700;
const HLS_START_RETRY_BACKOFF_MS = 500;
const HLS_STALL_TIMEOUT_MS = 6000; // no playback progress → treat as stalled
const HLS_WATCHDOG_INTERVAL_MS = 1500;
// Treat an end-of-stream this far before the known duration as a premature stop.
const HLS_PREMATURE_EPS_SEC = 1.5;

let cachedReadAloudEnabled = false;
const listeners = new Set<() => void>();
let currentPlayer: AudioPlayer | null = null;
// The active HLS session ticket, so `stop` can tell the backend to end the
// single background synthesis early (metered as interrupted) instead of letting
// it run to completion after the user has already stopped listening.
let currentStreamTicket: string | null = null;
let playbackGeneration = 0;
// Watchdog interval for the resilient HLS player (detects stalls). Held at
// module scope so `stopReadAloud` can clear it when playback ends.
let hlsWatchdog: ReturnType<typeof setInterval> | null = null;
const clearHlsWatchdog = () => {
  if (hlsWatchdog) {
    clearInterval(hlsWatchdog);
    hlsWatchdog = null;
  }
};
// Resume context saved when resilient HLS playback exhausts its recovery budget
// and stops mid-message, so the user can resume from where it stopped (rebuilds
// the player from the still-cached segments) instead of the message being
// silently presented as finished.
let hlsResume: {
  uri: string;
  token: string;
  id: string | null;
  at: number;
} | null = null;

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
let playbackAbort: AbortController | null = null;

const abortPlaybackWork = () => {
  playbackAbort?.abort();
  playbackAbort = null;
};

const beginPlaybackWork = (): AbortSignal => {
  abortPlaybackWork();
  const controller = new AbortController();
  playbackAbort = controller;
  return controller.signal;
};

const fetchReadAloud = (
  input: string,
  init: RequestInit,
  signal: AbortSignal,
) => fetch(input, { ...init, signal });

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
export function getReadAloudPlaybackState() {
  return playbackState;
}

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

// Ask the backend to synthesize a read-aloud reply and hold it under an opaque
// ticket, so the native audio player can progressively stream it from a GET
// URL. The (long) assistant text is POSTed here and never appears in the URL.
async function prepareInworldReadAloudStream(
  text: string,
  operationId: string,
  signal: AbortSignal,
): Promise<string> {
  assert(env.convexSiteUrl, "EXPO_PUBLIC_CONVEX_SITE_URL is not configured.");
  const token = await getConvexToken();
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const response = await fetchReadAloud(
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
        operationId,
      }),
    },
    signal,
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

export function stopReadAloud() {
  playbackGeneration += 1;
  abortPlaybackWork();
  disposeHlsPlayback?.();
  clearHlsWatchdog();
  hlsResume = null;
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
    } catch {
      /* ignore */
    }
    try {
      player.release();
    } catch {
      /* already released */
    }
  }
}

/** Terminal stop used when dictation begins. Never a pause; nothing resumes. */
export function stopReadAloudForDictation() {
  stopReadAloud();
}

/** Stop/cancel every TTS path first, then start dictation. */
export async function startAfterStoppingReadAloud<T>(
  start: () => T | Promise<T>,
): Promise<T> {
  stopReadAloudForDictation();
  return await start();
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
  if (playbackState?.status !== "paused") return;
  // Resilient HLS playback that exhausted its recovery budget leaves no live
  // player but a saved resume point; rebuild it from the cached segments so the
  // user can pick up where the message stopped instead of restarting.
  if (!currentPlayer && hlsResume) {
    const resume = hlsResume;
    hlsResume = null;
    const id = playbackState.messageId;
    const generation = playbackGeneration;
    setPlaybackState({ messageId: id, status: "loading" });
    void playHlsResilient(resume.uri, resume.token, id, generation, resume.at);
    return;
  }
  if (!currentPlayer) return;
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
  const operationId = Crypto.randomUUID();
  const generation = playbackGeneration;
  const signal = beginPlaybackWork();
  const id = messageId ?? null;
  // Mark the message as loading right away so its button reflects the active
  // request — without this, a second tap during generation would start a whole
  // new request instead of being treated as a pause/cancel.
  setPlaybackState({ messageId: id, status: "loading" });

  // Generate once. Playback retries reuse the ticket's existing audio.
  try {
    await tryStreamReply(spoken, operationId, id, generation, signal);
  } catch (error) {
    if (generation !== playbackGeneration || signal.aborted) return;
    stopReadAloud();
    console.warn("[read-aloud] could not start speech", error);
    Alert.alert(
      "Couldn’t read aloud",
      "Speech could not be started. Please try again.",
    );
  }
}

// Start one generation session and play its growing playlist.
async function tryStreamReply(
  text: string,
  operationId: string,
  id: string | null,
  generation: number,
  signal: AbortSignal,
): Promise<boolean> {
  const ticket = await prepareInworldReadAloudStream(text, operationId, signal);
  if (generation !== playbackGeneration || signal.aborted) {
    // Superseded before playback began — end the background synthesis so it
    // does not run to completion unheard.
    cancelStreamSession(ticket);
    return true;
  }

  assert(env.convexSiteUrl, "EXPO_PUBLIC_CONVEX_SITE_URL is not configured.");
  currentStreamTicket = ticket;
  const token = await getConvexToken();
  // A live HLS playlist that grows as Inworld generates, so playback begins on
  // the first segment instead of waiting for the whole clip.
  const uri = `${env.convexSiteUrl}${ttsStreamHlsPlaylistPath(ticket)}`;

  if (!(await configurePlaybackAudioSession())) {
    if (generation === playbackGeneration) stopReadAloud();
    else cancelStreamSession(ticket);
    return true;
  }
  if (generation !== playbackGeneration || signal.aborted) {
    cancelStreamSession(ticket);
    return true;
  }

  return await playHlsResilient(uri, token, id, generation, 0);
}

// A player is disposable; the generation session is not. Both startup and
// mid-stream recovery load the same playlist and preserve the playback position.
let disposeHlsPlayback: (() => void) | null = null;

async function playHlsResilient(
  uri: string,
  token: string,
  id: string | null,
  generation: number,
  startAt: number,
): Promise<boolean> {
  disposeHlsPlayback?.();
  return await new Promise<boolean>((resolve) => {
    let started = false;
    let finished = false;
    let recovering = false;
    let recoverAttempts = 0;
    let startRetries = 0;
    let lastTime = startAt;
    let lastProgressAt = Date.now();
    let expectedDur = 0;
    let player: AudioPlayer | null = null;
    let startTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const superseded = () => generation !== playbackGeneration;

    const dropPlayer = () => {
      const p = player;
      player = null;
      if (currentPlayer === p) currentPlayer = null;
      if (!p) return;
      try {
        p.pause();
      } catch {
        /* already released */
      }
      try {
        p.remove();
      } catch {
        /* already released */
      }
      // remove() unregisters the Expo player; release() tears down AVPlayer
      // and its pending network/seek work immediately.
      try {
        p.release();
      } catch {
        /* already released */
      }
    };
    const clearStartTimer = () => {
      if (startTimer !== null) clearTimeout(startTimer);
      startTimer = null;
    };
    const dispose = () => {
      finished = true;
      clearStartTimer();
      if (retryTimer !== null) clearTimeout(retryTimer);
      clearHlsWatchdog();
      dropPlayer();
      if (disposeHlsPlayback === dispose) disposeHlsPlayback = null;
      resolve(true);
    };
    disposeHlsPlayback = dispose;

    const giveUp = () => {
      dispose();
      if (superseded()) return;
      hlsResume = { uri, token, id, at: lastTime };
      setPlaybackState({ messageId: id, status: "paused" });
      console.warn(
        `[read-aloud] playback stopped at ${lastTime.toFixed(1)}s after ${startRetries + recoverAttempts} retries`,
      );
      Alert.alert(
        "Playback stopped",
        "Couldn’t play this reply. Retry to continue from where it stopped.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Retry",
            onPress: () => {
              if (!superseded()) resumeReadAloud();
            },
          },
        ],
      );
    };

    const retry = () => {
      if (finished || superseded() || recovering) return;
      clearStartTimer();
      recovering = true;
      dropPlayer();
      if (
        started
          ? recoverAttempts >= HLS_MAX_RECOVER_ATTEMPTS
          : startRetries >= HLS_MAX_START_RETRIES
      ) {
        giveUp();
        return;
      }
      if (started) recoverAttempts += 1;
      else startRetries += 1;
      setPlaybackState({ messageId: id, status: "loading" });
      retryTimer = setTimeout(
        () => {
          retryTimer = null;
          recovering = false;
          if (finished || superseded()) return;
          attach(lastTime);
        },
        started ? HLS_RECOVER_BACKOFF_MS : HLS_START_RETRY_BACKOFF_MS,
      );
    };

    const attach = (at: number) => {
      if (finished || superseded()) return;
      lastProgressAt = Date.now();
      // Also covers native failures that never emit a playback error event.
      startTimer = setTimeout(retry, STREAM_START_TIMEOUT_MS);
      try {
        const p = createAudioPlayer({
          uri,
          headers: { Authorization: `Bearer ${token}` },
        });
        player = p;
        currentPlayer = p;
        let seeked = at <= 0.25;
        let seeking = false;
        p.addListener("playbackStatusUpdate", (status) => {
          if (player !== p || finished || superseded()) return;
          if (!seeked) {
            if (!seeking && (status.isLoaded || status.duration > 0)) {
              seeking = true;
              void p
                .seekTo(at)
                .then(() => {
                  if (player !== p || finished || superseded()) return;
                  seeked = true;
                  p.play();
                })
                .catch(() => {
                  if (player === p) retry();
                });
            }
            // Never mistake the pre-seek position for progress or completion.
            return;
          }
          if (Number.isFinite(status.duration) && status.duration > expectedDur)
            expectedDur = status.duration;
          const t =
            typeof status.currentTime === "number" ? status.currentTime : 0;
          if (t > lastTime + 0.01) {
            lastTime = t;
            lastProgressAt = Date.now();
            clearStartTimer();
            started = true;
            if (playbackState?.status !== "paused")
              setPlaybackState({ messageId: id, status: "playing" });
            resolve(true);
          }
          const state = (status.playbackState ?? "").toLowerCase();
          if (
            state.includes("error") ||
            state.includes("fail") ||
            status.mediaServicesDidReset === true
          ) {
            retry();
          } else if (status.didJustFinish) {
            if (
              !started ||
              (expectedDur > 0 &&
                lastTime < expectedDur - HLS_PREMATURE_EPS_SEC)
            ) {
              retry();
            } else {
              dispose();
              hlsResume = null;
              currentStreamTicket = null;
              setPlaybackState(null);
            }
          }
        });
        if (seeked) p.play();
      } catch {
        retry();
      }
    };

    hlsWatchdog = setInterval(() => {
      if (finished || superseded() || !started || recovering) return;
      if (playbackState?.status === "paused") {
        lastProgressAt = Date.now();
        return;
      }
      // Even a player stalled at its advertised duration must finish explicitly.
      if (Date.now() - lastProgressAt > HLS_STALL_TIMEOUT_MS) retry();
    }, HLS_WATCHDOG_INTERVAL_MS);
    attach(startAt);
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
