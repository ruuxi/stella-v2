/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import {
  makeFunctionReference,
  type PaginationOptions,
  type PaginationResult,
} from "convex/server";
import { describe, expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const OWNER_ID = "owner-a";
const OTHER_OWNER_ID = "owner-b";
const CONVERSATION_ID = "conversation-a";

type AgentThread = {
  threadId: string;
  ownerId: string;
  conversationId: string;
  description: string;
  placement: "cloud" | "computer";
  agentType: string;
  status: string;
  createdAt: number;
  updatedAt: number;
};

const listThreadsPage = makeFunctionReference<
  "query",
  {
    conversationId: string;
    identityRevision: number;
    paginationOpts: PaginationOptions;
  },
  PaginationResult<AgentThread>
>("cloud_apps:listMyAgentThreadsPage");
const listRunningThreads = makeFunctionReference<
  "query",
  { conversationId: string; identityRevision: number },
  AgentThread[]
>("cloud_apps:listMyRunningAgentThreads");

const createTest = () => convexTest(schema, modules);

const asOwner = (t: ReturnType<typeof createTest>, ownerId = OWNER_ID) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: ownerId,
    tokenIdentifier: ownerId,
    iat: 1_000,
  });

const insertThread = async (
  t: ReturnType<typeof createTest>,
  args: {
    threadId: string;
    ownerId: string;
    conversationId: string;
    updatedAt: number;
    status?: string;
  },
) => {
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_agent_threads", {
      threadId: args.threadId,
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      description: `Work ${args.threadId}`,
      placement: "cloud",
      agentType: "general",
      status: args.status ?? "completed",
      createdAt: args.updatedAt - 1,
      updatedAt: args.updatedAt,
    });
  });
};

describe("conversation agent-thread pagination", () => {
  it("walks every owned thread without crossing owner or conversation indexes", async () => {
    const t = createTest();
    for (let index = 0; index < 45; index += 1) {
      await insertThread(t, {
        threadId: `owned-${index}`,
        ownerId: OWNER_ID,
        conversationId: CONVERSATION_ID,
        updatedAt: 1_000 + index,
      });
    }
    await insertThread(t, {
      threadId: "other-owner",
      ownerId: OTHER_OWNER_ID,
      conversationId: CONVERSATION_ID,
      updatedAt: 9_000,
    });
    await insertThread(t, {
      threadId: "other-conversation",
      ownerId: OWNER_ID,
      conversationId: "conversation-b",
      updatedAt: 8_000,
    });

    const owner = asOwner(t);
    const first = await owner.query(listThreadsPage, {
      conversationId: CONVERSATION_ID,
      identityRevision: 1,
      paginationOpts: { cursor: null, numItems: 30 },
    });
    const second = await owner.query(listThreadsPage, {
      conversationId: CONVERSATION_ID,
      identityRevision: 1,
      paginationOpts: {
        cursor: first.continueCursor,
        numItems: 30,
      },
    });
    const all = [...first.page, ...second.page];

    expect(first.page).toHaveLength(30);
    expect(first.isDone).toBe(false);
    expect(second.page).toHaveLength(15);
    expect(second.isDone).toBe(true);
    expect(all.map((thread) => thread.threadId)).toEqual(
      Array.from({ length: 45 }, (_, index) => `owned-${44 - index}`),
    );
    expect(new Set(all.map((thread) => thread.threadId)).size).toBe(45);
    expect(
      all.every(
        (thread) =>
          thread.ownerId === OWNER_ID &&
          thread.conversationId === CONVERSATION_ID,
      ),
    ).toBe(true);
  });

  it("derives ownership from auth for the same conversation and cursor shape", async () => {
    const t = createTest();
    await insertThread(t, {
      threadId: "owner-a-thread",
      ownerId: OWNER_ID,
      conversationId: CONVERSATION_ID,
      updatedAt: 10,
    });
    await insertThread(t, {
      threadId: "owner-b-thread",
      ownerId: OTHER_OWNER_ID,
      conversationId: CONVERSATION_ID,
      updatedAt: 20,
    });

    const page = await asOwner(t, OTHER_OWNER_ID).query(listThreadsPage, {
      conversationId: CONVERSATION_ID,
      identityRevision: 2,
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(page.page.map((thread) => thread.threadId)).toEqual([
      "owner-b-thread",
    ]);
    expect(page.isDone).toBe(true);
  });

  it("keeps an old long-running thread visible outside the newest history page", async () => {
    const t = createTest();
    await insertThread(t, {
      threadId: "long-running",
      ownerId: OWNER_ID,
      conversationId: CONVERSATION_ID,
      updatedAt: 1,
      status: "running",
    });
    for (let index = 0; index < 35; index += 1) {
      await insertThread(t, {
        threadId: `newer-terminal-${index}`,
        ownerId: OWNER_ID,
        conversationId: CONVERSATION_ID,
        updatedAt: 100 + index,
      });
    }
    await insertThread(t, {
      threadId: "foreign-running",
      ownerId: OTHER_OWNER_ID,
      conversationId: CONVERSATION_ID,
      updatedAt: 200,
      status: "running",
    });

    const owner = asOwner(t);
    const firstPage = await owner.query(listThreadsPage, {
      conversationId: CONVERSATION_ID,
      identityRevision: 1,
      paginationOpts: { cursor: null, numItems: 30 },
    });
    const running = await owner.query(listRunningThreads, {
      conversationId: CONVERSATION_ID,
      identityRevision: 1,
    });

    expect(firstPage.page.map((thread) => thread.threadId)).not.toContain(
      "long-running",
    );
    expect(running.map((thread) => thread.threadId)).toEqual(["long-running"]);
  });
});
