import { expect, test } from "bun:test";
import type { ChatMessage } from "../../types";
import { readReceipt } from "../message-time-labels";

const now = Date.now();
const user: ChatMessage = { id: "user", role: "user", text: "Hello", createdAt: now };
const placeholder: ChatMessage = { id: "reply", role: "assistant", text: "", createdAt: now };

test("a later idle send does not inherit a busy message's receipt", () => {
  expect(readReceipt([
    { ...user, sentWhileBusy: true, sequence: 1 },
    { ...user, id: "next", sequence: 2 },
    placeholder,
  ], now)).toBeNull();
});
