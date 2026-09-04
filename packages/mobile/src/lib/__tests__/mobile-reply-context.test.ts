import { expect, test } from "bun:test";
import { mobileReplyContexts, mobileReplyLineage } from "../mobile-reply-context";
import { projectCloudConversationMessages } from "../cloud-journal-projection";
import type { ChatMessage } from "../../types";
import type { JournalRecord } from "../cloud-conversation-protocol";

test("adjacent replies stay plain and delayed work has one label and a focused chain", () => {
  const ref = { kind: "message", id: "u1", role: "user", preview: "Research", sequence: 1 } as const;
  const messages: ChatMessage[] = [
    { id: "u1", role: "user", text: "Research" },
    { id: "a1", role: "assistant", text: "On it", replyRefs: [ref] },
    { id: "u2", role: "user", text: "Other work" },
    { id: "a2", role: "assistant", text: "Results", replyRefs: [ref] },
  ];
  expect(mobileReplyContexts(messages).has("a1")).toBe(false);
  expect(mobileReplyContexts(messages).get("a2")).toEqual(ref);
  expect(mobileReplyLineage(messages, ref).map(m => m.id)).toEqual(["u1", "a1", "a2"]);
});

test("cloud journal preserves references and settles a spawn-anchored lifecycle row", () => {
  const records: JournalRecord[] = [
    { kind: "message", seq: 1, turnId: "t", createdAtMs: 1, role: "user", hidden: false, clientMsgId: "u", payload: { content: "Research" } },
    { kind: "message", seq: 2, turnId: "t", createdAtMs: 2, role: "assistant", hidden: false, payload: { content: "Starting" } },
    { kind: "card", seq: 3, turnId: "t", createdAtMs: 3, card: { type: "agent-lifecycle", eventId: "start", event: { type: "agent-started", payload: { agentId: "agent", attemptGeneration: 1, description: "Research", agentType: "general" } } } },
    { kind: "message", seq: 4, turnId: "wake", createdAtMs: 4, role: "assistant", hidden: false, payload: { content: "Results\n```refs\nagent:agent\n```" } },
    { kind: "card", seq: 5, turnId: "wake", createdAtMs: 5, card: { type: "agent-lifecycle", eventId: "finish", event: { type: "agent-completed", payload: { agentId: "agent", attemptGeneration: 1, result: "Saved report" } } } },
  ];
  const messages = projectCloudConversationMessages({ records, conversationId: "c" });
  expect(messages[1]?.artifacts?.[0]?.payload).toMatchObject({ title: "Research", state: "done", agentIds: ["agent"] });
  expect(messages[2]?.replyRefs).toEqual([{ kind: "agent", threadId: "agent", title: "Research" }]);
  expect(messages[2]?.text).toBe("Results");
});

test("desktop-resolved references survive canonical projection", () => {
  const ref = { kind: "agent", threadId: "local-agent", title: "Local research" } as const;
  const messages = projectCloudConversationMessages({ records: [{
    kind: "message", seq: 1, turnId: "desktop-turn", createdAtMs: 1, role: "assistant", hidden: false,
    payload: { content: "Finished", metadata: { runtime: { replyRefs: [ref] } } },
  }] });
  expect(messages[0]?.replyRefs).toEqual([ref]);
});
