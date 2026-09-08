import { expect, it } from "vitest";
import { withReplyContext } from "@/features/chat/lib/reply-context";
import type {
  AssistantRowViewModel,
  EventRowViewModel,
  UserRowViewModel,
} from "@/features/chat/conversation-row-types";

const user = (id: string): UserRowViewModel => ({ kind: "user", id, text: id, attachments: [] });
const reply = (
  id: string,
  refs: AssistantRowViewModel["replyRefs"],
  extra: Partial<AssistantRowViewModel> = {},
): AssistantRowViewModel => ({ kind: "assistant", id, text: id, cacheKey: id, replyRefs: refs, ...extra });
const message = { kind: "message", id: "u1", sequence: 1, role: "user", preview: "Request" } as const;
const agent = { kind: "agent", threadId: "a1", title: "Research" } as const;
const refs = (row: EventRowViewModel) => (row.kind === "assistant" ? row.replyRefs : undefined);
const count = (row: EventRowViewModel) => (row.kind === "user" ? row.replyCount : undefined);

it("hides adjacent answers, keeps a return after unrelated conversation, and counts it on the ask", () => {
  const rows = withReplyContext([user("u1"), reply("r1", [message]), user("u2"), reply("r2", [message])]);
  expect(refs(rows[1]!)).toEqual([]);
  expect(refs(rows[3]!)).toEqual([message]);
  expect(count(rows[0]!)).toBe(1);
  expect(count(rows[2]!)).toBeUndefined();
});

it("prefers the work label over a repeated quotation and suppresses repeated labels", () => {
  const rows = withReplyContext([user("u2"), reply("r1", [message, agent]), reply("r2", [agent])]);
  expect(refs(rows[1]!)).toEqual([agent]);
  expect(refs(rows[2]!)).toEqual([]);
});

it("treats a completion as adjacent to the exchange that spawned its task", () => {
  const rows = withReplyContext([
    user("u1"),
    reply("spawn", undefined, { replyToUserMessageId: "u1", backgroundWork: { threadIds: ["a1"] } as AssistantRowViewModel["backgroundWork"] }),
    reply("done", [agent]),
  ]);
  expect(refs(rows[2]!)).toEqual([]);
  expect(count(rows[0]!)).toBeUndefined();
});

it("leaves rows untouched when nothing changes", () => {
  const rows: EventRowViewModel[] = [user("u1"), reply("r1", undefined)];
  const projected = withReplyContext(rows);
  expect(projected[0]).toBe(rows[0]);
  expect(projected[1]).toBe(rows[1]);
});

it("keeps a completion quiet when its spawn was anchored on the ask and a hidden wake row precedes it", () => {
  const rows = withReplyContext([
    { ...user("u1"), spawnedThreadIds: ["a1"] },
    reply("ack", undefined, { replyToUserMessageId: "u1" }),
    { ...user("wake"), text: "", hidden: true },
    reply("done", [agent]),
    user("u2"),
    reply("r2", undefined, { replyToUserMessageId: "u2" }),
    reply("later", [agent]),
  ]);
  expect(refs(rows[3]!)).toEqual([]);
  expect(refs(rows[6]!)).toEqual([agent]);
  expect(count(rows[0]!)).toBe(1);
});

it("matches a spawn that only recorded its description to the task a later report cites by title", () => {
  const rows = withReplyContext([
    user("u1"),
    reply("ack", undefined, { replyToUserMessageId: "u1", spawnedDescriptions: ["Research"] }),
    { ...user("wake"), text: "", hidden: true },
    reply("done", [agent]),
    user("u2"),
    reply("r2", undefined, { replyToUserMessageId: "u2" }),
    reply("later", [agent]),
  ]);
  expect(refs(rows[3]!)).toEqual([]);
  expect(refs(rows[6]!)).toEqual([agent]);
  expect(count(rows[0]!)).toBe(1);
});

it("treats a content-less user row as a wake prompt and matches a spawn description to a slugged thread id", () => {
  const waiter = { kind: "agent", threadId: "20s-waiter", title: "" } as const;
  const rows = withReplyContext([
    user("u1"),
    reply("ack", undefined, { replyToUserMessageId: "u1", spawnedDescriptions: ["20s waiter"] }),
    { ...user("wake"), text: "" },
    reply("done", [waiter]),
  ]);
  expect(refs(rows[3]!)).toEqual([]);
});

it("uses Activity titles to tie a spawn description to its thread", () => {
  const research = { kind: "agent", threadId: "thread-9f2", title: "" } as const;
  const rows = withReplyContext(
    [
      user("u1"),
      reply("ack", undefined, { replyToUserMessageId: "u1", spawnedDescriptions: ["Pricing research"] }),
      { ...user("wake"), text: "" },
      reply("done", [research]),
    ],
    { agentTitles: new Map([["thread-9f2", "Pricing research"]]) },
  );
  expect(refs(rows[3]!)).toEqual([]);
});
