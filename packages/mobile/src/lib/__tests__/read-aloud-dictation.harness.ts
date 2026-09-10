import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

(globalThis as Record<string, unknown>).__DEV__ = false;
const preferenceStore = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (key: string) => preferenceStore.get(key) ?? null,
    setItem: (key: string, value: string) => {
      preferenceStore.set(key, value);
    },
    removeItem: (key: string) => {
      preferenceStore.delete(key);
    },
  },
};

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

type MockPlayer = {
  released: boolean;
  play: () => void;
  pause: () => void;
  remove: () => void;
  release: () => void;
  seekTo: (at: number) => Promise<void>;
  addListener: (
    event: string,
    listener: (status: Record<string, unknown>) => void,
  ) => { remove: () => void };
  emit: (status: Record<string, unknown>) => void;
};

const alerts: unknown[][] = [];
mock.module("react-native", () => ({
  Alert: { alert: (...args: unknown[]) => alerts.push(args) },
}));
const playerSources: unknown[] = [];
const players: MockPlayer[] = [];
const fetchCalls: Array<{
  url: string;
  aborted: boolean;
  body: string | null;
}> = [];
let configurePlayback: () => Promise<boolean> = async () => true;
let uuidSequence = 0;
let fetchImpl: (
  url: string,
  init: RequestInit,
) => Promise<Response> = async () => {
  throw new Error("unexpected fetch");
};

mock.module("expo-audio", () => ({
  createAudioPlayer: (source: unknown) => {
    playerSources.push(source);
    const listeners = new Set<(status: Record<string, unknown>) => void>();
    const player: MockPlayer = {
      released: false,
      play() {},
      pause() {},
      remove() {},
      release() {
        this.released = true;
      },
      seekTo: async () => undefined,
      addListener(_event, listener) {
        listeners.add(listener);
        return {
          remove() {
            listeners.delete(listener);
          },
        };
      },
      emit(status) {
        for (const listener of listeners) listener(status);
      },
    };
    players.push(player);
    return player;
  },
}));

mock.module("expo-crypto", () => ({
  randomUUID: () =>
    `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, "0")}`,
}));

mock.module("../../config/env", () => ({
  env: { convexSiteUrl: "https://example.convex.site" },
}));

mock.module("../auth-token", () => ({
  getConvexToken: async () => "token",
}));

mock.module("../mobile-audio-session", () => ({
  configurePlaybackAudioSession: () => configurePlayback(),
}));

const {
  getReadAloudPlaybackState,
  resumeReadAloud,
  speakReply,
  startAfterStoppingReadAloud,
  stopReadAloud,
  stopReadAloudForDictation,
} = await import("../read-aloud");

const waitFor = async (predicate: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(label);
};

const jsonResponse = (body: unknown): Response =>
  ({
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: new Headers({ "content-type": "application/json" }),
  }) as Response;

const failResponse = (message: string): Response =>
  ({
    ok: false,
    json: async () => ({ error: message }),
    text: async () => message,
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: new Headers({ "content-type": "application/json" }),
  }) as Response;

const withAbort = (
  init: RequestInit | undefined,
  work: () => Promise<Response>,
) => {
  const signal = init?.signal;
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void work().then(
      (value) => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        resolve(value);
      },
      (error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
};

beforeEach(() => {
  players.length = 0;
  playerSources.length = 0;
  alerts.length = 0;
  fetchCalls.length = 0;
  configurePlayback = async () => true;
  fetchImpl = async () => {
    throw new Error("unexpected fetch");
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({
      url,
      aborted: Boolean(init?.signal?.aborted),
      body: typeof init?.body === "string" ? init.body : null,
    });
    return withAbort(init, () => fetchImpl(url, init ?? {}));
  }) as typeof fetch;
  stopReadAloud();
});

afterEach(() => {
  stopReadAloud();
});

describe("mobile read-aloud stop on dictation", () => {
  test("does not synthesize again when preparing the stream fails", async () => {
    fetchImpl = async () => failResponse("stream unavailable");
    await speakReply("one generation only", "msg-operation-id");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toContain("/stream/prepare");
    expect(getReadAloudPlaybackState()).toBeNull();
    expect(alerts).toHaveLength(1);
  });

  test("retries a failed initial player using the same audio and exposes retry after exhaustion", async () => {
    fetchImpl = async () => jsonResponse({ ticket: "ticket-retry" });
    const speaking = speakReply("recover existing audio", "msg-retry");
    await waitFor(() => players.length === 1, "expected initial player");
    for (let i = 0; i < 4; i += 1) {
      players[i]?.emit({ playbackState: "error", currentTime: 0 });
      if (i < 3) await new Promise((resolve) => setTimeout(resolve, 550));
    }
    await speaking;
    expect(players).toHaveLength(4);
    expect(players.every((player) => player.released)).toBe(true);
    expect(
      playerSources.every(
        (source) => JSON.stringify(source) === JSON.stringify(playerSources[0]),
      ),
    ).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(getReadAloudPlaybackState()?.status).toBe("paused");
    expect(alerts).toHaveLength(1);
    resumeReadAloud();
    await waitFor(
      () => players.length === 5,
      "expected retry of saved session",
    );
    players[4]?.emit({ currentTime: 0.2, duration: 3, playing: true });
    expect(getReadAloudPlaybackState()?.status).toBe("playing");
    expect(fetchCalls).toHaveLength(1);
  });

  test("a stalled player reloads instead of falling back to another synthesis", async () => {
    fetchImpl = async () => jsonResponse({ ticket: "ticket-stall" });
    const speaking = speakReply("no native status events", "msg-stall");
    await waitFor(() => players.length === 1, "expected initial player");
    // A native playing flag alone is not proof that audio has advanced.
    players[0]?.emit({ currentTime: 0, playing: true });
    expect(getReadAloudPlaybackState()?.status).toBe("loading");
    await new Promise((resolve) => setTimeout(resolve, 8700));
    expect(players).toHaveLength(2);
    expect(playerSources[1]).toEqual(playerSources[0]);
    players[1]?.emit({ currentTime: 0.2, playing: true });
    await speaking;
    expect(getReadAloudPlaybackState()?.status).toBe("playing");
    expect(fetchCalls).toHaveLength(1);
  }, 12000);

  test("cancel during a retry cannot resurrect the old player", async () => {
    fetchImpl = async () => jsonResponse({ ticket: "ticket-cancel" });
    const speaking = speakReply("cancel retry", "msg-cancel");
    await waitFor(() => players.length === 1, "expected initial player");
    players[0]?.emit({ playbackState: "error" });
    stopReadAloudForDictation();
    await speaking;
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(players).toHaveLength(1);
    expect(players[0]?.released).toBe(true);
    expect(getReadAloudPlaybackState()).toBeNull();
    expect(alerts).toHaveLength(0);
  });

  test("mid-stream recovery seeks to the last position without regenerating", async () => {
    fetchImpl = async () => jsonResponse({ ticket: "ticket-seek" });
    const speaking = speakReply("resume after interruption", "msg-seek");
    await waitFor(() => players.length === 1, "expected initial player");
    players[0]?.emit({ currentTime: 4, duration: 12, playing: true });
    await speaking;
    players[0]?.emit({ playbackState: "error", currentTime: 4 });
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(players).toHaveLength(2);
    const positions: number[] = [];
    players[1]!.seekTo = async (at) => {
      positions.push(at);
    };
    players[1]?.emit({ currentTime: 0, duration: 12, isLoaded: true });
    await Promise.resolve();
    expect(positions).toEqual([4]);
    players[1]?.emit({ currentTime: 4.2, duration: 12, playing: true });
    expect(getReadAloudPlaybackState()?.status).toBe("playing");
    expect(fetchCalls).toHaveLength(1);
    players[1]?.emit({ currentTime: 12, duration: 12, didJustFinish: true });
    expect(getReadAloudPlaybackState()).toBeNull();
  });

  test("is a no-op when nothing is playing and still starts dictation after", async () => {
    const order: string[] = [];
    expect(getReadAloudPlaybackState()).toBeNull();
    stopReadAloudForDictation();
    stopReadAloudForDictation();
    const started = await startAfterStoppingReadAloud(async () => {
      order.push(getReadAloudPlaybackState() === null ? "stopped" : "playing");
      return true;
    });
    expect(started).toBe(true);
    expect(order).toEqual(["stopped"]);
    expect(getReadAloudPlaybackState()).toBeNull();
    expect(players).toHaveLength(0);
  });

  test("stops active streaming playback when dictation starts", async () => {
    fetchImpl = async (url) => {
      if (url.includes("/api/voice/tts/stream/prepare")) {
        return jsonResponse({ ticket: "ticket-live" });
      }
      if (url.includes("/api/voice/tts/stream/cancel")) {
        return jsonResponse({ ok: true });
      }
      throw new Error(url);
    };

    const speaking = speakReply("hello from stella", "msg-1");
    await waitFor(() => players.length === 1, "expected HLS player");
    players[0]?.emit({ playing: true, currentTime: 0.2, duration: 12 });
    await waitFor(
      () => getReadAloudPlaybackState()?.status === "playing",
      "expected playing state",
    );

    const order: string[] = [];
    await startAfterStoppingReadAloud(async () => {
      order.push(getReadAloudPlaybackState()?.status ?? "idle");
      return "listening";
    });
    await speaking;

    expect(order).toEqual(["idle"]);
    expect(getReadAloudPlaybackState()).toBeNull();
    expect(players[0] ? 1 : 0).toBe(1);
    expect(fetchCalls.some((call) => call.url.includes("/stream/cancel"))).toBe(
      true,
    );
  });

  test("aborts streaming generation before a ticket can land", async () => {
    const prepare = deferred<Response>();
    fetchImpl = async (url) => {
      if (url.includes("/api/voice/tts/stream/prepare")) {
        return prepare.promise;
      }
      if (url.includes("/api/voice/tts/stream/cancel")) {
        return jsonResponse({ ok: true });
      }
      throw new Error(url);
    };

    const speaking = speakReply("not ready yet", "msg-2a");
    await waitFor(
      () => fetchCalls.some((call) => call.url.includes("/stream/prepare")),
      "expected prepare request",
    );

    stopReadAloudForDictation();
    prepare.resolve(jsonResponse({ ticket: "too-late" }));
    await speaking;

    expect(getReadAloudPlaybackState()).toBeNull();
    expect(players).toHaveLength(0);
    expect(fetchCalls.some((call) => call.url.endsWith("/api/voice/tts"))).toBe(
      false,
    );
  });

  test("cancels in-flight streaming generation so a late ticket cannot start audio", async () => {
    const configure = deferred<boolean>();
    let configureStarted = false;
    configurePlayback = () => {
      configureStarted = true;
      return configure.promise;
    };
    fetchImpl = async (url) => {
      if (url.includes("/api/voice/tts/stream/prepare")) {
        return jsonResponse({ ticket: "ticket-late" });
      }
      if (url.includes("/api/voice/tts/stream/cancel")) {
        return jsonResponse({ ok: true });
      }
      throw new Error(url);
    };

    const speaking = speakReply("still generating", "msg-2");
    await waitFor(
      () => configureStarted,
      "expected stream ticket to be held before playback",
    );

    stopReadAloudForDictation();
    expect(getReadAloudPlaybackState()).toBeNull();
    configure.resolve(true);
    await speaking;

    expect(getReadAloudPlaybackState()).toBeNull();
    expect(players).toHaveLength(0);
    expect(fetchCalls.some((call) => call.url.includes("/stream/cancel"))).toBe(
      true,
    );
  });

  test("ending dictation does not resume the prior clip, but a new one can start", async () => {
    fetchImpl = async (url) => {
      if (url.includes("/api/voice/tts/stream/prepare")) {
        return jsonResponse({ ticket: `ticket-${fetchCalls.length}` });
      }
      if (url.includes("/api/voice/tts/stream/cancel")) {
        return jsonResponse({ ok: true });
      }
      throw new Error(url);
    };

    const first = speakReply("first reply", "msg-4");
    await waitFor(() => players.length === 1, "expected first player");
    players[0]?.emit({ playing: true, currentTime: 1, duration: 8 });
    await waitFor(
      () => getReadAloudPlaybackState()?.status === "playing",
      "expected first clip playing",
    );

    stopReadAloudForDictation();
    await first;
    resumeReadAloud();
    expect(getReadAloudPlaybackState()).toBeNull();

    const second = speakReply("second reply", "msg-5");
    await waitFor(() => players.length === 2, "expected a new player");
    players[1]?.emit({ playing: true, currentTime: 0.1, duration: 4 });
    await waitFor(
      () => getReadAloudPlaybackState()?.messageId === "msg-5",
      "expected new clip",
    );
    await second;

    expect(getReadAloudPlaybackState()).toEqual({
      messageId: "msg-5",
      status: "playing",
    });
  });
});
