import { afterEach, describe, expect, test } from "bun:test";
import {
  ConversationSocket,
  type ConversationSocketEvent,
} from "../cloud-conversation-socket";

const originalWebSocket = globalThis.WebSocket;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly protocols: string | string[] | undefined;
  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = String(url);
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({} as Event);
  }

  receive(frame: object): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }

  disconnect(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

const installFakeWebSocket = (): void => {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: FakeWebSocket,
  });
};

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const ready = (args: {
  conversationId: string;
  epoch: number;
  headSeq: number;
  windowStartSeq: number;
  floorSeq?: number;
}) => ({
  type: "ready",
  protocol: 1,
  conversationId: args.conversationId,
  epoch: args.epoch,
  headSeq: args.headSeq,
  windowStartSeq: args.windowStartSeq,
  floorSeq: args.floorSeq ?? 0,
  title: "Chat",
  activity: "idle",
  authExpiresAtMs: 3_600_000,
  serverTimeMs: 0,
  live: null,
});

const record = (seq: number) => ({
  type: "record",
  kind: "message",
  seq,
  turnId: "turn-1",
  createdAtMs: seq,
  role: seq % 2 === 0 ? "assistant" : "user",
  hidden: false,
  payload: { content: String(seq) },
});

const sentFrames = (socket: FakeWebSocket): Record<string, unknown>[] =>
  socket.sent
    .filter((value) => value.startsWith("{"))
    .map((value) => JSON.parse(value) as Record<string, unknown>);

afterEach(() => {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: originalWebSocket,
  });
  FakeWebSocket.instances = [];
});

describe("mobile cloud conversation socket", () => {
  test("cold-connects without a cursor, then resumes exactly and dedupes replay", async () => {
    installFakeWebSocket();
    const events: ConversationSocketEvent[] = [];
    const socket = new ConversationSocket({
      conversationId: "conversation-resume",
      baseUrl: "https://builder.example.test",
      getToken: async () => "header.payload.signature",
      onEvent: (event) => events.push(event),
    });

    try {
      socket.start();
      await settle();
      const first = FakeWebSocket.instances[0];
      if (!first) throw new Error("first socket was not created");
      const coldUrl = new URL(first.url);
      expect(coldUrl.protocol).toBe("wss:");
      expect(coldUrl.searchParams.get("protocol")).toBe("1");
      expect(coldUrl.searchParams.has("since")).toBe(false);
      expect(coldUrl.searchParams.has("epoch")).toBe(false);
      expect(first.protocols).toEqual([
        "stella.v1",
        "stella.token.header.payload.signature",
      ]);

      first.open();
      first.receive(
        ready({
          conversationId: "conversation-resume",
          epoch: 7,
          headSeq: 2,
          windowStartSeq: 1,
        }),
      );
      first.receive(record(1));
      first.receive(record(2));

      first.disconnect(1006);
      socket.retryNow();
      await settle();
      const second = FakeWebSocket.instances[1];
      if (!second) throw new Error("replacement socket was not created");
      const resumeUrl = new URL(second.url);
      expect(resumeUrl.searchParams.get("since")).toBe("2");
      expect(resumeUrl.searchParams.get("epoch")).toBe("7");

      second.open();
      second.receive(
        ready({
          conversationId: "conversation-resume",
          epoch: 7,
          headSeq: 3,
          windowStartSeq: 3,
        }),
      );
      // A boundary replay is harmless; only the genuinely new row emits.
      second.receive(record(2));
      second.receive(record(3));

      const applied = events
        .filter(
          (
            event,
          ): event is Extract<ConversationSocketEvent, { type: "records" }> =>
            event.type === "records",
        )
        .flatMap((event) => event.records.map((value) => value.seq));
      expect(applied).toEqual([1, 2, 3]);
      expect(socket.cursor).toMatchObject({ lastSeq: 3, headSeq: 3 });
    } finally {
      socket.stop();
    }
  });

  test("assembles byte-truncated scrollback before emitting one older page", async () => {
    installFakeWebSocket();
    const events: ConversationSocketEvent[] = [];
    const socket = new ConversationSocket({
      conversationId: "conversation-older",
      baseUrl: "wss://builder.example.test",
      getToken: async () => "header.payload.signature",
      onEvent: (event) => events.push(event),
    });

    try {
      socket.start();
      await settle();
      const transport = FakeWebSocket.instances[0];
      if (!transport) throw new Error("socket was not created");
      transport.open();
      transport.receive(
        ready({
          conversationId: "conversation-older",
          epoch: 3,
          headSeq: 200,
          windowStartSeq: 200,
          floorSeq: 195,
        }),
      );
      transport.receive(record(200));

      expect(socket.requestOlder(200)).toBe(true);
      const firstRequest = sentFrames(transport).find(
        (frame) => frame.type === "backfill",
      );
      expect(firstRequest).toMatchObject({ fromSeq: 195, toSeq: 199 });
      transport.receive({
        type: "backfill",
        requestId: firstRequest?.requestId,
        fromSeq: 195,
        toSeq: 196,
        complete: false,
        records: [record(195), record(196)].map(
          ({ type: _type, ...row }) => row,
        ),
      });
      expect(events.some((event) => event.type === "older")).toBe(false);

      const requests = sentFrames(transport).filter(
        (frame) => frame.type === "backfill",
      );
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({ fromSeq: 197, toSeq: 199 });
      transport.receive({
        type: "backfill",
        requestId: requests[1]?.requestId,
        fromSeq: 197,
        toSeq: 199,
        complete: true,
        records: [record(197), record(198), record(199)].map(
          ({ type: _type, ...row }) => row,
        ),
      });

      const older = events.filter(
        (event): event is Extract<ConversationSocketEvent, { type: "older" }> =>
          event.type === "older",
      );
      expect(older).toHaveLength(1);
      expect(older[0]).toMatchObject({
        complete: true,
        fromSeq: 195,
        toSeq: 199,
      });
      expect(older[0]?.records.map((value) => value.seq)).toEqual([
        195, 196, 197, 198, 199,
      ]);
    } finally {
      socket.stop();
    }
  });

  test("fences concurrent connection attempts while token resolution is pending", async () => {
    installFakeWebSocket();
    let tokenCalls = 0;
    const deferred: { resolve?: (value: string) => void } = {};
    const token = new Promise<string>((resolve) => {
      deferred.resolve = resolve;
    });
    const socket = new ConversationSocket({
      conversationId: "conversation-connecting",
      baseUrl: "wss://builder.example.test",
      getToken: async () => {
        tokenCalls += 1;
        return token;
      },
      onEvent: () => undefined,
    });

    try {
      socket.start();
      socket.wake();
      socket.retryNow();
      expect(tokenCalls).toBe(1);
      expect(FakeWebSocket.instances).toHaveLength(0);
      deferred.resolve?.("header.payload.signature");
      await settle();
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      socket.stop();
    }
  });

  test("surfaces an owner mismatch and stops automatic reconnects", async () => {
    installFakeWebSocket();
    const events: ConversationSocketEvent[] = [];
    const socket = new ConversationSocket({
      conversationId: "conversation-forbidden",
      baseUrl: "wss://builder.example.test",
      getToken: async () => "header.payload.signature",
      onEvent: (event) => events.push(event),
    });

    try {
      socket.start();
      await settle();
      const transport = FakeWebSocket.instances[0];
      if (!transport) throw new Error("socket was not created");
      transport.open();
      transport.disconnect(4403);
      await settle();

      expect(events.at(-1)).toEqual({
        type: "status",
        status: "blocked",
        message: "This conversation belongs to another account.",
        retryable: false,
      });
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      socket.stop();
    }
  });
});
