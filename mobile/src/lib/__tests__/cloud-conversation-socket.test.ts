import { describe, expect, test } from "bun:test";
import {
  CloudConversationSocket,
  type CloudConversationSocketEvent,
} from "../cloud-conversation-socket";

const NativeWebSocket = globalThis.WebSocket;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  static nextReadyState = FakeWebSocket.OPEN;
  readyState = FakeWebSocket.nextReadyState;
  closeCalls = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(value: string) {
    this.sent.push(value);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  emit(value: object) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

const withFakeWebSocket = async (run: () => Promise<void>) => {
  globalThis.WebSocket =
    FakeWebSocket as unknown as typeof globalThis.WebSocket;
  try {
    await run();
  } finally {
    globalThis.WebSocket = NativeWebSocket;
    FakeWebSocket.instances = [];
    FakeWebSocket.nextReadyState = FakeWebSocket.OPEN;
  }
};

const readyFrame = (overrides: Record<string, unknown> = {}) => ({
  type: "ready",
  protocol: 1,
  conversationId: "conversation-1",
  epoch: 1,
  headSeq: -1,
  windowStartSeq: 0,
  floorSeq: 0,
  authExpiresAtMs: Date.now() + 3_600_000,
  serverTimeMs: Date.now(),
  live: null,
  ...overrides,
});

describe("CloudConversationSocket", () => {
  test("repairs a durable sequence gap before exposing the ahead record", async () => {
    await withFakeWebSocket(async () => {
      const events: CloudConversationSocketEvent[] = [];
      const socket = new CloudConversationSocket({
        conversationId: "conversation-1",
        baseUrl: "https://builder.example",
        getToken: async () => "header.payload.signature",
        isActive: () => true,
        onEvent: (event) => events.push(event),
      });
      socket.start();
      await Promise.resolve();
      const ws = FakeWebSocket.instances[0]!;
      ws.emit(readyFrame({
        headSeq: 3,
        windowStartSeq: 1,
      }));
      ws.emit({
        type: "record",
        kind: "message",
        seq: 1,
        turnId: "turn",
        createdAtMs: 1,
        role: "user",
        hidden: false,
        payload: { content: "hello" },
      });
      ws.emit({
        type: "record",
        kind: "message",
        seq: 3,
        turnId: "turn",
        createdAtMs: 3,
        role: "assistant",
        hidden: false,
        payload: { content: "ahead" },
      });

      const request = ws.sent
        .map((value) => JSON.parse(value) as Record<string, unknown>)
        .find((value) => value.type === "backfill")!;
      expect(request.fromSeq).toBe(2);
      expect(request.toSeq).toBe(2);
      ws.emit({
        type: "backfill",
        requestId: request.requestId,
        fromSeq: 2,
        toSeq: 2,
        complete: true,
        records: [
          {
            kind: "turn",
            seq: 2,
            turnId: "turn",
            createdAtMs: 2,
            phase: "started",
          },
        ],
      });

      expect(
        events
          .filter((event) => event.type === "records")
          .flatMap((event) => event.records.map((record) => record.seq)),
      ).toEqual([1, 2, 3]);
      socket.stop();
    });
  });

  test("uses the protocol cancel frame for the active turn", async () => {
    await withFakeWebSocket(async () => {
      const socket = new CloudConversationSocket({
        conversationId: "conversation-1",
        baseUrl: "wss://builder.example",
        getToken: async () => "header.payload.signature",
        isActive: () => true,
        onEvent: () => undefined,
      });
      socket.start();
      await Promise.resolve();
      FakeWebSocket.instances[0]!.emit(readyFrame());
      expect(socket.cancelTurn("turn-1")).toBe(true);
      expect(
        JSON.parse(FakeWebSocket.instances[0]!.sent.at(-1) ?? "{}"),
      ).toEqual({ type: "cancel", turnId: "turn-1" });
      socket.stop();
    });
  });

  test("does not create an orphan socket when wake or retry runs during CONNECTING", async () => {
    await withFakeWebSocket(async () => {
      FakeWebSocket.nextReadyState = FakeWebSocket.CONNECTING;
      const socket = new CloudConversationSocket({
        conversationId: "conversation-1",
        baseUrl: "wss://builder.example",
        getToken: async () => "header.payload.signature",
        isActive: () => true,
        onEvent: () => undefined,
      });
      socket.start();
      await Promise.resolve();
      const first = FakeWebSocket.instances[0]!;

      socket.wake();
      socket.retry();
      await Promise.resolve();

      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(first.closeCalls).toBe(0);
      socket.stop();
      expect(first.closeCalls).toBe(1);
    });
  });

  test("queues a pre-ready cancel and resends it after an offline reconnect", async () => {
    await withFakeWebSocket(async () => {
      const socket = new CloudConversationSocket({
        conversationId: "conversation-1",
        baseUrl: "wss://builder.example",
        getToken: async () => "header.payload.signature",
        isActive: () => true,
        onEvent: () => undefined,
      });
      socket.start();
      await Promise.resolve();
      const first = FakeWebSocket.instances[0]!;

      expect(socket.cancelTurn("turn-pending")).toBe(true);
      expect(first.sent).toHaveLength(0);
      first.emit(readyFrame());
      expect(
        first.sent.map((value) => JSON.parse(value)).filter(
          (value) => value.type === "cancel",
        ),
      ).toEqual([{ type: "cancel", turnId: "turn-pending" }]);

      first.onclose?.({ code: 1006 });
      socket.retry();
      await Promise.resolve();
      const second = FakeWebSocket.instances[1]!;
      second.emit(readyFrame());
      expect(
        second.sent.map((value) => JSON.parse(value)).filter(
          (value) => value.type === "cancel",
        ),
      ).toEqual([{ type: "cancel", turnId: "turn-pending" }]);
      socket.stop();
    });
  });
});
