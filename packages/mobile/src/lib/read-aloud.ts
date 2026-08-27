import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createAudioPlayer,
  type AudioPlayer,
} from "expo-audio";
import { File, Paths } from "expo-file-system";
import { env } from "../config/env";
import { assert } from "./assert";
import { getConvexToken } from "./auth-token";
import { configurePlaybackAudioSession } from "./mobile-audio-session";

const READ_ALOUD_KEY = "stella-mobile.read-aloud-enabled";
const TTS_PATH = "/api/voice/tts";
const TTS_STREAM_PREPARE_PATH = "/api/voice/tts/stream/prepare";
const TTS_STREAM_CANCEL_PATH = "/api/voice/tts/stream/cancel";

const ttsStreamHlsPlaylistPath = (ticket: string) =>
  `/api/voice/tts/stream/hls/${encodeURIComponent(ticket)}/playlist.m3u8`;

const STREAM_START_TIMEOUT_MS = 8000;

const HLS_MAX_RECOVER_ATTEMPTS = 4;
const HLS_MAX_START_RETRIES = 3;
const HLS_RECOVER_BACKOFF_MS = 700;
const HLS_START_RETRY_BACKOFF_MS = 500;
const HLS_STALL_TIMEOUT_MS = 6000;
const HLS_WATCHDOG_INTERVAL_MS = 1500;

const HLS_PREMATURE_EPS_SEC = 1.5;

let cachedReadAloudEnabled = false;
const listeners = new Set<() => void>();
let currentPlayer: AudioPlayer | null = null;
let currentFile: File | null = null;

let currentStreamTicket: string | null = null;
let playbackGeneration = 0;

let hlsWatchdog: ReturnType<typeof setInterval> | null = null;
const clearHlsWatchdog = () => {
  if (hlsWatchdog) {
    clearInterval(hlsWatchdog);
    hlsWatchdog = null;
  }
};

let hlsResume: {
  uri: string;
  token: string;
  id: string | null;
  at: number;
} | null = null;

const emit = () => {
  for (const listener of listeners) listener();
};

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

const fetchReadAloud = (input: string, init: RequestInit, signal: AbortSignal) =>
  fetch(input, { ...init, signal });

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

export function getReadAloudPlaybackState() {
  return playbackState;
}

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
    return "wav";
  }
  if (b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    return "mp3";
  }
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
    return "mp3";
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

async function fetchInworldReadAloudAudio(text: string, signal: AbortSignal) {
  assert(env.convexSiteUrl, "EXPO_PUBLIC_CONVEX_SITE_URL is not configured.");
  const token = await getConvexToken();
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const response = await fetchReadAloud(
    `${env.convexSiteUrl}${TTS_PATH}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        voiceProvider: "inworld",
      }),
    },
    signal,
  );

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

async function prepareInworldReadAloudStream(
  text: string,
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

    }
  })();
}

export function stopReadAloud() {
  playbackGeneration += 1;
  abortPlaybackWork();
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
      player.release();
    } catch {

    }
  }

  const file = currentFile;
  currentFile = null;
  if (file) {
    try {
      file.delete();
    } catch {

    }
  }
}

export function stopReadAloudForDictation() {
  stopReadAloud();
}

export async function startAfterStoppingReadAloud<T>(
  start: () => T | Promise<T>,
): Promise<T> {
  stopReadAloudForDictation();
  return await start();
}

export function pauseReadAloud() {
  if (!currentPlayer || playbackState?.status !== "playing") return;
  try {
    currentPlayer.pause();
  } catch {

  }
  setPlaybackState({ messageId: playbackState.messageId, status: "paused" });
}

export function resumeReadAloud() {
  if (playbackState?.status !== "paused") return;

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

  }
  setPlaybackState({ messageId: playbackState.messageId, status: "playing" });
}

export async function speakReply(text: string, messageId?: string) {
  const spoken = stripForSpeech(text);
  if (!spoken) return;

  stopReadAloud();
  const generation = playbackGeneration;
  const signal = beginPlaybackWork();
  const id = messageId ?? null;

  setPlaybackState({ messageId: id, status: "loading" });

  try {
    const streamed = await tryStreamReply(spoken, id, generation, signal);
    if (streamed) return;
  } catch (error) {
    if (generation !== playbackGeneration || signal.aborted) return;
    console.warn("[read-aloud] streaming failed, falling back", error);
  }
  if (generation !== playbackGeneration || signal.aborted) return;

  try {
    const { audio, contentType } = await fetchInworldReadAloudAudio(
      spoken,
      signal,
    );
    if (generation !== playbackGeneration || signal.aborted) return;

    const file = createAudioFile(audio, contentType);
    if (generation !== playbackGeneration || signal.aborted) {
      try {
        file.delete();
      } catch {

      }
      return;
    }

    if (!(await configurePlaybackAudioSession())) {
      try {
        file.delete();
      } catch {

      }
      return;
    }
    if (generation !== playbackGeneration || signal.aborted) {
      try {
        file.delete();
      } catch {

      }
      return;
    }
    const player = createAudioPlayer({ uri: file.uri });
    currentFile = file;
    currentPlayer = player;

    player.addListener("playbackStatusUpdate", (status) => {
      if (generation !== playbackGeneration) return;
      if (status.didJustFinish) setPlaybackState(null);
    });
    setPlaybackState({ messageId: id, status: "playing" });
    player.play();
  } catch (error) {
    if (generation === playbackGeneration && !signal.aborted) {
      setPlaybackState(null);
      console.warn("[read-aloud] playback failed", error);
    }
  }
}

async function tryStreamReply(
  text: string,
  id: string | null,
  generation: number,
  signal: AbortSignal,
): Promise<boolean> {
  const ticket = await prepareInworldReadAloudStream(text, signal);
  if (generation !== playbackGeneration || signal.aborted) {

    cancelStreamSession(ticket);
    return true;
  }

  assert(env.convexSiteUrl, "EXPO_PUBLIC_CONVEX_SITE_URL is not configured.");
  const token = await getConvexToken();

  const uri = `${env.convexSiteUrl}${ttsStreamHlsPlaylistPath(ticket)}`;

  if (!(await configurePlaybackAudioSession())) {
    cancelStreamSession(ticket);
    return true;
  }
  if (generation !== playbackGeneration || signal.aborted) {
    cancelStreamSession(ticket);
    return true;
  }

  currentStreamTicket = ticket;
  return await playHlsResilient(uri, token, id, generation, 0);
}

async function playHlsResilient(
  uri: string,
  token: string,
  id: string | null,
  generation: number,
  startAt: number,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let decided = false;
    let started = false;
    let finished = false;
    let recovering = false;
    let recoverAttempts = 0;
    let startRetries = 0;
    let lastTime = 0;
    let lastProgressAt = Date.now();
    let expectedDur = 0;
    let player: AudioPlayer | null = null;

    const superseded = () => generation !== playbackGeneration;

    const decide = (result: boolean) => {
      if (decided) return;
      decided = true;
      clearTimeout(startTimer);
      resolve(result);
    };

    const dropPlayer = (p: AudioPlayer | null) => {
      if (!p) return;
      if (currentPlayer === p) currentPlayer = null;
      try {
        p.pause();
        p.remove();
        p.release();
      } catch {

      }
    };

    const fallback = () => {
      clearHlsWatchdog();
      const p = player;
      player = null;
      dropPlayer(p);
      const t = currentStreamTicket;
      currentStreamTicket = null;
      if (t) cancelStreamSession(t);
      decide(false);
    };

    const finishOk = () => {
      finished = true;
      clearHlsWatchdog();
      hlsResume = null;
      const p = player;
      player = null;
      dropPlayer(p);
      if (!superseded()) setPlaybackState(null);
      decide(true);
    };

    const giveUp = () => {
      finished = true;
      clearHlsWatchdog();
      const p = player;
      player = null;
      dropPlayer(p);
      if (!started) {

        fallback();
        return;
      }

      if (!superseded()) {
        hlsResume = { uri, token, id, at: Math.max(lastTime, 0) };
        setPlaybackState({ messageId: id, status: "paused" });
        console.warn(
          `[read-aloud] progressive playback stopped at ${lastTime.toFixed(
            1,
          )}s of ${expectedDur.toFixed(1)}s after ${recoverAttempts} recovery attempts`,
        );
      }
      decide(true);
    };

    const scheduleAttach = (at: number, backoff: number) => {
      setTimeout(() => {
        recovering = false;
        if (finished || superseded()) {
          decide(true);
          return;
        }
        lastProgressAt = Date.now();
        attach(at);
      }, backoff);
    };

    const recover = () => {
      if (finished || superseded() || recovering) return;
      recovering = true;
      const p = player;
      player = null;
      dropPlayer(p);
      if (recoverAttempts >= HLS_MAX_RECOVER_ATTEMPTS) {
        giveUp();
        return;
      }
      recoverAttempts += 1;
      scheduleAttach(Math.max(lastTime, 0), HLS_RECOVER_BACKOFF_MS);
    };

    const retryStart = () => {
      if (decided || started || finished || superseded() || recovering) return;
      recovering = true;
      const p = player;
      player = null;
      dropPlayer(p);
      if (startRetries >= HLS_MAX_START_RETRIES) {
        recovering = false;
        fallback();
        return;
      }
      startRetries += 1;
      scheduleAttach(0, HLS_START_RETRY_BACKOFF_MS);
    };

    const attach = (at: number) => {
      if (finished || superseded()) {
        decide(true);
        return;
      }
      const p = createAudioPlayer({
        uri,
        headers: { Authorization: `Bearer ${token}` },
      });
      player = p;
      currentPlayer = p;
      currentFile = null;
      let seeked = at <= 0.25;
      p.addListener("playbackStatusUpdate", (status) => {
        if (player !== p) return;
        if (superseded()) {
          clearHlsWatchdog();
          return;
        }
        if (!seeked && (status.isLoaded || status.duration > 0)) {
          seeked = true;
          p.seekTo(at)
            .then(() => p.play())
            .catch(() => {
              try {
                p.play();
              } catch {

              }
            });
        }
        if (
          typeof status.duration === "number" &&
          status.duration > expectedDur
        ) {
          expectedDur = status.duration;
        }
        const t =
          typeof status.currentTime === "number" ? status.currentTime : 0;
        if (t > lastTime + 0.05) {
          lastTime = t;
          lastProgressAt = Date.now();
        }
        if (!started && (status.playing || t > 0.01)) {
          started = true;
          setPlaybackState({ messageId: id, status: "playing" });
          decide(true);
        }
        if (status.didJustFinish) {

          if (
            expectedDur > 0 &&
            lastTime < expectedDur - HLS_PREMATURE_EPS_SEC
          ) {
            recover();
          } else {
            finishOk();
          }
          return;
        }
        const stateStr = (status.playbackState ?? "").toLowerCase();
        const errored =
          stateStr.includes("error") ||
          stateStr.includes("fail") ||
          status.mediaServicesDidReset === true;
        if (errored) {
          if (started) recover();
          else retryStart();
        }
      });
      if (at <= 0.25) {
        try {
          p.play();
        } catch {

        }
      }
    };

    clearHlsWatchdog();
    hlsWatchdog = setInterval(() => {
      if (finished || superseded() || !started || recovering) return;
      if (playbackState?.status === "paused") {
        lastProgressAt = Date.now();
        return;
      }
      const stalledFor = Date.now() - lastProgressAt;
      const moreExpected =
        expectedDur === 0 || lastTime < expectedDur - HLS_PREMATURE_EPS_SEC;
      if (stalledFor > HLS_STALL_TIMEOUT_MS && moreExpected) recover();
    }, HLS_WATCHDOG_INTERVAL_MS);

    const startTimer = setTimeout(() => {
      if (superseded()) {
        decide(true);
        return;
      }
      if (!started) {

        fallback();
      }
    }, STREAM_START_TIMEOUT_MS);

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
