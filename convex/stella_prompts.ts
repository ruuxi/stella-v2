import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";
import { hashSha256Hex } from "./lib/crypto_utils";

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
    const rows = await ctx.db.query("prompts").take(128);
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
    updatedAt: v.number(),
  },
  returns: v.object({ revision: v.string(), published: v.number() }),
  handler: async (ctx, args) => {
    const revision = args.revision.trim();
    if (!revision) throw new Error("revision is required");
    if (args.prompts.length > 128) throw new Error("Too many prompts");
    const seen = new Set<string>();
    const keepIds = new Set<string>();
    for (const prompt of args.prompts) {
      const id = prompt.id.trim();
      if (!/^(agents|prompts)\/[a-z0-9][a-z0-9_-]*\.md$/.test(id)) {
        throw new Error(`Invalid prompt id: ${prompt.id}`);
      }
      if (seen.has(id)) throw new Error(`Duplicate prompt id: ${id}`);
      seen.add(id);
      keepIds.add(id);
      const sha256 = await hashSha256Hex(prompt.content);
      const existing = await ctx.db
        .query("prompts")
        .withIndex("by_promptId", (q) => q.eq("promptId", id))
        .unique();
      const value = {
        promptId: id,
        content: prompt.content,
        sha256,
        sourceRevision: revision,
        updatedAt: args.updatedAt,
      };
      if (existing) await ctx.db.replace(existing._id, value);
      else await ctx.db.insert("prompts", value);
    }
    const existingRows = await ctx.db.query("prompts").take(128);
    for (const row of existingRows) {
      if (!keepIds.has(row.promptId)) await ctx.db.delete(row._id);
    }
    return { revision, published: args.prompts.length };
  },
});
