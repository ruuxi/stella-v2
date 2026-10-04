import { expect, test } from "bun:test";
import type { ChatMessage } from "../../types";
import { mergeMessagesById } from "../chat-merge";
import { readReceipt } from "../message-time-labels";

const now = Date.now();
const user: ChatMessage = { id: "user", role: "user", text: "Hello", createdAt: now };
const placeholder: ChatMessage = { id: "reply", role: "assistant", text: "", createdAt: now };

test("an idle send never flashes Read when acknowledged before its reply", () => {
  expect(readReceipt([user, placeholder], now)).toBeNull();
  const acknowledged = mergeMessagesById([user, placeholder], [{ ...user, sequence: 1 }]);
  expect(readReceipt(acknowledged, now)).toBeNull();
});

test("a send while busy shows Read only after dispatch, survives reconciliation, and clears on reply", () => {
  const queued = { ...user, queued: true, sentWhileBusy: true };
  expect(readReceipt([queued], now)).toBeNull();
  const dispatched = { ...queued, queued: false, canonicalId: "canonical-user" };
  expect(readReceipt([dispatched, placeholder], now)?.id).toBe("user");
  const acknowledged = mergeMessagesById([dispatched, placeholder], [
    { ...user, id: "canonical-user", sequence: 1 },
  ]);
  expect(readReceipt(acknowledged, now)?.id).toBe("user");
  expect(readReceipt([...acknowledged, { ...placeholder, id: "answer", text: "Hello back" }], now)).toBeNull();
});

test("a later idle send does not inherit a busy message's receipt", () => {
  expect(readReceipt([
    { ...user, sentWhileBusy: true, sequence: 1 },
    { ...user, id: "next", sequence: 2 },
    placeholder,
  ], now)).toBeNull();
});
