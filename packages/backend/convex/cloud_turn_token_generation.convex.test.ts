/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const OWNER_ID = "owner:turn-token-generation";
const TOKEN_HASH = "a".repeat(64);

const insertToken = async (
  t: ReturnType<typeof convexTest>,
  ownerGeneration: string | undefined,
) => {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("cloud_turn_tokens", {
      tokenHash: TOKEN_HASH,
      ownerId: OWNER_ID,
      ...(ownerGeneration ? { ownerGeneration } : {}),
      turnId: "turn:generation-test",
      agentType: "general",
      createdAt: now,
      expiresAt: now + 60_000,
    });
  });
};

const resolveToken = async (t: ReturnType<typeof convexTest>) =>
  await t.query(internal.cloud_apps.getTurnTokenByHashInternal, {
    tokenHash: TOKEN_HASH,
    now: Date.now(),
  });

describe("cloud turn-token owner generation", () => {
  it("accepts only the generation read transactionally from the owner lifecycle", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId: OWNER_ID,
        generation: "generation-1",
        state: "open",
        createdAt: now,
        updatedAt: now,
      });
    });
    await insertToken(t, "generation-1");

    await expect(resolveToken(t)).resolves.toMatchObject({
      ownerId: OWNER_ID,
      ownerGeneration: "generation-1",
    });

    await t.run(async (ctx) => {
      const lifecycle = await ctx.db
        .query("cloud_owner_lifecycles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER_ID))
        .unique();
      if (!lifecycle) throw new Error("missing lifecycle");
      await ctx.db.patch(lifecycle._id, {
        generation: "generation-2",
        updatedAt: Date.now(),
      });
    });
    await expect(resolveToken(t)).resolves.toBeNull();
  });

  it("rejects rolling legacy rows that never captured a generation", async () => {
    const t = convexTest(schema, modules);
    await insertToken(t, undefined);
    await expect(resolveToken(t)).resolves.toBeNull();
  });
});
