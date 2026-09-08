import { expect, test } from "bun:test";
import { mobileReplyContexts, mobileReplyLineage, summaryExcerpt } from "../mobile-reply-context";
import { projectCloudConversationMessages } from "../cloud-journal-projection";
import { decodeSequencedJournalEntry } from "../cloud-conversation-protocol";
import { consolidateRowArtifacts } from "../agent-artifact-consolidation";
import { readFileSync } from "node:fs";
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
  // Desktop parity: the reply that relays the result carries the completion
  // card, with the result excerpt standing in for files.
  expect(messages[2]?.artifacts?.map(a => a.payload)).toEqual([expect.objectContaining({
    kind: "agent-work", state: "done", completion: true, agentIds: ["agent"], title: "Research",
    agents: [{ agentId: "agent", title: "Research", files: [], summary: "Saved report" }],
  })]);
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

test("an untitled cited task takes its title from the spawn description that names its thread", () => {
  const records: JournalRecord[] = [
    { kind: "message", seq: 1, turnId: "t", createdAtMs: 1, role: "user", hidden: false, clientMsgId: "u", payload: { content: "Do the thing" } },
    { kind: "message", seq: 2, turnId: "t", createdAtMs: 2, role: "assistant", hidden: false, payload: { content: [{ type: "text", text: "on it" }, { type: "toolCall", id: "call-1", name: "spawn_agent", arguments: { description: "Sales deck" } }] } },
    { kind: "message", seq: 3, turnId: "t", createdAtMs: 3, role: "toolResult", hidden: false, payload: { toolCallId: "call-1", toolName: "spawn_agent", content: "started" } },
    { kind: "message", seq: 4, turnId: "u2", createdAtMs: 4, role: "user", hidden: false, clientMsgId: "u2", payload: { content: "Unrelated" } },
    { kind: "message", seq: 5, turnId: "u2", createdAtMs: 5, role: "assistant", hidden: false, payload: { content: "sure" } },
    { kind: "message", seq: 6, turnId: "wake", createdAtMs: 6, role: "user", hidden: true, payload: { content: "[Agent completed] (thread sales-deck)" } },
    { kind: "message", seq: 7, turnId: "wake", createdAtMs: 7, role: "assistant", hidden: false, payload: { content: "deck is ready\n```refs\nagent:sales-deck\n```" } },
  ];
  const messages = projectCloudConversationMessages({ records, conversationId: "c" });
  expect(messages.at(-1)?.replyRefs).toEqual([{ kind: "agent", threadId: "sales-deck", title: "Sales deck" }]);
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

test("a task's reported files ride its completion card on the relaying reply, not the spawn turn", () => {
  const records: JournalRecord[] = [
    { kind: "message", seq: 1, turnId: "t", createdAtMs: 1, role: "user", hidden: false, clientMsgId: "u", payload: { content: "Write a report" } },
    { kind: "message", seq: 2, turnId: "t", createdAtMs: 2, role: "assistant", hidden: false, payload: { content: [{ type: "toolCall", id: "call-1", name: "spawn_agent", arguments: { description: "Report writer" } }] } },
    { kind: "card", seq: 3, turnId: "t", createdAtMs: 3, card: { type: "agent-lifecycle", eventId: "start", event: { type: "agent-started", payload: { agentId: "writer", attemptGeneration: 1, description: "Report writer", agentType: "general" } } } },
    { kind: "message", seq: 4, turnId: "t", createdAtMs: 4, role: "toolResult", hidden: false, payload: { toolCallId: "call-1", toolName: "spawn_agent", content: "started" } },
    { kind: "message", seq: 5, turnId: "t", createdAtMs: 5, role: "assistant", hidden: false, payload: { content: "On it" } },
    { kind: "message", seq: 6, turnId: "wake", createdAtMs: 6, role: "user", hidden: true, payload: { content: "[Agent completed] Report writer (thread writer)" } },
    { kind: "card", seq: 7, turnId: "wake", createdAtMs: 7, card: { type: "agent-lifecycle", eventId: "finish", event: { type: "agent-completed", payload: { agentId: "writer", attemptGeneration: 1, result: "Done — see [report.md](/workspace/world/drive/report.md)" } } } },
    { kind: "card", seq: 8, turnId: "t", createdAtMs: 8, card: { type: "files", files: [{ path: "report.md", name: "report.md", sizeBytes: 12, contentType: "text/markdown", stored: true }] } },
    { kind: "message", seq: 9, turnId: "wake", createdAtMs: 9, role: "assistant", hidden: false, payload: { content: "Your report is ready.\n```refs\nagent:writer\n```" } },
  ];
  const messages = projectCloudConversationMessages({ records, conversationId: "c" });
  const spawnRows = messages.filter(m => m.requestId === "u");
  expect(spawnRows.flatMap(m => m.artifacts ?? []).map(a => a.payload.kind)).toEqual(["agent-work"]);
  const reply = messages.at(-1)!;
  expect(reply.text).toBe("Your report is ready.");
  const card = reply.artifacts?.find(a => a.payload.kind === "agent-work");
  expect(card?.payload).toMatchObject({ completion: true, state: "done", agents: [{ agentId: "writer", title: "Report writer", summary: "Done — see report.md" }] });
  const files = (card?.payload as { agents: Array<{ files: unknown[] }> }).agents[0]!.files;
  expect(files).toEqual([{ kind: "markdown", filePath: "report.md", title: "report.md", createdAt: 8, driveBacked: true }]);
  // The same file is an openable row artifact (for the activity hub) but not a second loose card.
  const loose = reply.artifacts?.filter(a => a.payload.kind !== "agent-work") ?? [];
  expect(loose.map(a => a.payload)).toEqual(files);
  const consolidated = consolidateRowArtifacts(reply.artifacts ?? []);
  expect(consolidated.looseFiles).toEqual([]);
  expect(consolidated.agentWork).toHaveLength(1);
  // The completion card does not make the relaying reply the task's spawn.
  const projected = mobileReplyContexts(messages);
  expect(projected.contexts.has(reply.id)).toBe(false);
});

test("a real cloud journal: the spawn card settles on the spawn turn and the relaying reply carries the completion card", () => {
  const raw = JSON.parse(readFileSync(new URL("./fixtures/cloud-journal-file-agent.json", import.meta.url).pathname, "utf8")) as unknown[];
  const records = raw.map(entry => decodeSequencedJournalEntry(entry)).filter((r): r is JournalRecord => r !== null);
  const messages = projectCloudConversationMessages({ records, conversationId: "c" });
  const spawn = messages.find(m => m.artifacts?.some(a => a.payload.kind === "agent-work" && !a.payload.completion));
  expect(spawn?.artifacts?.[0]?.payload).toMatchObject({ state: "done", title: "create hello.txt in drive" });
  const reply = messages.at(-1)!;
  expect(reply.text).toBe("done, hello.txt is in your drive with hi in it");
  const card = reply.artifacts?.[0]?.payload;
  expect(card?.kind).toBe("agent-work");
  const sections = card?.kind === "agent-work" ? card.agents ?? [] : [];
  expect(card?.kind === "agent-work" && card.completion).toBe(true);
  expect(sections).toEqual([{
    agentId: "e3e7b83a-ca68-454a-82d0-162714ff7390",
    title: "create hello.txt in drive",
    files: [],
    summary: "Done — created hello.txt containing the single word hi in the user's drive. hello.txt",
  }]);
  expect(mobileReplyContexts(messages).contexts.has(reply.id)).toBe(false);
});

test("summaryExcerpt keeps link text and cuts long results at a word", () => {
  expect(summaryExcerpt("## Done\n\n- wrote [a.md](/x/a.md)\n```js\ncode\n```")).toBe("Done wrote a.md");
  const long = summaryExcerpt(`${"word ".repeat(60)}end`);
  expect(long.length).toBeLessThanOrEqual(161);
  expect(long.endsWith("…")).toBe(true);
});

test("a real never-attached cloud run: the relaying reply carries the completion card with the delivered file pill", () => {
  const raw = JSON.parse(readFileSync(new URL("./fixtures/cloud-journal-write-only-agent.json", import.meta.url).pathname, "utf8")) as unknown[];
  const records = raw.map(entry => decodeSequencedJournalEntry(entry)).filter((r): r is JournalRecord => r !== null);
  const messages = projectCloudConversationMessages({ records, conversationId: "c" });
  const spawnRows = messages.filter(m => m.artifacts?.some(a => a.payload.kind === "agent-work" && !a.payload.completion));
  expect(spawnRows).toHaveLength(1);
  // The spawn turn shows only its settled spawn card; the file is not loose there.
  expect(spawnRows[0]!.artifacts?.map(a => a.payload.kind)).toEqual(["agent-work"]);
  const reply = messages.find(m => m.text.startsWith("done, it's in your drive"))!;
  const card = reply.artifacts?.[0]?.payload;
  const sections = card?.kind === "agent-work" ? card.agents ?? [] : [];
  expect(card?.kind === "agent-work" && card.completion).toBe(true);
  expect(sections).toHaveLength(1);
  expect(sections[0]?.title).toBe("create notes.md hello");
  expect(sections[0]?.files).toEqual([{ kind: "markdown", filePath: "notes.md", title: "notes.md", createdAt: expect.any(Number), driveBacked: true }]);
  expect(consolidateRowArtifacts(reply.artifacts ?? []).looseFiles).toEqual([]);
  expect(mobileReplyContexts(messages).contexts.has(reply.id)).toBe(false);
});
