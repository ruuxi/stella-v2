/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";

import { STELLA_PROMPT_DEFAULTS } from "./stella_prompt_defaults.generated";
import { STELLA_PROMPT_SCHEMA_VERSION } from "./stella_prompt_contract";
import {
  STELLA_PROMPTS_PATH,
  resolveStellaPromptSnapshot,
  type PromptResponseSnapshot,
  type StoredPrompt,
} from "./stella_prompts_http";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);

const served = async (t: ReturnType<typeof createTest>) => {
  const response = await t.fetch(STELLA_PROMPTS_PATH);
  expect(response.status).toBe(200);
  return (await response.json()) as PromptResponseSnapshot & {
    schemaVersion: number;
  };
};

type PublishArgs = {
  revision: string;
  prompts: Array<{ id: string; content: string }>;
};

type PublishResult = {
  revision: string;
  published: number;
  publishedAt: number;
};

const publish = makeFunctionReference<"mutation", PublishArgs, PublishResult>(
  "stella_prompts:publish",
);
const list = makeFunctionReference<
  "query",
  Record<string, never>,
  StoredPrompt[]
>("stella_prompts:list");

const publishArgs: PublishArgs = {
  revision: STELLA_PROMPT_DEFAULTS.revision,
  prompts: STELLA_PROMPT_DEFAULTS.prompts.map(({ id, content }) => ({
    id,
    content,
  })),
};

const defaultSnapshot = {
  revision: STELLA_PROMPT_DEFAULTS.revision,
  publishedAt: STELLA_PROMPT_DEFAULTS.publishedAt,
  prompts: STELLA_PROMPT_DEFAULTS.prompts.map(({ id, sha256, content }) => ({
    id,
    sha256,
    content,
  })),
};

describe("Stella prompt publication", () => {
  it("repairs an incomplete deployment publication once with a monotonic timestamp", async () => {
    const t = createTest();
    const first = await t.mutation(publish, publishArgs);
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("prompts")
        .take(STELLA_PROMPT_DEFAULTS.prompts.length);
      if (!rows[0]) throw new Error("missing fixture prompt");
      await ctx.db.delete(rows[0]._id);
    });
    const repair = makeFunctionReference<
      "mutation",
      Record<string, never>,
      StoredPrompt[]
    >("stella_prompts:ensureDefaultPublication");
    const repaired = await t.mutation(repair, {});
    expect(repaired).toHaveLength(STELLA_PROMPT_DEFAULTS.prompts.length);
    expect(repaired[0]!.updatedAt).toBeGreaterThan(first.publishedAt);
    const again = await t.mutation(repair, {});
    expect(resolveStellaPromptSnapshot(again)).toEqual(
      resolveStellaPromptSnapshot(repaired),
    );
    expect(resolveStellaPromptSnapshot(await t.query(list, {}))).toEqual(
      resolveStellaPromptSnapshot(repaired),
    );
  });

  it("publishes the exact canonical roster and serves the complete stored snapshot", async () => {
    const t = createTest();

    const result = await t.mutation(publish, publishArgs);
    expect(result).toMatchObject({
      revision: STELLA_PROMPT_DEFAULTS.revision,
      published: STELLA_PROMPT_DEFAULTS.prompts.length,
    });
    expect(result.publishedAt).toBeGreaterThan(0);

    const stored = await t.query(list, {});
    expect(stored).toHaveLength(STELLA_PROMPT_DEFAULTS.prompts.length);
    expect(new Set(stored.map(({ updatedAt }) => updatedAt))).toEqual(
      new Set([result.publishedAt]),
    );
    expect(new Set(stored.map(({ sourceRevision }) => sourceRevision))).toEqual(
      new Set([STELLA_PROMPT_DEFAULTS.revision]),
    );
    expect(resolveStellaPromptSnapshot(stored)).toEqual({
      ...defaultSnapshot,
      publishedAt: result.publishedAt,
    });
  });

  it("advances publication time monotonically when identical content is replayed", async () => {
    const t = createTest();
    const first = await t.mutation(publish, publishArgs);
    const futurePublishedAt = first.publishedAt + 10_000;
    await t.run(async (ctx) => {
      for await (const row of ctx.db.query("prompts")) {
        await ctx.db.patch(row._id, { updatedAt: futurePublishedAt });
      }
    });

    const replay = await t.mutation(publish, publishArgs);
    expect(replay).toEqual({
      revision: STELLA_PROMPT_DEFAULTS.revision,
      published: STELLA_PROMPT_DEFAULTS.prompts.length,
      publishedAt: futurePublishedAt + 1,
    });
    expect(
      (await t.query(list, {})).every(
        ({ updatedAt }) => updatedAt === replay.publishedAt,
      ),
    ).toBe(true);
  });

  it("repairs incomplete or mixed stored snapshots before serving them", async () => {
    const t = createTest();
    const first = await t.mutation(publish, publishArgs);

    const removedId = STELLA_PROMPT_DEFAULTS.prompts[0]!.id;
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("prompts")
        .withIndex("by_promptId", (q) => q.eq("promptId", removedId))
        .unique();
      if (!row) throw new Error("expected published prompt row");
      await ctx.db.delete(row._id);
    });
    const repaired = await served(t);
    expect(repaired).toEqual({
      schemaVersion: STELLA_PROMPT_SCHEMA_VERSION,
      ...defaultSnapshot,
      publishedAt: repaired.publishedAt,
    });
    expect(repaired.publishedAt).toBeGreaterThan(first.publishedAt);
    expect(resolveStellaPromptSnapshot(await t.query(list, {}))).toEqual({
      ...defaultSnapshot,
      publishedAt: repaired.publishedAt,
    });

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("prompts")
        .withIndex("by_promptId", (q) => q.eq("promptId", removedId))
        .unique();
      if (!row) throw new Error("expected republished prompt row");
      await ctx.db.patch(row._id, { sourceRevision: "f".repeat(64) });
    });
    const reconciled = await served(t);
    expect(reconciled).toEqual({
      ...repaired,
      publishedAt: reconciled.publishedAt,
    });
    expect(reconciled.publishedAt).toBeGreaterThan(repaired.publishedAt);
  });
});
