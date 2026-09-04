/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const getReport = makeFunctionReference<"query", { conversationId: string; threadId: string }, { resultJson?: string } | null>("cloud_apps:getMyAgentThread");

it("reads an old task's full result only for its owner and conversation", async () => {
  const t = convexTest(schema, modules);
  const resultJson = JSON.stringify({ finalText: "Full report. ".repeat(2000) });
  await t.run(async ctx => {
    for (let index = 0; index < 35; index++) {
      await ctx.db.insert("cloud_agent_threads", {
        threadId: `thread-${index}`, ownerId: "owner", conversationId: "conversation",
        description: "Research", placement: "cloud", agentType: "general",
        status: "completed", createdAt: index, updatedAt: index, resultJson,
        workspaceForkId: "workspace-fork",
      });
    }
  });
  const owner = t.withIdentity({ subject: "owner", tokenIdentifier: "owner" });
  expect(await owner.query(getReport, { conversationId: "conversation", threadId: "thread-0" })).toMatchObject({ resultJson });
  expect(await owner.query(getReport, { conversationId: "other", threadId: "thread-0" })).toBeNull();
  expect(await owner.query(getReport, { conversationId: "conversation", threadId: "missing" })).toBeNull();
  expect(await t.withIdentity({ subject: "other", tokenIdentifier: "other" }).query(getReport, { conversationId: "conversation", threadId: "thread-0" })).toBeNull();
  await expect(t.query(getReport, { conversationId: "conversation", threadId: "thread-0" })).rejects.toThrow();
});
