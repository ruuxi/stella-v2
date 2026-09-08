import { afterEach, describe, expect, mock, test } from "bun:test";
import type { JournalRecord } from "../cloud-conversation-protocol";

import {
  decodeCloudJournalTail,
  encodeCloudJournalTail,
  readCloudJournalCache,
  rebuildCloudConversationCache,
  type CloudConversationCacheMetadata,
} from "../cloud-conversation-cache";
import { conversationStore } from "../cloud-conversation-store";

// The store resolves its socket token through the native auth client, which
// the bun runtime cannot load. It imports that module lazily when a socket
// opens, so mocking it after the static imports still takes effect.
mock.module("../auth-token", () => ({
  getConvexToken: async () => "header.payload.signature",
}));

const originalWebSocket = globalThis.WebSocket;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({} as Event);
  }

  receive(frame: object): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }

  send(): void {}

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

afterEach(() => {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: originalWebSocket,
  });
  FakeWebSocket.instances = [];
});

// The disk read, the seed, and the socket's token resolution (a dynamic
// import) each take their own turn; a short macrotask wait covers them all.
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 25));

const message = (seq: number): JournalRecord => ({
  kind: "message",
  seq,
  turnId: `turn-${seq}`,
  createdAtMs: seq,
  role: seq % 2 === 0 ? "assistant" : "user",
  hidden: false,
  payload: { content: String(seq) },
});

const ready = (args: {
  conversationId: string;
  epoch: number;
  headSeq: number;
  windowStartSeq: number;
}) => ({
  type: "ready",
  protocol: 1,
  conversationId: args.conversationId,
  epoch: args.epoch,
  headSeq: args.headSeq,
  windowStartSeq: args.windowStartSeq,
  floorSeq: 0,
  title: "Chat",
  activity: "idle",
  authExpiresAtMs: 3_600_000,
  serverTimeMs: 0,
  live: null,
});

const metadata: CloudConversationCacheMetadata = {
  version: 1,
  accountScope: "account:user-1",
  ownerGeneration: "owner-1",
  socketOrigin: "wss://builder.example",
  conversationId: "conversation-seed",
  epoch: 7,
  headSeq: 4,
  floorSeq: 0,
};

describe("journal tail cache", () => {
  test("round-trips the contiguous tail ending at the head", () => {
    const records = [1, 2, 3, 4].map(message);
    const encoded = encodeCloudJournalTail(records, 4);
    expect(encoded).not.toBeNull();
    expect(decodeCloudJournalTail(encoded)?.map((r) => r.seq)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  test("keeps only the newest rows within the count and byte bounds", () => {
    const records = [1, 2, 3, 4].map(message);
    expect(
      decodeCloudJournalTail(
        encodeCloudJournalTail(records, 4, { maxRecords: 2 }),
      )?.map((r) => r.seq),
    ).toEqual([3, 4]);
    const oneRow = JSON.stringify(message(4)).length;
    expect(
      decodeCloudJournalTail(
        encodeCloudJournalTail(records, 4, { maxBytes: oneRow }),
      )?.map((r) => r.seq),
    ).toEqual([4]);
  });

  test("refuses a tail that does not reach the head or has a hole", () => {
    expect(encodeCloudJournalTail([1, 2, 3].map(message), 4)).toBeNull();
    expect(
      decodeCloudJournalTail(
        encodeCloudJournalTail([1, 2, 4].map(message), 4),
      )?.map((r) => r.seq),
    ).toEqual([4]);
    expect(decodeCloudJournalTail("[{\"seq\":1},{\"seq\":3}]")).toBeNull();
    expect(decodeCloudJournalTail("not json")).toBeNull();
  });

  test("rebuild commits the tail before metadata and the read validates the fence", async () => {
    const calls: string[] = [];
    let storedMetadata: string | null = null;
    let storedRecords: string | null = null;
    await rebuildCloudConversationCache({
      metadata,
      messages: [],
      records: [1, 2, 3, 4].map(message),
      port: {
        clearMetadata: async () => {
          calls.push("clear");
          storedMetadata = null;
        },
        synchronizeMessages: async () => {
          calls.push("messages");
        },
        synchronizeRecords: async (encoded) => {
          calls.push("records");
          storedRecords = encoded;
        },
        saveMetadata: async (next) => {
          calls.push("metadata");
          storedMetadata = JSON.stringify(next);
        },
      },
    });
    expect(calls).toEqual(["clear", "messages", "records", "metadata"]);

    const port = {
      loadMetadata: async () => storedMetadata,
      loadMessages: async () => [],
      loadRecords: async () => storedRecords,
    };
    const seed = await readCloudJournalCache({ authority: metadata, port });
    expect(seed).toMatchObject({ epoch: 7, headSeq: 4, floorSeq: 0 });
    expect(seed?.records.map((r) => r.seq)).toEqual([1, 2, 3, 4]);

    expect(
      await readCloudJournalCache({
        authority: { ...metadata, ownerGeneration: "owner-2" },
        port,
      }),
    ).toBeNull();
    expect(
      await readCloudJournalCache({
        authority: metadata,
        port: { ...port, loadMetadata: async () => JSON.stringify({ ...metadata, headSeq: 5 }) },
      }),
    ).toBeNull();
  });
});

describe("cold launch resume", () => {
  const boot = async (
    load: () => Promise<
      | { epoch: number; headSeq: number; floorSeq: number; records: JournalRecord[] }
      | null
    >,
  ) => {
    installFakeWebSocket();
    const conversationId = `resume-${crypto.randomUUID()}`;
    const store = conversationStore(conversationId, "account:test-owner");
    store.hydrate(load);
    const unsubscribe = store.subscribe(() => {});
    store.setConfig("https://builder.example.test", true);
    await settle();
    return { store, conversationId, unsubscribe };
  };

  test("seeds the transcript and opens the first socket with a cursor", async () => {
    const { store, conversationId, unsubscribe } = await boot(async () => ({
      epoch: 7,
      headSeq: 4,
      floorSeq: 0,
      records: [1, 2, 3, 4].map(message),
    }));
    try {
      // Painted from disk before any frame arrives.
      expect(store.getSnapshot().records.map((r) => r.seq)).toEqual([
        1, 2, 3, 4,
      ]);
      expect(store.getSnapshot()).toMatchObject({ epoch: 7, headSeq: 4 });

      const socket = FakeWebSocket.instances[0];
      if (!socket) throw new Error("socket was not created");
      const url = new URL(socket.url);
      expect(url.searchParams.get("since")).toBe("4");
      expect(url.searchParams.get("epoch")).toBe("7");

      // Nothing changed server-side: ready names the same head, no rows.
      socket.open();
      socket.receive(
        ready({ conversationId, epoch: 7, headSeq: 4, windowStartSeq: 5 }),
      );
      expect(store.getSnapshot()).toMatchObject({
        status: "live",
        epoch: 7,
        headSeq: 4,
      });
      expect(store.getSnapshot().records.map((r) => r.seq)).toEqual([
        1, 2, 3, 4,
      ]);
    } finally {
      unsubscribe();
    }
  });

  test("a delta since the cursor appends without disturbing seeded rows", async () => {
    const { store, conversationId, unsubscribe } = await boot(async () => ({
      epoch: 7,
      headSeq: 4,
      floorSeq: 0,
      records: [1, 2, 3, 4].map(message),
    }));
    try {
      const socket = FakeWebSocket.instances[0]!;
      const seeded = store.getSnapshot().records;
      socket.open();
      socket.receive(
        ready({ conversationId, epoch: 7, headSeq: 6, windowStartSeq: 5 }),
      );
      socket.receive({ type: "record", ...message(5) });
      socket.receive({ type: "record", ...message(6) });
      const after = store.getSnapshot().records;
      expect(after.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(after.slice(0, 4)).toEqual([...seeded]);
    } finally {
      unsubscribe();
    }
  });

  test("an epoch mismatch resets to the server's newest window", async () => {
    const { store, conversationId, unsubscribe } = await boot(async () => ({
      epoch: 7,
      headSeq: 4,
      floorSeq: 0,
      records: [1, 2, 3, 4].map(message),
    }));
    try {
      const socket = FakeWebSocket.instances[0]!;
      socket.open();
      socket.receive(
        ready({ conversationId, epoch: 8, headSeq: 1, windowStartSeq: 0 }),
      );
      socket.receive({ type: "reset", reason: "epoch" });
      socket.receive({ type: "record", ...message(0) });
      socket.receive({ type: "record", ...message(1) });
      expect(store.getSnapshot()).toMatchObject({ epoch: 8, headSeq: 1 });
      expect(store.getSnapshot().records.map((r) => r.seq)).toEqual([0, 1]);
    } finally {
      unsubscribe();
    }
  });

  test("a compacted window below the cursor resets to the newest window", async () => {
    const { store, conversationId, unsubscribe } = await boot(async () => ({
      epoch: 7,
      headSeq: 4,
      floorSeq: 0,
      records: [1, 2, 3, 4].map(message),
    }));
    try {
      const socket = FakeWebSocket.instances[0]!;
      socket.open();
      // The server kept nothing between the cursor and its window start.
      socket.receive(
        ready({ conversationId, epoch: 7, headSeq: 12, windowStartSeq: 10 }),
      );
      socket.receive({ type: "reset", reason: "window" });
      for (const seq of [10, 11, 12]) {
        socket.receive({ type: "record", ...message(seq) });
      }
      expect(store.getSnapshot().records.map((r) => r.seq)).toEqual([
        10, 11, 12,
      ]);
      expect(store.getSnapshot().hasOlder).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  test("no seed on disk opens a cold socket without a cursor", async () => {
    const { store, unsubscribe } = await boot(async () => null);
    try {
      expect(store.getSnapshot().records).toEqual([]);
      const socket = FakeWebSocket.instances[0];
      if (!socket) throw new Error("socket was not created");
      const url = new URL(socket.url);
      expect(url.searchParams.has("since")).toBe(false);
      expect(url.searchParams.has("epoch")).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  test("a seed that does not end at its head is refused", async () => {
    const { store, unsubscribe } = await boot(async () => ({
      epoch: 7,
      headSeq: 5,
      floorSeq: 0,
      records: [1, 2, 3, 4].map(message),
    }));
    try {
      expect(store.getSnapshot().records).toEqual([]);
      const url = new URL(FakeWebSocket.instances[0]!.url);
      expect(url.searchParams.has("since")).toBe(false);
    } finally {
      unsubscribe();
    }
  });
});
