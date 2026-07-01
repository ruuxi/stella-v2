import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../../types";
import { mergeMessagesById, reconcileSentDesktopTurn } from "../chat-merge";

const user = (id: string, text: string, extra?: Partial<ChatMessage>): ChatMessage => ({
  id,
  role: "user",
  text,
  ...extra,
});

const assistant = (
  id: string,
  text: string,
  extra?: Partial<ChatMessage>,
): ChatMessage => ({
  id,
  role: "assistant",
  text,
  ...extra,
});

const ids = (messages: ChatMessage[]) => messages.map((m) => m.id);

describe("mergeMessagesById", () => {
  test("matches by canonicalId and keeps the local id and timestamp", () => {
    const current = [
      user("local-1", "hi", { canonicalId: "desk-1", createdAt: 100 }),
    ];
    const incoming = [user("desk-1", "hi", { createdAt: 90 })];
    const merged = mergeMessagesById(current, incoming);
    expect(ids(merged)).toEqual(["local-1"]);
    expect(merged[0]?.createdAt).toBe(100);
    expect(merged[0]?.canonicalId).toBe("desk-1");
  });

  test("does not duplicate when the canonical row is re-delivered (task anchors)", () => {
    const current = [
      user("local-1", "run the task", { canonicalId: "desk-1", createdAt: 100 }),
      assistant("local-2", "on it", { canonicalId: "desk-2", createdAt: 101 }),
    ];
    const incoming = [
      user("desk-1", "run the task", { createdAt: 95 }),
      assistant("desk-2", "on it", { createdAt: 96 }),
    ];
    expect(ids(mergeMessagesById(current, incoming))).toEqual([
      "local-1",
      "local-2",
    ]);
  });

  test("collapses an unlinked canonical twin into the linked local row", () => {
    // A mid-turn sync merged desk-1 as its own row before the reconcile linked
    // the optimistic bubble; the next delivery of desk-1 heals the duplicate.
    const current = [
      user("local-1", "hello", { canonicalId: "desk-1", createdAt: 100 }),
      user("desk-1", "hello", { createdAt: 95 }),
    ];
    const incoming = [user("desk-1", "hello", { createdAt: 95 })];
    const merged = mergeMessagesById(current, incoming);
    expect(ids(merged)).toEqual(["local-1"]);
    expect(merged[0]?.createdAt).toBe(100);
  });

  test("links a late-arriving canonical reply by requestId instead of duplicating", () => {
    const current = [
      user("local-u", "question", { canonicalId: "desk-u", createdAt: 100 }),
      assistant("local-a", "answer", { requestId: "desk-u", createdAt: 101 }),
    ];
    const incoming = [
      assistant("desk-a", "answer", { requestId: "desk-u", createdAt: 96 }),
    ];
    const merged = mergeMessagesById(current, incoming);
    expect(ids(merged)).toEqual(["local-u", "local-a"]);
    expect(merged[1]?.canonicalId).toBe("desk-a");
    expect(merged[1]?.createdAt).toBe(101);
  });

  test("never links stand-in artifact rows by requestId", () => {
    const current = [
      assistant("local-a", "answer", { requestId: "desk-u", createdAt: 101 }),
    ];
    const incoming = [
      assistant("desk-u:agent", "", {
        requestId: "desk-u",
        createdAt: 90,
        artifacts: [],
      }),
    ];
    const merged = mergeMessagesById(current, incoming);
    expect(ids(merged)).toContain("local-a");
    expect(ids(merged)).toContain("desk-u:agent");
    expect(merged.find((m) => m.id === "local-a")?.text).toBe("answer");
  });

  test("does not link user rows by text (repeat messages stay distinct)", () => {
    const current = [user("local-1", "ok", { createdAt: 100 })];
    const incoming = [user("desk-9", "ok", { createdAt: 50 })];
    expect(mergeMessagesById(current, incoming)).toHaveLength(2);
  });

  test("sorts merged rows chronologically with stable ties", () => {
    const current = [
      user("a", "first", { createdAt: 100 }),
      assistant("b", "second", { createdAt: 200 }),
    ];
    const incoming = [assistant("c", "between", { createdAt: 150 })];
    expect(ids(mergeMessagesById(current, incoming))).toEqual(["a", "c", "b"]);
  });
});

describe("reconcileSentDesktopTurn", () => {
  const baseTurn = () => ({
    userMessageId: "local-u",
    replyId: "local-a",
    sentText: "do the thing",
    current: [
      user("local-u", "do the thing", { createdAt: 100 }),
      assistant("local-a", "done!", { createdAt: 101 }),
    ],
  });

  test("links optimistic rows to canonical ids and keeps local anchors", () => {
    const result = reconcileSentDesktopTurn({
      ...baseTurn(),
      canonicalMessages: [
        user("desk-u", "do the thing", { createdAt: 90 }),
        assistant("desk-a", "done!", { requestId: "desk-u", createdAt: 91 }),
      ],
      canonicalUserMessageId: "desk-u",
    });
    expect(ids(result)).toEqual(["local-u", "local-a"]);
    expect(result[0]?.canonicalId).toBe("desk-u");
    expect(result[1]?.canonicalId).toBe("desk-a");
    expect(result[0]?.createdAt).toBe(100);
    expect(result[1]?.createdAt).toBe(101);
  });

  test("evicts canonical twins a mid-turn sync already merged", () => {
    const turn = baseTurn();
    const result = reconcileSentDesktopTurn({
      ...turn,
      current: [
        ...turn.current,
        // Duplicates merged mid-turn by the task poll.
        user("desk-u", "do the thing", { createdAt: 90 }),
        assistant("desk-a", "done!", { createdAt: 91 }),
      ],
      canonicalMessages: [
        user("desk-u", "do the thing", { createdAt: 90 }),
        assistant("desk-a", "done!", { requestId: "desk-u", createdAt: 91 }),
      ],
      canonicalUserMessageId: "desk-u",
    });
    expect(ids(result)).toEqual(["local-u", "local-a"]);
  });

  test("never adopts a stand-in artifact row as the canonical reply", () => {
    const result = reconcileSentDesktopTurn({
      ...baseTurn(),
      canonicalMessages: [
        user("desk-u", "do the thing", { createdAt: 90 }),
        assistant("desk-a", "done!", { requestId: "desk-u", createdAt: 91 }),
        assistant("desk-u:agent", "", {
          requestId: "desk-u",
          createdAt: 92,
          artifacts: [],
        }),
      ],
      canonicalUserMessageId: "desk-u",
    });
    const reply = result.find((m) => m.id === "local-a");
    expect(reply?.canonicalId).toBe("desk-a");
    expect(reply?.text).toBe("done!");
  });

  test("picks the reply by requestId when the delta spans other turns", () => {
    const result = reconcileSentDesktopTurn({
      ...baseTurn(),
      canonicalMessages: [
        user("desk-u", "do the thing", { createdAt: 90 }),
        assistant("desk-a", "done!", { requestId: "desk-u", createdAt: 91 }),
        // A desktop-side turn that finished after ours.
        user("desk-u2", "unrelated", { createdAt: 92 }),
        assistant("desk-a2", "other reply", {
          requestId: "desk-u2",
          createdAt: 93,
        }),
      ],
      canonicalUserMessageId: "desk-u",
    });
    const reply = result.find((m) => m.id === "local-a");
    expect(reply?.canonicalId).toBe("desk-a");
    expect(reply?.text).toBe("done!");
    // The desktop-side turn still merges as its own rows.
    expect(ids(result)).toContain("desk-u2");
    expect(ids(result)).toContain("desk-a2");
  });

  test("falls back to text/last-assistant matching without a canonical id", () => {
    const result = reconcileSentDesktopTurn({
      ...baseTurn(),
      canonicalMessages: [
        user("desk-u", "do the thing", { createdAt: 90 }),
        assistant("desk-a", "done!", { createdAt: 91 }),
      ],
    });
    expect(result.find((m) => m.id === "local-u")?.canonicalId).toBe("desk-u");
    expect(result.find((m) => m.id === "local-a")?.canonicalId).toBe("desk-a");
  });
});
