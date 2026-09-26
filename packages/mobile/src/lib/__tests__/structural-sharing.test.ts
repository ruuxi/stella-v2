import { describe, expect, test } from "bun:test";
import { replaceEqualDeep, reuseEqualChatMessages } from "../structural-sharing";
import { projectCloudConversationMessages } from "../cloud-journal-projection";
import type { JournalRecord } from "../cloud-conversation-protocol";
import type { ChatMessage } from "../../types";
import { syntheticJournal } from "./fixtures/synthetic-journal";

const project = (records: readonly JournalRecord[]) =>
  projectCloudConversationMessages({ conversationId: "c", records });

/** Rows the list would re-render: those whose object identity changed. */
const changedRows = (before: readonly ChatMessage[], after: readonly ChatMessage[]) => {
  const previous = new Map(before.map((message) => [message.id, message]));
  return after.filter((message) => previous.get(message.id) !== message).map((message) => message.id);
};

describe("structural sharing", () => {
  test("returns the previous value for deep-equal input and shares equal branches otherwise", () => {
    const previous = { a: [1, { b: 2 }], c: { d: "x" } };
    expect(replaceEqualDeep(previous, { a: [1, { b: 2 }], c: { d: "x" } })).toBe(previous);
    const next = replaceEqualDeep(previous, { a: [1, { b: 2 }], c: { d: "y" } });
    expect(next).toEqual({ a: [1, { b: 2 }], c: { d: "y" } });
    expect(next.a).toBe(previous.a);
    expect(next.c === previous.c).toBe(false);
    // A key that appears (even as undefined) is a change.
    expect(replaceEqualDeep({ a: 1 }, { a: 1, b: undefined })).toEqual({ a: 1, b: undefined });
  });

  // Ratchet: a committed journal record must re-render only the rows it
  // changed. The projection rebuilds every row from scratch, so without
  // sharing this was every row in the transcript (1,200 of 1,200 here).
  test("a record that changes no visible row keeps the transcript array itself", () => {
    const records = syntheticJournal(400);
    const before = project(records.slice(0, -1));
    const after = reuseEqualChatMessages(before, project(records));
    expect(after).toBe(before);
  });

  test("a landed reply re-renders only its own row", () => {
    const records = syntheticJournal(400);
    const replyIndex = records.findLastIndex(
      (record) => record.kind === "message" && record.role === "assistant",
    );
    const before = project(records.slice(0, replyIndex));
    const next = project(records.slice(0, replyIndex + 1));
    const after = reuseEqualChatMessages(before, next);
    expect(after).toEqual(next);
    expect(changedRows(before, after)).toEqual([next.at(-1)!.id]);
  });

  test("keeps rows stable when an optimistic row is inserted ahead of them", () => {
    const records = syntheticJournal(20);
    const before = project(records);
    const optimistic: ChatMessage = { id: "local", role: "user", text: "hi" };
    const next = [...project(records).slice(0, 5), optimistic, ...project(records).slice(5)];
    const after = reuseEqualChatMessages(before, next);
    expect(after).toEqual(next);
    expect(changedRows(before, after)).toEqual(["local"]);
  });
});
