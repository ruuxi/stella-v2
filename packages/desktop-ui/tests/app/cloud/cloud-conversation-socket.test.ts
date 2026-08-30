import { afterEach, describe, expect, test } from "vitest";
import {
  decodeServerFrame,
  type JournalRecord,
} from "../../../src/features/cloud/conversation-protocol";
import {
  ConversationSocket,
  type ConversationSocketEvent,
} from "../../../src/features/cloud/conversation-socket";
import { journalRecordsToMessageRecords } from "../../../src/features/cloud/journal-message-records";

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
    this.onopen?.(new Event("open"));
  }

  receive(frame: object): void {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(frame) }),
    );
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

afterEach(() => {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: originalWebSocket,
  });
  FakeWebSocket.instances = [];
});

describe("cloud conversation journal compatibility", () => {
  test("resumes the real socket URL from a validated cache cursor", async () => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: FakeWebSocket,
    });
    const events: ConversationSocketEvent[] = [];
    const socket = new ConversationSocket({
      conversationId: "conversation-resume",
      baseUrl: "https://builder.example.test",
      getToken: async () => "header.payload.signature",
      onEvent: (event) => events.push(event),
      initialCursor: {
        epoch: 7,
        lastSeq: 42,
        headSeq: 42,
        floorSeq: 10,
        windowStartSeq: 20,
      },
    });

    try {
      socket.start();
      await Promise.resolve();
      await Promise.resolve();
      const transport = FakeWebSocket.instances[0];
      if (!transport) throw new Error("socket was not created");
      const url = new URL(transport.url);
      expect(url.searchParams.get("since")).toBe("42");
      expect(url.searchParams.get("epoch")).toBe("7");
      transport.open();
      transport.receive({
        type: "ready",
        protocol: 1,
        conversationId: "conversation-resume",
        epoch: 7,
        headSeq: 42,
        windowStartSeq: 20,
        floorSeq: 10,
        title: "Resumed",
        activity: "idle",
        authExpiresAtMs: 3_600_000,
        serverTimeMs: 0,
        live: null,
      });
      expect(events.some((event) => event.type === "reset")).toBe(false);
      expect(
        transport.sent.some((entry) => entry.includes('"type":"backfill"')),
      ).toBe(false);
    } finally {
      socket.stop();
    }
  });

  test("retains the raw sequence of an unknown future record", () => {
    const frame = decodeServerFrame(
      JSON.stringify({
        type: "backfill",
        requestId: "gap-1",
        fromSeq: 7,
        toSeq: 7,
        complete: true,
        records: [
          {
            seq: 7,
            turnId: "turn-1",
            createdAtMs: 1,
            kind: "future-record-kind",
            futurePayload: { version: 2 },
          },
        ],
      }),
    );

    expect(frame?.type).toBe("backfill");
    if (frame?.type !== "backfill") throw new Error("expected backfill");
    expect(frame.records).toHaveLength(1);
    expect(frame.records[0]).toMatchObject({
      kind: "skipped",
      seq: 7,
      turnId: "turn-1",
      originalKind: "future-record-kind",
    });
  });

  test("rejects non-integer and negative durable cursors", () => {
    for (const seq of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        decodeServerFrame(
          JSON.stringify({
            type: "record",
            seq,
            turnId: "turn-invalid",
            createdAtMs: 1,
            kind: "future-record-kind",
          }),
        ),
      ).toBeNull();
    }
  });

  test("turns an unknown card subtype into a skipped durable row", () => {
    const frame = decodeServerFrame(
      JSON.stringify({
        type: "record",
        seq: 8,
        turnId: "turn-2",
        createdAtMs: 2,
        kind: "card",
        card: { type: "future-card", payload: true },
      }),
    );

    expect(frame).toMatchObject({
      type: "record",
      kind: "skipped",
      seq: 8,
      turnId: "turn-2",
      originalKind: "card",
    });
  });

  test("advances through an unknown record without wedging gap repair", async () => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: FakeWebSocket,
    });
    const events: ConversationSocketEvent[] = [];
    const socket = new ConversationSocket({
      conversationId: "conversation-1",
      baseUrl: "https://builder.example.test",
      getToken: async () => "header.payload.signature",
      onEvent: (event) => events.push(event),
    });

    try {
      socket.start();
      await Promise.resolve();
      await Promise.resolve();
      const transport = FakeWebSocket.instances[0];
      expect(transport).toBeDefined();
      if (!transport) throw new Error("socket was not created");
      transport.open();
      transport.receive({
        type: "ready",
        protocol: 1,
        conversationId: "conversation-1",
        epoch: 1,
        headSeq: 4,
        windowStartSeq: 1,
        floorSeq: 1,
        title: "Compatibility",
        activity: "idle",
        authExpiresAtMs: 3_600_000,
        serverTimeMs: 0,
        live: null,
      });
      transport.receive({
        type: "record",
        seq: 1,
        turnId: "turn-1",
        createdAtMs: 1,
        kind: "message",
        role: "user",
        hidden: false,
        payload: { role: "user", content: "one" },
      });
      transport.receive({
        type: "record",
        seq: 2,
        turnId: "turn-1",
        createdAtMs: 2,
        kind: "future-record-kind",
        futurePayload: true,
      });
      transport.receive({
        type: "record",
        seq: 3,
        turnId: "turn-1",
        createdAtMs: 3,
        kind: "message",
        role: "assistant",
        hidden: false,
        payload: { role: "assistant", content: "three" },
      });
      // The newest/head row is also opaque to this client. It must still
      // satisfy ready.headSeq so resume does not repeatedly backfill it.
      transport.receive({
        type: "record",
        seq: 4,
        turnId: "turn-1",
        createdAtMs: 4,
        kind: "another-future-record-kind",
      });

      const ordered = events
        .filter(
          (
            event,
          ): event is Extract<ConversationSocketEvent, { type: "records" }> =>
            event.type === "records",
        )
        .flatMap((event) => event.records as JournalRecord[]);
      expect(ordered.map((record) => record.seq)).toEqual([1, 2, 3, 4]);
      expect(ordered.every((record) => !Object.hasOwn(record, "type"))).toBe(
        true,
      );
      expect(ordered[1]).toMatchObject({
        kind: "skipped",
        originalKind: "future-record-kind",
      });
      expect(journalRecordsToMessageRecords(ordered)).toHaveLength(2);
      expect(socket.cursor.lastSeq).toBe(4);
      expect(
        transport.sent.some((entry) => entry.includes('"type":"backfill"')),
      ).toBe(false);
    } finally {
      socket.stop();
    }
  });

  test("fills a live gap with a skipped sentinel exactly once", async () => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: FakeWebSocket,
    });
    const events: ConversationSocketEvent[] = [];
    const socket = new ConversationSocket({
      conversationId: "conversation-gap",
      baseUrl: "https://builder.example.test",
      getToken: async () => "header.payload.signature",
      onEvent: (event) => events.push(event),
    });

    try {
      socket.start();
      await Promise.resolve();
      await Promise.resolve();
      const transport = FakeWebSocket.instances[0];
      if (!transport) throw new Error("socket was not created");
      transport.open();
      transport.receive({
        type: "ready",
        protocol: 1,
        conversationId: "conversation-gap",
        epoch: 1,
        headSeq: 3,
        windowStartSeq: 1,
        floorSeq: 1,
        title: "Gap",
        activity: "idle",
        authExpiresAtMs: 3_600_000,
        serverTimeMs: 0,
        live: null,
      });
      transport.receive({
        type: "record",
        seq: 1,
        turnId: "turn-gap",
        createdAtMs: 1,
        kind: "message",
        role: "user",
        hidden: false,
        payload: { role: "user", content: "one" },
      });
      transport.receive({
        type: "record",
        seq: 3,
        turnId: "turn-gap",
        createdAtMs: 3,
        kind: "message",
        role: "assistant",
        hidden: false,
        payload: { role: "assistant", content: "three" },
      });

      const requests = transport.sent
        .map((entry) => JSON.parse(entry) as Record<string, unknown>)
        .filter((entry) => entry.type === "backfill");
      expect(requests).toHaveLength(1);
      transport.receive({
        type: "backfill",
        requestId: requests[0]?.requestId,
        fromSeq: 2,
        toSeq: 2,
        complete: true,
        records: [
          {
            seq: 2,
            turnId: "turn-gap",
            createdAtMs: 2,
            kind: "future-record-kind",
          },
        ],
      });

      const ordered = events
        .filter(
          (
            event,
          ): event is Extract<ConversationSocketEvent, { type: "records" }> =>
            event.type === "records",
        )
        .flatMap((event) => event.records);
      expect(ordered.map((record) => record.seq)).toEqual([1, 2, 3]);
      expect(socket.cursor.lastSeq).toBe(3);
      expect(
        transport.sent
          .map((entry) => JSON.parse(entry) as Record<string, unknown>)
          .filter((entry) => entry.type === "backfill"),
      ).toHaveLength(1);
    } finally {
      socket.stop();
    }
  });

  test("retries an empty incomplete canonical range and then fails explicitly", async () => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: FakeWebSocket,
    });
    const events: ConversationSocketEvent[] = [];
    const socket = new ConversationSocket({
      conversationId: "conversation-incomplete",
      baseUrl: "https://builder.example.test",
      getToken: async () => "header.payload.signature",
      onEvent: (event) => events.push(event),
    });

    try {
      socket.start();
      await Promise.resolve();
      await Promise.resolve();
      const transport = FakeWebSocket.instances[0];
      if (!transport) throw new Error("socket was not created");
      transport.open();
      transport.receive({
        type: "ready",
        protocol: 1,
        conversationId: "conversation-incomplete",
        epoch: 1,
        headSeq: 2,
        windowStartSeq: 1,
        floorSeq: 1,
        title: "Incomplete",
        activity: "idle",
        authExpiresAtMs: 3_600_000,
        serverTimeMs: 0,
        live: null,
      });
      // The opening window promised seq 1. Receiving seq 2 first must repair
      // that prefix rather than adopting 2 as an arbitrary fresh start.
      transport.receive({
        type: "record",
        seq: 2,
        turnId: "turn-incomplete",
        createdAtMs: 2,
        kind: "message",
        role: "assistant",
        hidden: false,
        payload: { role: "assistant", content: "two" },
      });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const requests = transport.sent
          .map((entry) => JSON.parse(entry) as Record<string, unknown>)
          .filter((entry) => entry.type === "backfill");
        expect(requests).toHaveLength(attempt + 1);
        const request = requests.at(-1);
        transport.receive({
          type: "backfill",
          requestId: request?.requestId,
          fromSeq: 1,
          toSeq: 1,
          complete: false,
          records: [],
        });
      }

      expect(
        events.findLast(
          (
            event,
          ): event is Extract<ConversationSocketEvent, { type: "status" }> =>
            event.type === "status",
        ),
      ).toMatchObject({
        type: "status",
        status: "blocked",
        retryable: true,
        message:
          "Stella couldn't recover part of this conversation. Retry to load it safely.",
      });
      expect(events.some((event) => event.type === "records")).toBe(false);
      expect(transport.readyState).toBe(FakeWebSocket.CLOSED);
    } finally {
      socket.stop();
    }
  });
});
