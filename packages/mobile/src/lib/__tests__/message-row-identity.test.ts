import { expect, test } from "bun:test";
import { visibleChatMessages } from "../message-row-identity";
import { mobileReplyContexts } from "../mobile-reply-context";
import type { ChatMessage, ChatArtifact } from "../../types";

const reply = (id: string, text = ""): ChatMessage => ({ id, role: "assistant", text });
const work = (completion = false): ChatArtifact => ({
  id: "work", conversationId: "c", payload: {
    kind: "agent-work", state: completion ? "done" : "running", completion,
    agentIds: ["agent"], total: 1, completed: completion ? 1 : 0,
    title: "Research", subtitle: "", createdAt: 1,
  },
});

test("tool-only and activity-only rows consume no list cells between replies", () => {
  const first = reply("first", "Working on it.");
  const last = reply("last", "Finished.");
  const messages = [first, ...Array.from({ length: 10 }, (_, i) => ({
    ...reply(`tool-${i}`, " \n "),
    toolSteps: [{ id: `step-${i}`, toolName: "read_file", status: "completed" as const }],
  })), { ...reply("activity"), artifacts: [work()] }, last];
  expect(visibleChatMessages(messages)).toEqual([first, last]);
  expect(messages).toHaveLength(13);
});

test("visible transcripts keep their array identity and user attachments", () => {
  const messages: ChatMessage[] = [
    { id: "user", role: "user", text: "", documentNames: ["report.pdf"] },
    reply("answer", "Here it is."),
  ];
  expect(visibleChatMessages(messages)).toBe(messages);
});

test("empty pending reply appears under its original id once text lands", () => {
  const pending = reply("pending");
  expect(visibleChatMessages([pending])).toEqual([]);
  const landed = { ...pending, text: "Hello." };
  expect(visibleChatMessages([landed])).toEqual([landed]);
});

test("schedule receipts remain visible but JSON and failed tools do not", () => {
  const receipt = { ...reply("receipt"), toolSteps: [{ id: "s", toolName: "Schedule", status: "completed" as const, resultPreview: "Scheduled for tomorrow." }] };
  expect(visibleChatMessages([
    receipt,
    { ...receipt, id: "json", toolSteps: [{ ...receipt.toolSteps[0], resultPreview: '{"schedule":true}' }] },
    { ...receipt, id: "failed", toolSteps: [{ ...receipt.toolSteps[0], status: "error" }] },
  ])).toEqual([receipt]);
});

test("completion quotes and stopped/offline notices remain visible", () => {
  const messages = [
    { ...reply("completion"), artifacts: [work(true)] },
    { ...reply("stopped"), stopped: true },
    { ...reply("offline"), cloudFallback: true },
  ];
  expect(visibleChatMessages(messages)).toBe(messages);
  expect(visibleChatMessages([{ ...reply("followup"), artifacts: [{ ...work(true), payload: { ...work(true).payload, followUp: true } } as ChatArtifact] }])).toEqual([]);
});

test("file-only rows depend on an opener; image-only rows do not", () => {
  const file = { ...reply("file"), artifacts: [{ id: "file", conversationId: "c", payload: { kind: "pdf", filePath: "/report.pdf" } } as ChatArtifact] };
  const image = { ...reply("image"), artifacts: [{ id: "image", conversationId: "c", payload: { kind: "media", asset: { kind: "image", filePaths: ["/image.png"] }, createdAt: 1 } } as ChatArtifact] };
  expect(visibleChatMessages([file, image])).toEqual([file, image]);
  expect(visibleChatMessages([file, image], { canOpenArtifacts: false })).toEqual([image]);
});

test("reply relationships use hidden activity owners and retain visible context chips", () => {
  const messages = [
    { id: "ask", role: "user" as const, text: "Research" },
    { ...reply("owner"), spawnedThreadIds: ["agent"] },
    { id: "other", role: "user" as const, text: "Something else" },
    { ...reply("context"), replyRefs: [{ kind: "agent" as const, threadId: "agent", title: "Research" }] },
  ];
  const contexts = mobileReplyContexts(messages);
  expect(contexts.contexts.has("context")).toBe(true);
  expect(visibleChatMessages(messages, { contextMessageIds: contexts.contexts }).map(m => m.id)).toEqual(["ask", "other", "context"]);
});
