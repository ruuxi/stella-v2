/// <reference types="vite/client" />

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const OWNER_ID = "owner:cloud-thread-context-boundary";
const OWNER_GENERATION = "generation:cloud-thread-context-boundary";
const THREAD_ID = "thread:cloud-thread-context-boundary";

const createTest = () => {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  return t;
};

const seedThread = async () => {
  const t = createTest();
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId: OWNER_ID,
      generation: OWNER_GENERATION,
      state: "open",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("cloud_agent_threads", {
      threadId: THREAD_ID,
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      attemptGeneration: 1,
      conversationId: "conversation:cloud-thread-context-boundary",
      description: "Context boundary regression thread",
      workspace: "cloud",
      agentType: "general",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    });
  });
  return t;
};

const appendRows = async (
  t: ReturnType<typeof createTest>,
  roles: string[],
  malformedSeq?: number,
) => {
  await t.run(async (ctx) => {
    for (const [seq, role] of roles.entries()) {
      await ctx.db.insert("cloud_thread_messages", {
        conversationId: THREAD_ID,
        ownerId: OWNER_ID,
        seq,
        ordinal: seq,
        role,
        payloadJson:
          seq === malformedSeq
            ? "{"
            : JSON.stringify({ role, content: `message-${seq}` }),
        turnId: `turn:${Math.floor(seq / 3)}`,
        createdAt: seq + 1,
      });
    }
  });
};

const listContext = async (t: ReturnType<typeof createTest>) =>
  await t.query(internal.cloud_apps.listThreadMessagesInternal, {
    ownerId: OWNER_ID,
    ownerGeneration: OWNER_GENERATION,
    threadId: THREAD_ID,
  });

describe("cloud agent thread context boundary", () => {
  it("trims a row-limited suffix forward to a safe user boundary", async () => {
    const t = await seedThread();
    const roles = Array.from({ length: 401 }, () => "assistant");
    roles[0] = "user";
    roles[2] = "user";
    await appendRows(t, roles);

    const context = await listContext(t);

    expect(context).toHaveLength(399);
    expect(context[0]).toMatchObject({ seq: 2, role: "user" });
    expect(context[context.length - 1]).toMatchObject({
      seq: 400,
      role: "assistant",
    });
  });

  it("returns empty history when the bounded suffix has no user boundary", async () => {
    const t = await seedThread();
    const roles = Array.from({ length: 401 }, () => "assistant");
    roles[0] = "user";
    roles[1] = "toolResult";
    await appendRows(t, roles);

    await expect(listContext(t)).resolves.toEqual([]);
  });

  it("rejects a malformed leading orphan before trimming to a user", async () => {
    const t = await seedThread();
    const roles = Array.from({ length: 401 }, () => "assistant");
    roles[0] = "user";
    roles[1] = "toolResult";
    roles[2] = "user";
    await appendRows(t, roles, 1);

    await expect(listContext(t)).rejects.toThrow(/invalid JSON/iu);
  });
});
