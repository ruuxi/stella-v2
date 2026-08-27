/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import {
  makeFunctionReference,
  type PaginationOptions,
  type PaginationResult,
} from "convex/server";
import { describe, expect, it, vi } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const OWNER_ID = "history-owner";

type Conversation = {
  conversationId: string;
  ownerId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

const historySnapshot = makeFunctionReference<
  "query",
  Record<string, never>,
  { snapshotUpdatedAt: number }
>("cloud_apps:getMyConversationHistorySnapshot");
const listConversationsPage = makeFunctionReference<
  "query",
  { snapshotUpdatedAt: number; paginationOpts: PaginationOptions },
  PaginationResult<Conversation>
>("cloud_apps:listMyConversationsPage");
const listRecent = makeFunctionReference<
  "query",
  Record<string, never>,
  Conversation[]
>("cloud_apps:listMyConversations");

const createTest = () => convexTest(schema, modules);
const asOwner = (t: ReturnType<typeof createTest>) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: OWNER_ID,
    tokenIdentifier: OWNER_ID,
    iat: 1_000,
  });

describe("cloud conversation history snapshots", () => {
  it("keeps a bounded tuple-ordered walk gapless while recent history surfaces a row that moves newer", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      for (let index = 0; index < 60; index += 1) {
        const conversationId = `conversation-${String(index).padStart(2, "0")}`;
        await ctx.db.insert("cloud_conversations", {
          conversationId,
          ownerId: OWNER_ID,
          title: conversationId,
          createdAt: 1_000,
          // Deliberate ties exercise the declared conversationId tie-break.
          updatedAt: 1_000 + Math.floor(index / 2),
        });
      }
      await ctx.db.insert("cloud_conversations", {
        conversationId: "foreign-conversation",
        ownerId: "another-owner",
        title: "Foreign",
        createdAt: 1,
        updatedAt: 9_999,
      });
    });

    const owner = asOwner(t);
    const snapshot = await owner.query(historySnapshot, {});
    const first = await owner.query(listConversationsPage, {
      snapshotUpdatedAt: snapshot.snapshotUpdatedAt,
      paginationOpts: { cursor: null, numItems: 30 },
    });

    const movedConversationId = "conversation-05";
    const movedUpdatedAt = snapshot.snapshotUpdatedAt + 1;
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("cloud_conversations")
        .withIndex("by_conversationId", (q) =>
          q.eq("conversationId", movedConversationId),
        )
        .unique();
      if (!row) throw new Error("missing fixture conversation");
      await ctx.db.patch(row._id, { updatedAt: movedUpdatedAt });
    });

    const second = await owner.query(listConversationsPage, {
      snapshotUpdatedAt: snapshot.snapshotUpdatedAt,
      paginationOpts: { cursor: first.continueCursor, numItems: 40 },
    });
    const frozen = [...first.page, ...second.page];

    expect(first.page).toHaveLength(30);
    expect(second.isDone).toBe(true);
    expect(frozen).toHaveLength(59);
    expect(new Set(frozen.map((row) => row.conversationId)).size).toBe(59);
    expect(frozen.map((row) => row.conversationId)).not.toContain(
      movedConversationId,
    );
    expect(frozen.map((row) => row.conversationId)).not.toContain(
      "foreign-conversation",
    );
    for (let index = 1; index < frozen.length; index += 1) {
      const prior = frozen[index - 1]!;
      const current = frozen[index]!;
      expect(
        prior.updatedAt > current.updatedAt ||
          (prior.updatedAt === current.updatedAt &&
            prior.conversationId > current.conversationId),
      ).toBe(true);
    }

    const recent = await owner.query(listRecent, {});
    expect(recent[0]).toMatchObject({
      conversationId: movedConversationId,
      updatedAt: movedUpdatedAt,
    });
    const refreshed = await owner.query(listConversationsPage, {
      snapshotUpdatedAt: movedUpdatedAt,
      paginationOpts: { cursor: null, numItems: 30 },
    });
    expect(refreshed.page[0]?.conversationId).toBe(movedConversationId);
  });

  it("reopens on a database watermark and recovers changes beyond the 25-row reactive overlay", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      for (let index = 0; index < 60; index += 1) {
        const conversationId = `reopen-${String(index).padStart(2, "0")}`;
        await ctx.db.insert("cloud_conversations", {
          conversationId,
          ownerId: OWNER_ID,
          title: conversationId,
          createdAt: 1_000 + index,
          updatedAt: 1_000 + index,
        });
      }
    });

    const owner = asOwner(t);
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(99_999);
    try {
      const initial = await owner.query(historySnapshot, {});
      expect(initial).toEqual({ snapshotUpdatedAt: 1_059 });

      await t.run(async (ctx) => {
        for (let index = 0; index < 30; index += 1) {
          const conversationId = `reopen-${String(index).padStart(2, "0")}`;
          const row = await ctx.db
            .query("cloud_conversations")
            .withIndex("by_conversationId", (q) =>
              q.eq("conversationId", conversationId),
            )
            .unique();
          if (!row) throw new Error(`missing ${conversationId}`);
          await ctx.db.patch(row._id, { updatedAt: 2_000 + index });
        }
      });

      const frozen = await owner.query(listConversationsPage, {
        snapshotUpdatedAt: initial.snapshotUpdatedAt,
        paginationOpts: { cursor: null, numItems: 50 },
      });
      expect(frozen.isDone).toBe(true);
      expect(frozen.page).toHaveLength(30);

      const recent = await owner.query(listRecent, {});
      expect(recent).toHaveLength(25);
      const visibleWithoutRefresh = new Set(
        [...frozen.page, ...recent].map((row) => row.conversationId),
      );
      expect(visibleWithoutRefresh.size).toBe(55);
      expect(visibleWithoutRefresh.has("reopen-00")).toBe(false);

      // Same query args as the first open: the DB range dependency, not a
      // non-deterministic clock read, advances the cached snapshot.
      const reopened = await owner.query(historySnapshot, {});
      expect(reopened).toEqual({ snapshotUpdatedAt: 2_029 });
      const first = await owner.query(listConversationsPage, {
        snapshotUpdatedAt: reopened.snapshotUpdatedAt,
        paginationOpts: { cursor: null, numItems: 50 },
      });
      const second = await owner.query(listConversationsPage, {
        snapshotUpdatedAt: reopened.snapshotUpdatedAt,
        paginationOpts: { cursor: first.continueCursor, numItems: 50 },
      });
      const refreshed = [...first.page, ...second.page];
      expect(second.isDone).toBe(true);
      expect(refreshed).toHaveLength(60);
      expect(new Set(refreshed.map((row) => row.conversationId)).size).toBe(60);
      expect(refreshed.map((row) => row.conversationId)).toContain("reopen-00");
    } finally {
      wallClock.mockRestore();
    }
  });
});
