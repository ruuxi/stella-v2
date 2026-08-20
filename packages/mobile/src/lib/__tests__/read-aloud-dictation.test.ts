import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

(globalThis as Record<string, unknown>).__DEV__ = false;

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

type MockPlayer = {
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

const players: MockPlayer[] = [];
const files: Array<{ uri: string; deleted: boolean }> = [];
const fetchCalls: Array<{ url: string; aborted: boolean }> = [];
let configurePlayback: () => Promise<boolean> = async () => true;
let fetchImpl: (
  url: string,
  init: RequestInit,
) => Promise<Response> = async () => {
  throw new Error("unexpected fetch");
};

mock.module("expo-audio", () => ({
  createAudioPlayer: () => {
    const listeners = new Set<(status: Record<string, unknown>) => void>();
    const player: MockPlayer = {
      play() {},
      pause() {},
      remove() {},
      release() {},
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

mock.module("expo-file-system", () => ({
  Paths: { cache: "cache" },
  File: class MockFile {
    uri: string;
    deleted = false;
    constructor(_dir: string, name: string) {
      this.uri = `file://${name}`;
      files.push(this);
    }
    create() {}
    write() {}
    delete() {
      this.deleted = true;
    }
  },
}));

mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  },
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

const audioResponse = (): Response =>
  ({
    ok: true,
    json: async () => ({}),
    text: async () => "",
    arrayBuffer: async () =>
      new Uint8Array([0xff, 0xe0, 0x00, 0x00]).buffer,
    headers: new Headers({ "content-type": "audio/mpeg" }),
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
  files.length = 0;
  fetchCalls.length = 0;
  configurePlayback = async () => true;
  fetchImpl = async () => {
    throw new Error("unexpected fetch");
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, aborted: Boolean(init?.signal?.aborted) });
    return withAbort(init, () => fetchImpl(url, init ?? {}));
  }) as typeof fetch;
  stopReadAloud();
});

afterEach(() => {
  stopReadAloud();
});

describe("mobile read-aloud stop on dictation", () => {
  test("is a no-op when nothing is playing and still starts dictation after", async () => {
    const order: string[] = [];
    expect(getReadAloudPlaybackState()).toBeNull();
    stopReadAloudForDictation();
    stopReadAloudForDictation();
    const started = await startAfterStoppingReadAloud(async () => {
      order.push(
        getReadAloudPlaybackState() === null ? "stopped" : "playing",
      );
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

  test("aborts buffered/streaming generation before a ticket or clip can land", async () => {
    const prepare = deferred<Response>();
    fetchImpl = async (url) => {
      if (url.includes("/api/voice/tts/stream/prepare")) {
        return prepare.promise;
      }
      if (url.includes("/api/voice/tts/stream/cancel")) {
        return jsonResponse({ ok: true });
      }
      if (url.includes("/api/voice/tts")) {
        return audioResponse();
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
      if (url.includes("/api/voice/tts")) {
        return audioResponse();
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

  test("ignores a late buffered clip after dictation begins", async () => {
    const audio = deferred<Response>();
    fetchImpl = async (url) => {
      if (url.includes("/api/voice/tts/stream/prepare")) {
        return failResponse("stream unavailable");
      }
      if (url.includes("/api/voice/tts")) {
        return audio.promise;
      }
      throw new Error(url);
    };

    const speaking = speakReply("buffered fallback", "msg-3");
    await waitFor(
      () => getReadAloudPlaybackState()?.status === "loading",
      "expected loading before buffered audio",
    );

    await startAfterStoppingReadAloud(async () => true);
    audio.resolve(audioResponse());
    await speaking;

    expect(getReadAloudPlaybackState()).toBeNull();
    expect(players).toHaveLength(0);
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
