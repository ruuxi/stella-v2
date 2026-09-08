import { describe, expect, it } from "vitest";
import {
  projectReplyContexts,
  replyCountFor,
  titleNamesThread,
  type ReplyContextRow,
} from "@stella/contracts/reply-context";

const message = {
  kind: "message",
  id: "u1",
  sequence: 1,
  role: "user",
  preview: "Research pricing",
} as const;
const agent = { kind: "agent", threadId: "a1", title: "Pricing research" } as const;

const user = (id: string, aliasIds?: string[]): ReplyContextRow => ({
  id,
  role: "user",
  ...(aliasIds ? { aliasIds } : {}),
});
const reply = (
  id: string,
  extra: Omit<ReplyContextRow, "id" | "role"> = {},
): ReplyContextRow => ({ id, role: "assistant", ...extra });

describe("projectReplyContexts", () => {
  it("hides a reply to the message directly above and shows a return after other conversation", () => {
    const { contexts, counts } = projectReplyContexts([
      user("u1"),
      reply("r1", { refs: [message] }),
      user("u2"),
      reply("r2", { refs: [message] }),
    ]);
    expect(contexts.has("r1")).toBe(false);
    expect(contexts.get("r2")).toEqual(message);
    expect(counts.messages).toEqual({ u1: 1 });
  });

  it("prefers the task over the quoted ask and stays quiet once the task is in the exchange", () => {
    const { contexts, counts } = projectReplyContexts([
      user("u2"),
      reply("r1", { refs: [message, agent] }),
      reply("r2", { refs: [agent] }),
    ]);
    expect(contexts.get("r1")).toEqual(agent);
    expect(contexts.has("r2")).toBe(false);
    // Both distant references on r1 count; r2 is adjacent to its task.
    expect(counts).toEqual({ messages: { u1: 1 }, agents: { a1: 1 } });
  });

  it("treats a task spawned in the current exchange as adjacent when it completes", () => {
    const { contexts, counts, agentOrigins } = projectReplyContexts([
      user("u1"),
      reply("spawn", { answersMessageIds: ["u1"], ownsAgentIds: ["a1"] }),
      reply("done", { refs: [agent] }),
    ]);
    expect(contexts.has("done")).toBe(false);
    expect(counts).toEqual({ messages: {}, agents: {} });
    expect(agentOrigins.get("a1")).toBe("u1");
  });

  it("counts a distant task report toward the ask that spawned the task, once per reply", () => {
    const { contexts, counts } = projectReplyContexts([
      user("u1"),
      reply("spawn", { ownsAgentIds: ["a1"] }),
      user("u2"),
      reply("r2"),
      reply("done", { refs: [agent, message] }),
      reply("more", { refs: [agent] }),
    ]);
    expect(contexts.get("done")).toEqual(agent);
    expect(contexts.has("more")).toBe(false);
    expect(counts).toEqual({ messages: { u1: 1 }, agents: { a1: 1 } });
  });

  it("carries the exchange through same-turn preambles and answered messages", () => {
    const { contexts } = projectReplyContexts([
      user("u1"),
      reply("pre", { ownsAgentIds: ["a1"] }),
      reply("final", { answersMessageIds: ["u1"], refs: [agent] }),
    ]);
    expect(contexts.has("final")).toBe(false);
  });

  it("lets a late final reply rejoin the ask it answers after the user interjected", () => {
    const { contexts } = projectReplyContexts([
      user("u1"),
      reply("pre", { answersMessageIds: ["u1"], ownsAgentIds: ["a1"] }),
      user("u2"),
      reply("final", { answersMessageIds: ["u1"], refs: [agent] }),
      reply("done", { refs: [agent] }),
    ]);
    expect(contexts.has("final")).toBe(false);
    expect(contexts.has("done")).toBe(false);
  });

  it("matches a reconciled message by any of its ids", () => {
    const canonical = { ...message, id: "canonical-u1" };
    const { contexts, counts } = projectReplyContexts([
      user("u1", ["canonical-u1"]),
      reply("r1", { refs: [canonical] }),
      user("u2"),
      reply("r2", { refs: [canonical] }),
    ]);
    expect(contexts.has("r1")).toBe(false);
    expect(contexts.get("r2")).toEqual(canonical);
    expect(replyCountFor(counts, ["u1", "canonical-u1"])).toBe(1);
  });
});

describe("projectReplyContexts: wake prompts and user-anchored spawns", () => {
  it("does not let a hidden wake row start a new exchange", () => {
    const { contexts, counts } = projectReplyContexts([
      user("u1"),
      reply("spawn", { ownsAgentIds: ["a1"] }),
      { id: "wake", role: "user", hidden: true },
      reply("done", { refs: [agent] }),
    ]);
    expect(contexts.has("done")).toBe(false);
    expect(counts).toEqual({ messages: {}, agents: {} });
  });

  it("treats a task spawned on the ask itself as part of that exchange", () => {
    const { contexts, counts, agentOrigins } = projectReplyContexts([
      { id: "u1", role: "user", ownsAgentIds: ["a1"] },
      reply("ack"),
      { id: "wake", role: "user", hidden: true },
      reply("done", { refs: [agent] }),
      user("u2"),
      reply("r2"),
      reply("later", { refs: [agent] }),
    ]);
    expect(contexts.has("done")).toBe(false);
    expect(contexts.get("later")).toEqual(agent);
    expect(agentOrigins.get("a1")).toBe("u1");
    expect(counts).toEqual({ messages: { u1: 1 }, agents: { a1: 1 } });
  });
});

describe("titleNamesThread", () => {
  it("matches a description to its slugged thread id and nothing else", () => {
    expect(titleNamesThread("20s waiter", "20s-waiter")).toBe(true);
    expect(titleNamesThread("Pricing research", "agent:pricing-research")).toBe(true);
    expect(titleNamesThread("Pricing research", "vendor-calls")).toBe(false);
    expect(titleNamesThread("", "x")).toBe(false);
  });
});
