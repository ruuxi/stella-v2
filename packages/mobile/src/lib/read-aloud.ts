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
// Safety net: if progressive playback has not begun within this window we
// abandon it and fall back to the one-shot buffered request.
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
let currentFile: File | null = null;
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

export function stopReadAloud() {
  playbackGeneration += 1;
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

    if (!(await configurePlaybackAudioSession())) {
      try {
        file.delete();
      } catch {
        /* ignore */
      }
      return;
    }
    if (generation !== playbackGeneration) {
      try {
        file.delete();
      } catch {
        /* ignore */
      }
      return;
    }
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

  if (!(await configurePlaybackAudioSession())) {
    cancelStreamSession(ticket);
    return true;
  }
  if (generation !== playbackGeneration) {
    cancelStreamSession(ticket);
    return true;
  }

  currentStreamTicket = ticket;
  return await playHlsResilient(uri, token, id, generation, 0);
}

// Drive resilient progressive HLS playback for the life of one read-aloud.
//
// Native players give up on a segment/playlist fetch that keeps failing past
// their small internal retry budget, which shows up as playback stalling and
// then stopping partway through the message. This controller detects that (an
// error state, a failed-to-finish, or a prolonged lack of progress) and
// recovers by recreating the player and seeking back to the last played
// position — reusing the server-cached segments, so there is no re-synthesis,
// no restart from the beginning, and no double-counted cost. It also retries a
// pre-audible failure (e.g. an empty first playlist while the first segment is
// still being synthesized) before conceding to the buffered fallback, and
// verifies an end-of-stream actually reached the known duration so a premature
// stop is never presented as a clean finish.
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

    // Release a player without touching the backend session (kept so a retry can
    // re-fetch the still-cached segments).
    const dropPlayer = (p: AudioPlayer | null) => {
      if (!p) return;
      if (currentPlayer === p) currentPlayer = null;
      try {
        p.pause();
        p.remove();
        p.release();
      } catch {
        /* ignore */
      }
    };

    // Concede progressive playback before it ever became audible: end the
    // background synthesis (so it does not keep spending unheard) and let the
    // caller fall back to the one-shot buffered clip.
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
        // Never became audible → let the caller fall back to the buffered clip.
        fallback();
        return;
      }
      // Started but could not be recovered. Surface a stopped (not finished)
      // state and remember where we were so the user can resume from the cached
      // segments, rather than the truncated clip being presented as complete.
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

    // A mid-stream stall/error: recreate the player and resume in place.
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

    // A pre-audible failure (e.g. empty first playlist): retry a few times before
    // conceding to the buffered fallback.
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
        if (player !== p) return; // stale listener from a replaced player
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
                /* ignore */
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
          // Only a finish that actually reached the known end is a clean finish;
          // a short one is a premature stop to recover from.
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
          /* ignore */
        }
      }
    };

    // Stall watchdog: if playback is expected to progress but has not for a
    // while (and the user has not paused), recover.
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
        // Never became audible in time → tear down and fall back.
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
