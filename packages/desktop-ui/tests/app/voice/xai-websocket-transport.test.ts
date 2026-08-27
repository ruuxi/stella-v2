import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const audioMocks = vi.hoisted(() => ({
  order: [] as string[],
  micDispose: vi.fn<() => Promise<void>>(),
  playerDispose: vi.fn<() => Promise<void>>(),
}));

vi.mock(
  "@/features/voice/services/realtime/audio-pipeline/mic-capture",
  () => ({
    MicCapture: class {
      stop(): void {
        audioMocks.order.push("mic.stop");
      }

      detach(): void {
        audioMocks.order.push("mic.detach");
      }

      dispose(): Promise<void> {
        audioMocks.order.push("mic.dispose");
        return audioMocks.micDispose();
      }

      setSoftMute(): void {}

      getAnalyser(): null {
        return null;
      }

      start(): void {}

      attach(): void {}
    },
  }),
);

vi.mock("@/features/voice/services/realtime/audio-pipeline/pcm-player", () => ({
  PcmPlayer: class {
    dispose(): Promise<void> {
      audioMocks.order.push("player.dispose");
      return audioMocks.playerDispose();
    }

    flush(): void {}

    getAnalyser(): null {
      return null;
    }

    pushBase64Pcm16(): void {}
  },
}));

import { XaiWebSocketTransport } from "@/features/voice/services/realtime/transports/xai-websocket-transport";

type SocketListener = (event: {
  code?: number;
  data?: unknown;
  message?: string;
  reason?: string;
}) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readonly listeners = new Map<string, Set<SocketListener>>();
  readyState = FakeWebSocket.CONNECTING;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: SocketListener): void {
    const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: SocketListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    audioMocks.order.push("websocket.close");
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", { code: 1000, reason: "test close" });
  }

  send(): void {}

  private dispatch(type: string, event: Parameters<SocketListener>[0]): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

const createTransport = () =>
  new XaiWebSocketTransport({
    clientSecret: "client-secret",
    model: "grok-voice",
    voice: "ara",
  });

const noOpEvents = {
  onEvent: vi.fn(),
  onClose: vi.fn(),
};

describe("XaiWebSocketTransport teardown", () => {
  beforeEach(() => {
    audioMocks.order.length = 0;
    audioMocks.micDispose.mockReset().mockResolvedValue();
    audioMocks.playerDispose.mockReset().mockResolvedValue();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("closes a CONNECTING socket before awaiting audio cleanup", async () => {
    let resolveMicDispose!: () => void;
    audioMocks.micDispose.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveMicDispose = resolve;
        }),
    );

    const transport = createTransport();
    const connectOutcome = transport.connect(noOpEvents).then(
      () => null,
      (error: unknown) => error,
    );
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.readyState).toBe(
      FakeWebSocket.CONNECTING,
    );

    const disconnectPromise = transport.disconnect();

    expect(audioMocks.order).toEqual([
      "websocket.close",
      "mic.stop",
      "mic.detach",
      "mic.dispose",
    ]);
    expect(audioMocks.playerDispose).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances[0]?.readyState).toBe(FakeWebSocket.CLOSED);

    resolveMicDispose();
    await disconnectPromise;
    expect(audioMocks.order).toContain("player.dispose");
    expect(audioMocks.order.indexOf("player.dispose")).toBeGreaterThan(
      audioMocks.order.indexOf("mic.dispose"),
    );
    await expect(connectOutcome).resolves.toBeInstanceOf(Error);
  });

  it("closes and rejects a socket that has not opened within 8 seconds", async () => {
    vi.useFakeTimers();
    const transport = createTransport();
    const connectOutcome = transport.connect(noOpEvents).then(
      () => null,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(7_999);
    expect(audioMocks.order).not.toContain("websocket.close");

    await vi.advanceTimersByTimeAsync(1);
    expect(audioMocks.order).toEqual(["websocket.close"]);
    await expect(connectOutcome).resolves.toMatchObject({
      message: "Timed out opening xAI realtime WebSocket after 8 seconds",
    });

    await transport.disconnect();
    expect(
      audioMocks.order.filter((step) => step === "websocket.close"),
    ).toHaveLength(1);
  });
});
