import { describe, expect, it } from "bun:test";
import {
  createMuseHandshake,
  isMuseEndStreamFrame,
} from "../src/muse-transcribe-socket.js";

describe("Muse transcription protocol", () => {
  it("builds the required realtime handshake", () => {
    expect(createMuseHandshake("meta-secret")).toEqual({
      authorization: { accessToken: "Bearer meta-secret" },
      audioEncoding: "PCM_16KHZ",
      model: "muse-voice-transcribe-1.0",
      mode: "PUSH_TO_TALK",
      partialMode: "CUMULATIVE",
      emitAudioProgress: false,
    });
  });

  it("only accepts a standalone endStream control frame", () => {
    expect(isMuseEndStreamFrame('{"type":"endStream"}')).toBe(true);
    expect(isMuseEndStreamFrame('{ "type": "endStream" }')).toBe(true);
    expect(isMuseEndStreamFrame('{"type":"endStream","audio":"x"}')).toBe(
      false,
    );
    expect(isMuseEndStreamFrame("endStream")).toBe(false);
  });
});

// Exercise the relay with in-memory transports; billing itself is covered by
// the Convex HTTP tests with real mutations and durable receipts.
describe("Muse relay settlement", () => {
  it.each(["frames", "silence"])(
    "enforces the receipt deadline during %s and retries usage only after upstream closes",
    async (mode) => {
      const { handleMuseTranscribeSocket } = await import(
        "../src/muse-transcribe-socket.js"
      );
      class Socket extends EventTarget {
        sent: unknown[] = [];
        closed = false;
        accept() {}
        send(value: unknown) {
          this.sent.push(value);
        }
        close() {
          this.closed = true;
        }
        emit(type: string, properties: Record<string, unknown>) {
          const event = new Event(type);
          Object.assign(event, properties);
          this.dispatchEvent(event);
        }
      }
      const upstream = new Socket();
      const gateway = new Socket();
      const client = new Socket();
      const originalFetch = globalThis.fetch;
      const originalResponse = globalThis.Response;
      const originalPair = Object.getOwnPropertyDescriptor(
        globalThis,
        "WebSocketPair",
      );
      const originalNow = Date.now;
      const pending: Promise<unknown>[] = [];
      const settlements: unknown[] = [];
      let now = originalNow();
      const deadline = now + (mode === "silence" ? 20 : 3_600_000);
      const fakeFetch = async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const url = String(input);
        if (url.endsWith("/prepare"))
          return originalResponse.json({
            sessionId: "muse_00000000-0000-0000-0000-000000000001",
            ownerGeneration: "legacy",
            providerDeadlineAt: deadline,
          });
        if (url.endsWith("/settle")) {
          settlements.push(JSON.parse(String(init?.body)));
          return originalResponse.json(
            {},
            { status: settlements.length === 1 ? 503 : 200 },
          );
        }
        return { status: 101, webSocket: upstream } as unknown as Response;
      };
      try {
        Date.now = () => now;
        globalThis.fetch = fakeFetch as typeof fetch;
        Object.defineProperty(globalThis, "WebSocketPair", {
          configurable: true,
          value: class {
            0 = client;
            1 = gateway;
          },
        });
        globalThis.Response = class extends originalResponse {
          constructor(body?: BodyInit | null, init?: ResponseInit) {
            super(body, init?.status === 101 ? { status: 200 } : init);
          }
        };
        await handleMuseTranscribeSocket({
          request: new Request("https://relay.test"),
          env: {
            META_MODEL_API_KEY: "test",
            BUILDER_SERVICE_SECRET: "test",
            STELLA_CONVEX_SITE_URL: "https://convex.test",
          },
          ownerId: "owner",
          waitUntil: (promise) => {
            pending.push(promise);
          },
        });
        gateway.emit("message", { data: new ArrayBuffer(32000) });
        expect(upstream.sent).toHaveLength(2);
        if (mode === "silence") {
          await new Promise((resolve) => setTimeout(resolve, 50));
        } else {
          now = deadline;
          gateway.emit("message", { data: new ArrayBuffer(32000) });
        }
        expect(upstream.closed).toBe(false);
        expect(upstream.sent).toHaveLength(3);
        expect(upstream.sent[2]).toBe(JSON.stringify({ type: "endStream" }));
        expect(settlements).toHaveLength(0);
        upstream.emit("close", { code: 1000, reason: "closed" });
        await Promise.all(pending);
        expect(settlements).toHaveLength(2);
        expect(settlements[0]).toEqual(settlements[1]);
        expect(settlements[0]).toMatchObject({
          audioBytes: 32000,
          success: true,
        });
        gateway.emit("message", { data: new ArrayBuffer(32000) });
        expect(upstream.sent).toHaveLength(3);
      } finally {
        Date.now = originalNow;
        globalThis.fetch = originalFetch;
        globalThis.Response = originalResponse;
        if (originalPair)
          Object.defineProperty(globalThis, "WebSocketPair", originalPair);
        else Reflect.deleteProperty(globalThis, "WebSocketPair");
      }
    },
  );
});
