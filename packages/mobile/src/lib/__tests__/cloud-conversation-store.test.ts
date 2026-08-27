import { describe, expect, test } from "bun:test";
import type { JournalRecord } from "../cloud-conversation-protocol";
import type { ConversationSocketEvent } from "../cloud-conversation-socket";
import {
  conversationStore,
  retireCloudConversationClientAuthority,
} from "../cloud-conversation-store";

const message = (seq: number): JournalRecord => ({
  kind: "message",
  seq,
  turnId: "turn-store",
  createdAtMs: seq,
  role: seq % 2 === 0 ? "assistant" : "user",
  hidden: false,
  payload: { content: String(seq) },
});

const ready = (epoch: number, headSeq: number): ConversationSocketEvent => ({
  type: "ready",
  ready: {
    type: "ready",
    protocol: 1,
    conversationId: "store-test",
    epoch,
    headSeq,
    windowStartSeq: Math.max(0, headSeq),
    floorSeq: 0,
    title: "Store test",
    activity: "idle",
    authExpiresAtMs: 3_600_000,
    serverTimeMs: 0,
    live: null,
  },
});

const dispatch = (
  store: ReturnType<typeof conversationStore>,
  event: ConversationSocketEvent,
): void => {
  (
    store as unknown as {
      onEvent: (next: ConversationSocketEvent) => void;
    }
  ).onEvent(event);
};

describe("mobile cloud conversation store", () => {
  test("merges overlap monotonically without duplicate durable rows", () => {
    const store = conversationStore(
      `monotonic-${crypto.randomUUID()}`,
      "account:test-owner",
    );
    dispatch(store, ready(1, 3));
    dispatch(store, { type: "records", records: [message(1), message(2)] });
    dispatch(store, { type: "records", records: [message(2), message(3)] });
    dispatch(store, {
      type: "older",
      records: [message(0), message(1)],
      complete: true,
      fromSeq: 0,
      toSeq: 1,
    });

    expect(store.getSnapshot().records.map((record) => record.seq)).toEqual([
      0, 1, 2, 3,
    ]);
  });

  test("ready-reset-records replaces the old epoch and accepts lower cursors", () => {
    const store = conversationStore(
      `epoch-${crypto.randomUUID()}`,
      "account:test-owner",
    );
    dispatch(store, ready(1, 2));
    dispatch(store, { type: "records", records: [message(1), message(2)] });

    dispatch(store, ready(2, 0));
    dispatch(store, { type: "reset", reason: "epoch" });
    dispatch(store, { type: "records", records: [message(0)] });

    expect(store.getSnapshot()).toMatchObject({ epoch: 2, headSeq: 0 });
    expect(store.getSnapshot().records.map((record) => record.seq)).toEqual([
      0,
    ]);
  });

  test("never splices a partial older page into canonical history", () => {
    const store = conversationStore(
      `partial-${crypto.randomUUID()}`,
      "account:test-owner",
    );
    dispatch(store, ready(1, 100));
    dispatch(store, { type: "records", records: [message(100)] });
    dispatch(store, {
      type: "older",
      records: [message(98)],
      complete: false,
      fromSeq: 98,
      toSeq: 99,
    });

    expect(store.getSnapshot().records.map((record) => record.seq)).toEqual([
      100,
    ]);
    expect(store.getSnapshot()).toMatchObject({
      hasOlder: true,
      loadingOlder: false,
      olderNotice: "Couldn't load that part of this conversation. Try again.",
    });
  });

  test("owner generation is part of registry identity and retires stale stores", () => {
    const conversationId = `generation-${crypto.randomUUID()}`;
    const accountScope = `account:${crypto.randomUUID()}`;
    const oldStore = conversationStore(
      conversationId,
      accountScope,
      "owner-generation-old",
    );
    dispatch(oldStore, ready(1, 1));
    dispatch(oldStore, { type: "records", records: [message(1)] });

    const newStore = conversationStore(
      conversationId,
      accountScope,
      "owner-generation-new",
    );
    expect(newStore).not.toBe(oldStore);
    expect(newStore.getSnapshot().records).toEqual([]);

    retireCloudConversationClientAuthority(
      accountScope,
      "owner-generation-new",
    );
    expect(oldStore.getSnapshot()).toMatchObject({
      status: "idle",
      epoch: null,
      headSeq: -1,
      records: [],
    });
    expect(
      conversationStore(conversationId, accountScope, "owner-generation-new"),
    ).toBe(newStore);
  });
});
