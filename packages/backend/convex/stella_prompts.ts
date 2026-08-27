import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";
import {
  STELLA_PROMPT_COUNT,
  STELLA_PROMPT_REVISION_PATTERN,
  deriveStellaPromptRevision,
  hashStellaPromptInputs,
  nextStellaPromptPublishedAt,
  validateStellaPromptInputs,
} from "./stella_prompt_contract";

export const promptValueValidator = v.object({
  id: v.string(),
  sha256: v.string(),
  content: v.string(),
});

const storedPromptValidator = v.object({
  id: v.string(),
  sha256: v.string(),
  content: v.string(),
  sourceRevision: v.string(),
  updatedAt: v.number(),
});

export const list = internalQuery({
  args: {},
  returns: v.array(storedPromptValidator),
  handler: async (ctx) => {
    const rows = [];
    for await (const row of ctx.db.query("prompts")) {
      rows.push(row);
      if (rows.length > STELLA_PROMPT_COUNT) {
        throw new Error(`Prompt table exceeds ${STELLA_PROMPT_COUNT} rows`);
      }
    }
    return rows
      .map((row) => ({
        id: row.promptId,
        sha256: row.sha256,
        content: row.content,
        sourceRevision: row.sourceRevision,
        updatedAt: row.updatedAt,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  },
});
export const publish = internalMutation({
  args: {
    revision: v.string(),
    prompts: v.array(v.object({ id: v.string(), content: v.string() })),
  },
  returns: v.object({
    revision: v.string(),
    published: v.number(),
    publishedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    if (!STELLA_PROMPT_REVISION_PATTERN.test(args.revision)) {
      throw new Error("revision must be a lowercase SHA-256 hex string");
    }
    const validated = validateStellaPromptInputs(args.prompts);
    if (!validated.ok) throw new Error(validated.error);
    const revision = await deriveStellaPromptRevision(validated.prompts);
    if (revision !== args.revision) {
      throw new Error("revision does not match prompt content");
    }

    const existingRows = [];
    for await (const row of ctx.db.query("prompts")) {
      existingRows.push(row);
      if (existingRows.length > STELLA_PROMPT_COUNT) {
        throw new Error(`Prompt table exceeds ${STELLA_PROMPT_COUNT} rows`);
      }
    }
    const existingById = new Map(
      existingRows.map((row) => [row.promptId, row]),
    );
    const publishedAt = nextStellaPromptPublishedAt(
      existingRows.map((row) => row.updatedAt),
      Date.now(),
    );
    const hashed = await hashStellaPromptInputs(validated.prompts);
    const keepIds = new Set<string>();
    for (const prompt of hashed) {
      keepIds.add(prompt.id);
      const value = {
        promptId: prompt.id,
        content: prompt.content,
        sha256: prompt.sha256,
        sourceRevision: revision,
        updatedAt: publishedAt,
      };
      const existing = existingById.get(prompt.id);
      if (existing) await ctx.db.replace(existing._id, value);
      else await ctx.db.insert("prompts", value);
    }
    for (const row of existingRows) {
      if (!keepIds.has(row.promptId)) await ctx.db.delete(row._id);
    }
    return {
      revision,
      published: validated.prompts.length,
      publishedAt,
    };
  },
});
