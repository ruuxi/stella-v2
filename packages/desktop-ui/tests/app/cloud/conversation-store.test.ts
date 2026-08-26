import { describe, expect, test } from "vitest";
import type { JournalRecord } from "../../../src/features/cloud/conversation-protocol";
import type { ConversationSocketEvent } from "../../../src/features/cloud/conversation-socket";
import { conversationStore } from "../../../src/features/cloud/conversation-store";

const message = (seq: number, role: "user" | "assistant"): JournalRecord => ({
  kind: "message",
  seq,
  turnId: "turn-store",
  createdAtMs: seq,
  role,
  hidden: false,
  payload: { role, content: String(seq) },
});

const skipped = (seq: number): JournalRecord => ({
  kind: "skipped",
  seq,
  turnId: "turn-store",
  createdAtMs: seq,
  originalKind: "future-record-kind",
});

const dispatch = (
  store: ReturnType<typeof conversationStore>,
  event: ConversationSocketEvent,
): void => {
  // Exercise the reducer boundary directly; socket lifecycle/auth are covered
  // separately and the store intentionally keeps this method private.
  (
    store as unknown as {
      onEvent: (next: ConversationSocketEvent) => void;
    }
  ).onEvent(event);
};

describe("cloud conversation store opaque records", () => {
  test("retains visible rows across a skipped sequence", () => {
    const store = conversationStore(`opaque-${crypto.randomUUID()}`);
    dispatch(store, { type: "records", records: [message(1, "user")] });
    dispatch(store, {
      type: "records",
      records: [skipped(2), message(3, "assistant")],
    });

    expect(store.getSnapshot().records.map((record) => record.seq)).toEqual([
      1, 2, 3,
    ]);
  });

  test("an opaque-only older page remains a paging anchor", () => {
    const store = conversationStore(`opaque-older-${crypto.randomUUID()}`);
    dispatch(store, { type: "records", records: [message(100, "user")] });
    dispatch(store, { type: "older", records: [skipped(50)] });

    expect(store.getSnapshot()).toMatchObject({
      hasOlder: true,
      loadingOlder: false,
    });
    expect(store.getSnapshot().records.map((record) => record.seq)).toEqual([
      50, 100,
    ]);
  });
});
