import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../../types";
import { pickTurnReply } from "../turn-reply";

const user = (
  id: string,
  text: string,
  extra?: Partial<ChatMessage>,
): ChatMessage => ({ id, role: "user", text, ...extra });

const assistant = (
  id: string,
  text: string,
  extra?: Partial<ChatMessage>,
): ChatMessage => ({ id, role: "assistant", text, ...extra });

describe("pickTurnReply (auto-speak selection for a voice turn)", () => {
  test("picks the streamed reply that follows the sent user bubble", () => {
    const reply = pickTurnReply(
      [
        user("old-u", "earlier question", { createdAt: 50 }),
        assistant("old-a", "earlier answer", { createdAt: 51 }),
        user("local-u", "voice question", { createdAt: 100 }),
        assistant("local-a", "voice answer", { createdAt: 100 }),
      ],
      { sentUserMessageId: "local-u", priorReplyId: "old-a" },
    );
    expect(reply?.id).toBe("local-a");
  });

  test("never speaks an older desktop reply the pre-send sync merged in", () => {
    // Regression: on the computer target the send pipeline's own pre-send
    // sync can merge a desktop reply CarPlay had never seen. It sorts on its
    // older timestamp above the sent bubble — it is history, not the answer.
    const messages = [
      assistant("desk-old", "an old desktop answer", { createdAt: 90 }),
      user("local-u", "voice question", { createdAt: 100 }),
      assistant("local-a", "", { createdAt: 100 }), // reply still streaming
    ];
    // The old merged reply is "newest that changed" by the legacy rule, but
    // with the sent id known the picker must wait for THIS turn's reply.
    expect(
      pickTurnReply(messages, {
        sentUserMessageId: "local-u",
        priorReplyId: null,
      }),
    ).toBe(null);
    // Once the turn's reply lands, that row — and only that row — is spoken.
    const landed = messages.map((m) =>
      m.id === "local-a" ? { ...m, text: "voice answer" } : m,
    );
    expect(
      pickTurnReply(landed, {
        sentUserMessageId: "local-u",
        priorReplyId: null,
      })?.id,
    ).toBe("local-a");
  });

  test("anchors on the reconciled bubble via canonicalId too", () => {
    const reply = pickTurnReply(
      [
        user("local-u", "q", { canonicalId: "desk-u", createdAt: 100 }),
        assistant("local-a", "a", { requestId: "desk-u", createdAt: 101 }),
      ],
      { sentUserMessageId: "desk-u", priorReplyId: null },
    );
    expect(reply?.id).toBe("local-a");
  });

  test("skips empty stand-in rows between the bubble and the reply", () => {
    const reply = pickTurnReply(
      [
        user("local-u", "q", { createdAt: 100 }),
        assistant("desk-a:artifacts", "", { createdAt: 100 }),
        assistant("local-a", "the answer", { createdAt: 101 }),
      ],
      { sentUserMessageId: "local-u", priorReplyId: null },
    );
    expect(reply?.id).toBe("local-a");
  });

  test("waits (null) while the sent bubble isn't visible yet", () => {
    expect(
      pickTurnReply([assistant("old-a", "hello", { createdAt: 50 })], {
        sentUserMessageId: "local-u",
        priorReplyId: null,
      }),
    ).toBe(null);
  });

  test("fallback without a sent id: newest reply past the pre-send snapshot", () => {
    const messages = [
      assistant("old-a", "before", { createdAt: 50 }),
      assistant("new-a", "after", { createdAt: 60 }),
    ];
    expect(
      pickTurnReply(messages, { sentUserMessageId: null, priorReplyId: "old-a" })
        ?.id,
    ).toBe("new-a");
    expect(
      pickTurnReply(messages, {
        sentUserMessageId: null,
        priorReplyId: "new-a",
      }),
    ).toBe(null);
  });
});
