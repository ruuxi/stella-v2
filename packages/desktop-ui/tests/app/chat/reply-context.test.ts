import { expect, it } from "vitest";
import { withReplyContext } from "@/features/chat/lib/reply-context";
import type { AssistantRowViewModel, EventRowViewModel } from "@/features/chat/conversation-row-types";
const user = (id: string): EventRowViewModel => ({ kind: "user", id, text: id, attachments: [] });
const reply = (id: string, refs: AssistantRowViewModel["replyRefs"]): AssistantRowViewModel => ({ kind: "assistant", id, text: id, cacheKey: id, replyRefs: refs });
const message = { kind: "message", id: "u1", role: "user", preview: "Request" } as const;
const agent = { kind: "agent", threadId: "a1", title: "Research" } as const;
const refs = (row: EventRowViewModel) => row.kind === "assistant" ? row.replyRefs : undefined;
it("hides adjacent answers but keeps a return after unrelated conversation", () => {
  const rows = withReplyContext([user("u1"), reply("r1", [message]), user("u2"), reply("r2", [message])]);
  expect(refs(rows[1]!)).toEqual([]);
  expect(refs(rows[3]!)).toEqual([message]);
});
it("prefers the work label over a repeated quotation and suppresses repeated labels", () => {
  const rows = withReplyContext([user("u2"), reply("r1", [message, agent]), reply("r2", [agent])]);
  expect(refs(rows[1]!)).toEqual([agent]);
  expect(refs(rows[2]!)).toEqual([]);
});
