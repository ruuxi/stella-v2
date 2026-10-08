import { backendClient } from "@/platform/backend/backend-client";
import type { MediaJob } from "@stella/contracts/backend/media";
import { STELLA_MEDIA_MODELS } from "@stella/contracts/media-models";
import { generateMusicPrompt, type MusicMood } from "@/prompts/music";
import { maybeShowPaidMediaTierToast } from "@/global/billing/paid-media-tier-toast";

export type { MusicMood } from "@/prompts/music";
export type MusicServiceState = {
  status: "idle" | "loading" | "playing" | "paused" | "error";
  mood: MusicMood;
  error: string | null;
  currentPromptLabel: string;
  elapsedSeconds: number;
  userHint: string;
  lyrics: boolean;
};

type StateListener = (state: MusicServiceState) => void;

let listeners: StateListener[] = [];

let state: MusicServiceState = {
  status: "idle",
  mood: "Auto",
  error: null,
  currentPromptLabel: "",
  elapsedSeconds: 0,
  userHint: "",
  lyrics: false,
};

let audioContext: AudioContext | null = null;
let masterGain: GainNode | null = null;
let analyserNode: AnalyserNode | null = null;
let currentSource: AudioBufferSourceNode | null = null;

let elapsedTimer: ReturnType<typeof setInterval> | null = null;
let playbackGeneration = 0;
let targetVolume = 1.0;
let intentionallyStopped = false;

function logMusic(
  message: string,
  details?: Record<string, unknown>,
  level: "log" | "warn" | "error" = "log",
) {
  const prefix = "[lyria-music]";
  if (level === "error") {
    console.error(prefix, message, details ?? {});
  } else if (level === "warn") {
    console.warn(prefix, message, details ?? {});
  } else {
    console.log(prefix, message, details ?? {});
  }
}

function emit() {
  for (const fn of listeners) fn(state);
}

function setState(patch: Partial<MusicServiceState>) {
  state = { ...state, ...patch };
  emit();
}

export function subscribe(listener: StateListener): () => void {
  listeners.push(listener);
  listener(state);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

export function getState(): MusicServiceState {
  return state;
}

function ensureAudioGraph(): {
  ctx: AudioContext;
  gain: GainNode;
  analyser: AnalyserNode;
} {
  if (!audioContext) {
    audioContext = new AudioContext();

    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;
    analyserNode.smoothingTimeConstant = 0.8;
    analyserNode.connect(audioContext.destination);

    masterGain = audioContext.createGain();
    masterGain.gain.value = targetVolume;
    masterGain.connect(analyserNode);
  }

  return { ctx: audioContext, gain: masterGain!, analyser: analyserNode! };
}

export function getAnalyser(): AnalyserNode | null {
  return analyserNode;
}

function startElapsedTimer() {
  stopElapsedTimer();
  elapsedTimer = setInterval(() => {
    setState({ elapsedSeconds: state.elapsedSeconds + 1 });
  }, 1000);
}

function stopElapsedTimer() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

function stopCurrentSource() {
  if (!currentSource) {
    return;
  }

  try {
    currentSource.onended = null;
    currentSource.stop();
  } catch {
    // Source may already be stopped.
  }

  try {
    currentSource.disconnect();
  } catch {
    // Ignore disconnect failures.
  }

  currentSource = null;
}

function fadeOutAudio() {
  if (!audioContext || !masterGain) {
    stopCurrentSource();
    return;
  }

  const now = audioContext.currentTime;
  masterGain.gain.cancelScheduledValues(now);
  masterGain.gain.setValueAtTime(masterGain.gain.value, now);
  masterGain.gain.linearRampToValueAtTime(0, now + 0.2);

  window.setTimeout(() => {
    stopCurrentSource();
    if (masterGain && audioContext) {
      masterGain.gain.setValueAtTime(targetVolume, audioContext.currentTime);
    }
  }, 250);
}

const TERMINAL = new Set(["succeeded", "failed", "canceled"]);

/** Run the music model on `prompt` and wait for its clip: the clip's URL and any lyrics. */
async function generateClip(
  prompt: string,
): Promise<{ url: string; lyrics: string | null }> {
  const accepted = await backendClient.call("media.generate", {
    model: STELLA_MEDIA_MODELS.music,
    input: { prompt },
  });
  const job = await new Promise<MediaJob>((resolve, reject) => {
    let settled = false;
    let stop: (() => void) | null = null;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      finish();
      // The first value can arrive before `watch` returns.
      queueMicrotask(() => stop?.());
    };
    stop = backendClient.watch(
      "media.job",
      { jobId: accepted.jobId },
      (value) => {
        if (!value || !TERMINAL.has(value.status)) return;
        settle(() =>
          value.status === "succeeded"
            ? resolve(value)
            : reject(new Error(value.error?.message ?? "Music generation failed.")),
        );
      },
      (error) => settle(() => reject(error)),
    );
  });
  const output = (job.output ?? {}) as {
    audio?: { url?: unknown };
    lyrics?: unknown;
  };
  const url = typeof output.audio?.url === "string" ? output.audio.url : null;
  if (!url) throw new Error("Music generation returned no audio.");
  return {
    url,
    lyrics: typeof output.lyrics === "string" && output.lyrics.trim() ? output.lyrics : null,
  };
}

async function playGeneratedAudio(
  clip: { url: string; lyrics: string | null },
  label: string,
  generation: number,
): Promise<void> {
  const { ctx, gain } = ensureAudioGraph();
  if (ctx.state === "suspended") {
    await ctx.resume();
  }

  gain.gain.cancelScheduledValues(ctx.currentTime);
  gain.gain.setValueAtTime(targetVolume, ctx.currentTime);

  stopCurrentSource();

  const response = await fetch(clip.url);
  if (!response.ok) {
    throw new Error(`Failed to download generated music (${response.status})`);
  }
  const decoded = await ctx.decodeAudioData(await response.arrayBuffer());
  if (generation !== playbackGeneration) {
    return;
  }

  const source = ctx.createBufferSource();
  source.buffer = decoded;
  source.connect(gain);
  currentSource = source;

  source.onended = () => {
    if (currentSource !== source) {
      return;
    }
    currentSource = null;
    stopElapsedTimer();
    if (!intentionallyStopped && generation === playbackGeneration) {
      setState({
        status: "idle",
        error: null,
        currentPromptLabel: "",
        elapsedSeconds: 0,
      });
    }
  };

  source.start(0);
  startElapsedTimer();
  setState({
    status: "playing",
    error: null,
    currentPromptLabel: label || state.currentPromptLabel,
    elapsedSeconds: 0,
  });

  logMusic("Started generated music playback.", {
    durationSeconds: decoded.duration,
    lyrics: clip.lyrics !== null,
  });
}

export async function play(): Promise<void> {
  const generation = ++playbackGeneration;
  intentionallyStopped = false;
  stopElapsedTimer();
  stopCurrentSource();

  setState({
    status: "loading",
    error: null,
    elapsedSeconds: 0,
  });
  logMusic("Starting music generation request.", {
    mood: state.mood,
    lyrics: state.lyrics,
    userHint: state.userHint,
  });

  try {
    const promptSet = await generateMusicPrompt(
      state.mood,
      null,
      state.userHint || null,
      state.lyrics,
    );

    if (generation !== playbackGeneration) {
      return;
    }

    const clip = await generateClip(promptSet.prompt);
    logMusic("Music generation finished.");
    if (generation !== playbackGeneration) {
      return;
    }

    setState({
      status: "loading",
      error: null,
      currentPromptLabel: promptSet.label,
      elapsedSeconds: 0,
    });

    await playGeneratedAudio(clip, promptSet.label, generation);
  } catch (error) {
    if (generation !== playbackGeneration) {
      return;
    }

    stopCurrentSource();
    stopElapsedTimer();
    logMusic(
      "Failed to generate or play music.",
      {
        message:
          error instanceof Error ? error.message : "Failed to start music",
      },
      "error",
    );
    maybeShowPaidMediaTierToast(error, "audio_generation");
    setState({
      status: "error",
      error: error instanceof Error ? error.message : "Failed to start music",
    });
  }
}

export async function pause(): Promise<void> {
  if (state.status !== "playing" || !audioContext) {
    return;
  }

  await audioContext.suspend();
  stopElapsedTimer();
  setState({ status: "paused" });
}

export async function resume(): Promise<void> {
  if (state.status !== "paused" || !audioContext) {
    return;
  }

  await audioContext.resume();
  startElapsedTimer();
  setState({ status: "playing" });
}

export function stop(): void {
  playbackGeneration += 1;
  intentionallyStopped = true;
  stopElapsedTimer();
  fadeOutAudio();

  setState({
    status: "idle",
    error: null,
    currentPromptLabel: "",
    elapsedSeconds: 0,
  });
}

export function setMood(mood: MusicMood): void {
  setState({ mood });
}

export function setVolume(volume: number): void {
  targetVolume = Math.max(0, Math.min(1, volume));
  if (masterGain && audioContext) {
    masterGain.gain.setTargetAtTime(
      targetVolume,
      audioContext.currentTime,
      0.05,
    );
  }
}

export function setUserHint(hint: string): void {
  setState({ userHint: hint });
}

export function setLyrics(enabled: boolean): void {
  setState({ lyrics: enabled });
}
