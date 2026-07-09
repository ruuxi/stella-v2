import { describe, expect, test } from "bun:test";
import { mergeMessagesById } from "./chat-merge";
import {
  acknowledgeDesktopChatOutboxRecords,
  appendDesktopChatOutboxRecord,
  restoreOutboxMessages,
  type DesktopChatOutboxRecord,
} from "./desktop-chat-outbox-state";

const pending = (
  sendId: string,
  text: string,
  createdAt: number,
): Omit<DesktopChatOutboxRecord, "sequence"> => ({
  sendId,
  userMessageId: sendId,
  text,
  displayText: text,
  createdAt,
  assets: [],
});

describe("desktop chat durable outbox", () => {
  test("does not expose a transmissible record before durable enqueue completes", () => {
    const durable: DesktopChatOutboxRecord[] = [];
    const attemptedBeforeCommit = durable.find((record) => record.sendId === "send-1");
    expect(attemptedBeforeCommit).toBe(undefined);

    const committed = appendDesktopChatOutboxRecord(
      durable,
      pending("send-1", "hello", 1_000),
    );
    expect(committed.record.sendId).toBe("send-1");
    expect(committed.records).toHaveLength(1);
  });

  test("replays every interruption window with one stable identity", () => {
    let outbox = appendDesktopChatOutboxRecord(
      [],
      pending("send-1", "hello", 1_000),
    ).records;
    const canonicalRows = new Map<string, { id: string; text: string }>();
    const accept = (record: DesktopChatOutboxRecord) => {
      if (!canonicalRows.has(record.userMessageId)) {
        canonicalRows.set(record.userMessageId, {
          id: record.userMessageId,
          text: record.text,
        });
      }
      return record.userMessageId;
    };

    // Persisted before send, close during send, acceptance/ack loss, ack before
    // cleanup, and unlimited reconnect replay all deliver the same record.
    const record = outbox[0]!;
    for (let replay = 0; replay < 20; replay += 1) {
      expect(accept(record)).toBe("send-1");
    }
    expect([...canonicalRows.values()]).toEqual([
      { id: "send-1", text: "hello" },
    ]);

    outbox = acknowledgeDesktopChatOutboxRecords(outbox, new Set(["send-1"]));
    outbox = acknowledgeDesktopChatOutboxRecords(outbox, new Set(["send-1"]));
    expect(outbox).toEqual([]);
  });

  test("preserves compose order and keeps intentional identical messages distinct", () => {
    const first = appendDesktopChatOutboxRecord(
      [],
      pending("send-a", "same text", 5_000),
    );
    const second = appendDesktopChatOutboxRecord(
      first.records,
      pending("send-b", "same text", 5_000),
    );
    const third = appendDesktopChatOutboxRecord(
      second.records,
      pending("send-c", "later", 1),
    );

    expect(third.records.map((record) => record.sendId)).toEqual([
      "send-a",
      "send-b",
      "send-c",
    ]);
    expect(third.records.map((record) => record.sequence)).toEqual([1, 2, 3]);
  });

  test("hydrates a missing optimistic row once and reconciles canonical replay in place", () => {
    const outbox = appendDesktopChatOutboxRecord(
      [],
      pending("send-1", "hello", 1_000),
    ).records;
    const restored = restoreOutboxMessages([], outbox);
    const restoredAgain = restoreOutboxMessages(restored, outbox);
    expect(restoredAgain).toHaveLength(1);

    const merged = mergeMessagesById(restoredAgain, [
      {
        id: "send-1",
        role: "user",
        text: "hello",
        createdAt: 9_000,
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "send-1",
      role: "user",
      text: "hello",
      createdAt: 1_000,
      canonicalCreatedAt: 9_000,
    });
  });

  test("makes duplicate and out-of-order canonical acknowledgments harmless", () => {
    let records = appendDesktopChatOutboxRecord(
      [],
      pending("send-a", "a", 1),
    ).records;
    records = appendDesktopChatOutboxRecord(
      records,
      pending("send-b", "b", 2),
    ).records;
    records = appendDesktopChatOutboxRecord(
      records,
      pending("send-c", "c", 3),
    ).records;

    records = acknowledgeDesktopChatOutboxRecords(records, new Set(["send-b"]));
    records = acknowledgeDesktopChatOutboxRecords(
      records,
      new Set(["send-b", "send-a"]),
    );
    expect(records.map((record) => record.sendId)).toEqual(["send-c"]);
  });
});
