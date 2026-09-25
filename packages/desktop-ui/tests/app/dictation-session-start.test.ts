/**
 * Dictation start latency: the microphone must go live while the relay is
 * still connecting, and audio captured meanwhile must reach the relay once
 * it opens.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  type Deferred = {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
  };
  const deferred = (): Deferred => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  class FakeDictationStream {
    sent: Int16Array[] = [];
    opening = deferred();
    cancelled = false;
    finished = false;
    constructor() {
      control.streams.push(this);
    }
    open() {
      return this.opening.promise;
    }
    send(pcm: Int16Array) {
      this.sent.push(pcm);
    }
    async finish() {
      this.finished = true;
      return "hello world";
    }
    cancel() {
      this.cancelled = true;
    }
  }

  const control = {
    streams: [] as FakeDictationStream[],
    released: 0,
    worklet: null as null | {
      port: { onmessage: ((event: { data: Float32Array }) => void) | null };
    },
  };
  return { control, FakeDictationStream };
});

vi.mock("@/features/dictation/services/dictation-stream", () => ({
  DictationStream: fake.FakeDictationStream,
}));

vi.mock("@/features/voice/services/shared-microphone", () => ({
  acquireSharedMicrophone: async () => ({
    stream: {},
    release: () => {
      fake.control.released += 1;
    },
  }),
  setSharedMicrophoneKeepWarm: async () => undefined,
}));

vi.mock("@/platform/ui-state", () => ({
  uiState: { getItem: () => null, setItem: () => undefined },
}));

import { DictationSession } from "@/features/dictation/services/dictation-session";

class FakeAudioContext {
  sampleRate = 16_000;
  audioWorklet = { addModule: async () => undefined };
  createMediaStreamSource() {
    return { connect: () => undefined, disconnect: () => undefined };
  }
  async close() {}
}

class FakeAudioWorkletNode {
  port = {
    onmessage: null as ((event: { data: Float32Array }) => void) | null,
    close: () => undefined,
  };
  constructor() {
    fake.control.worklet = this;
  }
  disconnect() {}
}

const emitAudio = (samples: number) => {
  fake.control.worklet?.port.onmessage?.({
    data: new Float32Array(samples).fill(0.1),
  });
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  fake.control.streams = [];
  fake.control.released = 0;
  fake.control.worklet = null;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
  vi.stubGlobal("window", { location: { href: "http://127.0.0.1/" } });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DictationSession start", () => {
  it("listens before the relay connects and flushes buffered audio on open", async () => {
    const session = new DictationSession();
    const states: string[] = [];
    await session.start({ onStateChange: (state) => states.push(state) });

    // The relay has not opened yet, but the mic is already recording.
    expect(states).toEqual(["listening"]);
    const stream = fake.control.streams[0]!;
    emitAudio(1_600);
    emitAudio(1_600);
    expect(stream.sent).toHaveLength(0);

    stream.opening.resolve();
    await flush();
    expect(stream.sent.map((chunk) => chunk.length)).toEqual([1_600, 1_600]);

    // Once connected, audio streams straight through.
    emitAudio(800);
    expect(stream.sent).toHaveLength(3);
  });

  it("finishes a recording stopped before the relay connected", async () => {
    const session = new DictationSession();
    const transcripts: string[] = [];
    await session.start({ onFinalTranscript: (t) => transcripts.push(t) });
    const stream = fake.control.streams[0]!;
    emitAudio(1_600);

    const stopping = session.stop();
    await flush();
    expect(stream.finished).toBe(false);

    stream.opening.resolve();
    await stopping;
    expect(stream.sent).toHaveLength(1);
    expect(stream.finished).toBe(true);
    expect(transcripts).toEqual(["hello world"]);
  });

  it("surfaces a relay failure that arrives while recording", async () => {
    const session = new DictationSession();
    const states: string[] = [];
    await session.start({ onStateChange: (state) => states.push(state) });

    fake.control.streams[0]!.opening.reject(new Error("Could not connect."));
    await flush();
    await flush();

    expect(states).toEqual(["listening", "error"]);
    expect(fake.control.released).toBe(1);
  });

  it("caps audio held while connecting", async () => {
    const session = new DictationSession();
    await session.start({});
    const stream = fake.control.streams[0]!;
    // 6 s of audio in 1 s frames; only the latest 4 s are kept.
    for (let i = 0; i < 6; i += 1) emitAudio(16_000);

    stream.opening.resolve();
    await flush();
    expect(stream.sent).toHaveLength(4);
  });
});
