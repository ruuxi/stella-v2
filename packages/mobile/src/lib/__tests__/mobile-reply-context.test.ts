import { expect, test } from "bun:test";
import { mobileReplyContexts, mobileReplyLineage } from "../mobile-reply-context";
import { projectCloudConversationMessages } from "../cloud-journal-projection";
import type { ChatMessage } from "../../types";
import type { JournalRecord } from "../cloud-conversation-protocol";

test("adjacent replies stay plain and delayed work has one label, a reply count, and a focused chain", () => {
  const ref = { kind: "message", id: "u1", role: "user", preview: "Research", sequence: 1 } as const;
  const messages: ChatMessage[] = [
    { id: "u1", role: "user", text: "Research" },
    { id: "a1", role: "assistant", text: "On it", replyRefs: [ref] },
    { id: "u2", role: "user", text: "Other work" },
    { id: "a2", role: "assistant", text: "Results", replyRefs: [ref] },
  ];
  const projected = mobileReplyContexts(messages);
  expect(projected.contexts.has("a1")).toBe(false);
  expect(projected.contexts.get("a2")).toEqual(ref);
  // Only the distant reply counts toward the badge under the ask.
  expect(projected.counts.messages).toEqual({ u1: 1 });
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
  // The completion sits right under the exchange that spawned the task: no
  // quote bubble, and the task's settled state is known for the glyph.
  const projected = mobileReplyContexts(messages);
  expect(projected.contexts.has(messages[2]!.id)).toBe(false);
  expect(projected.agentStates.get("agent")).toBe("completed");
});

test("desktop-resolved references survive canonical projection", () => {
  const ref = { kind: "agent", threadId: "local-agent", title: "Local research" } as const;
  const messages = projectCloudConversationMessages({ records: [{
    kind: "message", seq: 1, turnId: "desktop-turn", createdAtMs: 1, role: "assistant", hidden: false,
    payload: { content: "Finished", metadata: { runtime: { replyRefs: [ref] } } },
  }] });
  expect(messages[0]?.replyRefs).toEqual([ref]);
});

test("focused task contexts omit unrelated exchanges and retain links to other work", () => {
  const first = { kind: "agent", threadId: "first", title: "First task" } as const;
  const second = { kind: "agent", threadId: "second", title: "Second task" } as const;
  const messages: ChatMessage[] = [
    { id: "u1", canonicalId: "canonical-u1", role: "user", text: "Research" },
    {
      id: "spawn",
      requestId: "canonical-u1",
      role: "assistant",
      text: "Starting",
      artifacts: [
        {
          id: "work",
          conversationId: "c",
          payload: {
            kind: "agent-work",
            agentIds: ["first"],
            title: "First task",
            subtitle: "",
            state: "running",
            total: 1,
            completed: 0,
            createdAt: 1,
          },
        },
      ],
    },
    { id: "u2", role: "user", text: "Unrelated" },
    { id: "result", role: "assistant", text: "Result", replyRefs: [first] },
    { id: "combined", role: "assistant", text: "Related work", replyRefs: [second, first] },
  ];
  const projected = mobileReplyContexts(messages);
  expect(projected.contexts.get("result")).toEqual(first);
  expect(projected.agentStates.get("first")).toBe("running");
  const focused = mobileReplyLineage(messages, first);
  expect(focused.map((message) => message.id)).toEqual(["u1", "spawn", "result", "combined"]);
  const inFocus = mobileReplyContexts(focused);
  expect(inFocus.contexts.has("result")).toBe(false);
  expect(inFocus.contexts.get("combined")).toEqual(second);
});

test("a reconciled user row is counted under either of its ids", () => {
  const ref = { kind: "message", id: "canonical-u1", role: "user", preview: "Research", sequence: 1 } as const;
  const messages: ChatMessage[] = [
    { id: "u1", canonicalId: "canonical-u1", role: "user", text: "Research" },
    { id: "a1", role: "assistant", text: "On it", requestId: "canonical-u1" },
    { id: "u2", role: "user", text: "Other" },
    { id: "a2", role: "assistant", text: "Back to it", replyRefs: [ref] },
  ];
  const projected = mobileReplyContexts(messages);
  expect(projected.contexts.get("a2")).toEqual(ref);
  expect(projected.counts.messages["canonical-u1"]).toBe(1);
  // The ask's own turn reply rides the chain alongside the distant return.
  expect(mobileReplyLineage(messages, ref).map(m => m.id)).toEqual(["u1", "a1", "a2"]);
});

test("a message-rooted chain carries its turn's reply and the updates on tasks that turn spawned", () => {
  const task = { kind: "agent", threadId: "pricing", title: "Pricing research" } as const;
  const messages: ChatMessage[] = [
    { id: "u1", role: "user", text: "Compare vendor pricing" },
    {
      id: "spawn",
      requestId: "u1",
      role: "assistant",
      text: "On it",
      artifacts: [{ id: "work", conversationId: "c", payload: {
        kind: "agent-work", agentIds: ["pricing"], title: "Pricing research", subtitle: "",
        state: "done", total: 1, completed: 1, createdAt: 1,
      } }],
    },
    { id: "u2", role: "user", text: "Something else" },
    { id: "a2", role: "assistant", text: "Sure", requestId: "u2" },
    { id: "done", role: "assistant", text: "Pricing research is done", replyRefs: [task] },
  ];
  const projected = mobileReplyContexts(messages);
  // The completion is distant from its ask, so the ask's badge counts it.
  expect(projected.counts.messages).toEqual({ u1: 1 });
  expect(projected.contexts.get("done")).toEqual(task);
  const root = { kind: "message", id: "u1", role: "user", preview: "Compare vendor pricing", sequence: 1 } as const;
  expect(mobileReplyLineage(messages, root).map(m => m.id)).toEqual(["u1", "spawn", "done"]);
});

test("a spawn known only from its request description still owns the task for its exchange", () => {
  const records: JournalRecord[] = [
    { kind: "message", seq: 1, turnId: "t", createdAtMs: 1, role: "user", hidden: false, clientMsgId: "u", payload: { content: "Wait then report" } },
    { kind: "message", seq: 2, turnId: "t", createdAtMs: 2, role: "assistant", hidden: false, payload: { content: [{ type: "text", text: "started" }, { type: "toolCall", id: "call-1", name: "spawn_agent", arguments: { description: "20s waiter" } }] } },
    { kind: "message", seq: 3, turnId: "t", createdAtMs: 3, role: "toolResult", hidden: false, payload: { toolCallId: "call-1", toolName: "spawn_agent", content: "started" } },
    { kind: "message", seq: 4, turnId: "wake", createdAtMs: 4, role: "user", hidden: true, payload: { content: "[Agent completed]\ndescription: 20s waiter\nthread_id: waiter\nresult: done" } },
    { kind: "message", seq: 5, turnId: "wake", createdAtMs: 5, role: "assistant", hidden: false, payload: { content: "done waiting\n```refs\nagent:waiter\n```" } },
  ];
  const messages = projectCloudConversationMessages({ records, conversationId: "c" });
  expect(messages.map(m => m.id).length).toBe(3);
  // A locally executed turn leaves no thread id on the spawn result; the
  // request's description matches the title the report cites.
  expect(messages[1]?.spawnedThreadIds).toBeUndefined();
  expect(messages[1]?.spawnedDescriptions).toEqual(["20s waiter"]);
  expect(messages[2]?.replyRefs).toEqual([{ kind: "agent", threadId: "waiter", title: "20s waiter" }]);
  const projected = mobileReplyContexts(messages);
  expect(projected.contexts.has(messages[2]!.id)).toBe(false);
  expect(projected.counts).toEqual({ messages: {}, agents: {} });
});

test("a spawn description matches the slugged thread id when the report carries no title", () => {
  const waiter = { kind: "agent", threadId: "20s-waiter", title: "" } as const;
  const messages: ChatMessage[] = [
    { id: "u1", role: "user", text: "Wait then report" },
    { id: "ack", requestId: "u1", role: "assistant", text: "started", spawnedDescriptions: ["20s waiter"] },
    { id: "done", role: "assistant", text: "done waiting", replyRefs: [waiter] },
  ];
  expect(mobileReplyContexts(messages).contexts.has("done")).toBe(false);
  const root = { kind: "message", id: "u1", role: "user", preview: "Wait then report", sequence: 1 } as const;
  expect(mobileReplyLineage(messages, root).map(m => m.id)).toEqual(["u1", "ack", "done"]);
});
