/**
 * Warm relay sockets: a mic hover connects ahead of the press, and the press
 * reuses that socket and only then asks the relay to start a session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/global/auth/services/auth-token", () => ({
  getConvexToken: async () => "jwt-fixture",
}));
vi.mock("@/platform/http/service-request", () => ({
  postServiceJson: async () => ({
    relayOrigin: "https://relay.fixture",
    modelId: "muse",
  }),
}));
vi.mock("@/platform/interior/interior-bridge", () => ({
  getStellaInteriorBridge: () => null,
}));

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeWebSocket.instances.push(this);
  }
  accept() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dictation relay warm socket", () => {
  it("reuses the hover-warmed socket and starts the session on press", async () => {
    const { warmDictationSocket, DictationStream } = await import(
      "@/features/dictation/services/dictation-stream"
    );
    warmDictationSocket();
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const warm = FakeWebSocket.instances[0]!;
    expect(warm.url).toBe(
      "wss://relay.fixture/dictation/socket?start=deferred",
    );
    expect(warm.protocols).toEqual(["stella.v1", "stella.token.jwt-fixture"]);
    warm.accept();
    await flush();
    // Nothing is reserved while warm.
    expect(warm.sent).toEqual([]);

    const stream = new DictationStream();
    await stream.open();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(warm.sent).toEqual([JSON.stringify({ type: "start" })]);
  });

  it("connects fresh when nothing is warm", async () => {
    const { DictationStream } = await import(
      "@/features/dictation/services/dictation-stream"
    );
    const stream = new DictationStream();
    const opening = stream.open();
    await flush();
    FakeWebSocket.instances[0]!.accept();
    await opening;
    expect(FakeWebSocket.instances[0]!.sent).toEqual([
      JSON.stringify({ type: "start" }),
    ]);
  });

  it("reports a relay that ends the session while recording", async () => {
    const { DictationStream } = await import(
      "@/features/dictation/services/dictation-stream"
    );
    const failures: string[] = [];
    const stream = new DictationStream(undefined, (error) =>
      failures.push(error.message),
    );
    const opening = stream.open();
    await flush();
    const socket = FakeWebSocket.instances[0]!;
    socket.accept();
    await opening;
    socket.onmessage?.({
      data: JSON.stringify({ type: "error", message: "Usage limit reached." }),
    });
    socket.close(1008, "Dictation usage limit reached");
    expect(failures).toEqual(["Usage limit reached."]);
  });
});
