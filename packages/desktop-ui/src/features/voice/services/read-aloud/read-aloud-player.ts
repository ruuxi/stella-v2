/**
 * Read-aloud player — single-instance audio playback for the
 * "read finalized assistant replies" toggle and the per-message button.
 *
 * Two playback paths sit behind one "at most one active playback" invariant:
 *   - `playReadAloud(buffer)` — one-shot: decode a complete encoded buffer and
 *     play via Web Audio (OpenAI mp3, Inworld wav, or the streaming fallback).
 *   - `playReadAloudStream(response)` — progressive: play a chunked
 *     `audio/mpeg` response through Media Source Extensions so speech starts
 *     before Inworld has finished synthesizing the whole reply.
 *
 * Either path cancels the other so a fresh assistant turn never overlaps the
 * previous one's audio. `stop()` cancels playback without queuing anything;
 * `dispose()` tears everything down. Both leave the surface reusable.
 */

let context: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;
let currentStream: StreamPlayback | null = null;

const getContext = (): AudioContext => {
  if (context && context.state !== "closed") return context;
  context = new AudioContext();
  return context;
};

const stopWebAudio = () => {
  if (!currentSource) return;
  try {
    currentSource.onended = null;
    currentSource.stop();
  } catch {
    /* already stopped */
  }
  try {
    currentSource.disconnect();
  } catch {
    /* already disconnected */
  }
  currentSource = null;
};

const stopStream = () => {
  const stream = currentStream;
  currentStream = null;
  if (stream) {
    try {
      stream.teardown();
    } catch {
      /* already torn down */
    }
  }
};

const stopCurrent = () => {
  stopWebAudio();
  stopStream();
};

export type PlayOptions = {
  /** Called once playback ends naturally (not when interrupted by a new play). */
  onEnded?: () => void;
};

/**
 * Decode and play an encoded audio buffer. Resolves once playback has
 * begun; the optional `onEnded` callback fires at natural completion.
 */
export async function playReadAloud(
  encoded: ArrayBuffer,
  options: PlayOptions = {},
): Promise<void> {
  const ctx = getContext();
  if (ctx.state === "suspended") {
    await ctx.resume().catch(() => undefined);
  }

  // decodeAudioData detaches the buffer in newer browsers, so clone
  // once defensively to keep the input usable for callers that retain
  // a reference.
  const decoded = await ctx.decodeAudioData(encoded.slice(0));

  stopCurrent();

  const source = ctx.createBufferSource();
  source.buffer = decoded;
  source.connect(ctx.destination);

  // Capture this source so a subsequent play() only nulls ours if
  // we're still the active node.
  const thisSource = source;
  source.onended = () => {
    if (currentSource === thisSource) {
      currentSource = null;
    }
    options.onEnded?.();
  };

  currentSource = source;
  source.start();
}

// ---------------------------------------------------------------------------
// Progressive (streaming) playback via Media Source Extensions
// ---------------------------------------------------------------------------

const STREAM_MIME = "audio/mpeg";
// Keep only a few seconds of already-played audio buffered so a long reply
// cannot grow the SourceBuffer without bound.
const KEEP_BEHIND_SECONDS = 3;

type StreamPlayback = { teardown: () => void };

/**
 * Whether progressive read-aloud playback is available in this runtime.
 * MP3-in-MSE is supported in Chromium/Electron; the guard keeps a graceful
 * fallback to `playReadAloud` on any runtime that lacks it.
 */
export function canStreamReadAloud(): boolean {
  return (
    typeof MediaSource !== "undefined" &&
    typeof MediaSource.isTypeSupported === "function" &&
    MediaSource.isTypeSupported(STREAM_MIME)
  );
}

/**
 * Play a chunked `audio/mpeg` fetch response progressively.
 *
 * Resolves once playback has begun. Rejects if playback never starts (no
 * usable audio arrives / MSE errors before the first append) so the caller
 * can fall back to a one-shot request. After playback has started, a late
 * upstream error is treated as a natural end (fires `onEnded`).
 */
export async function playReadAloudStream(
  response: Response,
  options: PlayOptions = {},
): Promise<void> {
  if (!canStreamReadAloud()) {
    throw new Error("read-aloud streaming is not supported");
  }
  const body = response.body;
  if (!body) {
    throw new Error("read-aloud stream response has no body");
  }

  stopCurrent();

  const audio = new Audio();
  audio.autoplay = false;
  audio.preload = "auto";
  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  audio.src = objectUrl;

  const reader = body.getReader();
  const queue: Uint8Array[] = [];
  let sourceBuffer: SourceBuffer | null = null;
  let torn = false;
  let started = false;
  let readerDone = false;
  let endOfStreamSignaled = false;
  let forceEvict = false;

  const teardown = () => {
    if (torn) return;
    torn = true;
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      /* already released */
    }
    try {
      audio.pause();
    } catch {
      /* ignore */
    }
    try {
      if (sourceBuffer && mediaSource.readyState === "open") {
        sourceBuffer.abort();
      }
    } catch {
      /* ignore */
    }
    try {
      audio.removeAttribute("src");
      audio.load();
    } catch {
      /* ignore */
    }
    try {
      URL.revokeObjectURL(objectUrl);
    } catch {
      /* ignore */
    }
  };

  const playback: StreamPlayback = { teardown };
  currentStream = playback;

  return await new Promise<void>((resolve, reject) => {
    const detach = () => {
      if (currentStream === playback) currentStream = null;
    };

    const finishStart = () => {
      if (!started) {
        started = true;
        resolve();
      }
    };

    const fail = (error: unknown) => {
      const wasStarted = started;
      detach();
      teardown();
      if (wasStarted) {
        // Already audible — treat a late failure as a natural end.
        options.onEnded?.();
      } else {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const needsEvict = (): boolean => {
      if (!sourceBuffer || sourceBuffer.buffered.length === 0) return false;
      const start = sourceBuffer.buffered.start(0);
      const removeEnd = audio.currentTime - KEEP_BEHIND_SECONDS;
      return removeEnd > start + 0.5;
    };

    // Runs exactly one SourceBuffer operation (remove or append) per idle
    // cycle; each operation's `updateend` re-enters this pump.
    const pump = () => {
      if (torn || !sourceBuffer || sourceBuffer.updating) return;

      if (forceEvict || needsEvict()) {
        forceEvict = false;
        try {
          const start = sourceBuffer.buffered.start(0);
          const removeEnd = Math.max(
            start,
            audio.currentTime - KEEP_BEHIND_SECONDS,
          );
          if (removeEnd > start) {
            sourceBuffer.remove(start, removeEnd);
            return;
          }
        } catch {
          /* fall through to append */
        }
      }

      const chunk = queue.shift();
      if (chunk) {
        try {
          sourceBuffer.appendBuffer(chunk as BufferSource);
        } catch (error) {
          if ((error as DOMException)?.name === "QuotaExceededError") {
            // Buffer full: put the chunk back and evict played audio first.
            queue.unshift(chunk);
            forceEvict = true;
            pump();
            return;
          }
          fail(error);
        }
        return;
      }

      if (readerDone && !endOfStreamSignaled) {
        endOfStreamSignaled = true;
        try {
          if (mediaSource.readyState === "open") mediaSource.endOfStream();
        } catch {
          /* ignore */
        }
      }
    };

    const readLoop = async () => {
      try {
        while (!torn) {
          const { done, value } = await reader.read();
          if (torn) return;
          if (done) {
            readerDone = true;
            pump();
            return;
          }
          if (value && value.length > 0) {
            queue.push(value);
            pump();
          }
        }
      } catch (error) {
        if (!torn) fail(error);
      }
    };

    audio.onended = () => {
      detach();
      teardown();
      options.onEnded?.();
    };
    audio.onerror = () => fail(new Error("read-aloud audio element error"));

    mediaSource.addEventListener(
      "sourceopen",
      () => {
        if (torn) return;
        try {
          sourceBuffer = mediaSource.addSourceBuffer(STREAM_MIME);
        } catch (error) {
          fail(error);
          return;
        }
        sourceBuffer.addEventListener("updateend", () => {
          if (torn) return;
          if (!started && sourceBuffer && sourceBuffer.buffered.length > 0) {
            void audio
              .play()
              .then(finishStart)
              .catch(() => finishStart());
          }
          pump();
        });
        void readLoop();
      },
      { once: true },
    );

    // If the element errors while wiring up the MediaSource, surface it.
    if (mediaSource.readyState === "closed") {
      // Normal: sourceopen fires after src assignment. No-op guard for lint.
    }
  });
}

export function stopReadAloud(): void {
  stopCurrent();
}

export function disposeReadAloud(): void {
  stopCurrent();
  if (context) {
    context.close().catch(() => undefined);
    context = null;
  }
}

export function isReadAloudPlaying(): boolean {
  return currentSource !== null || currentStream !== null;
}
