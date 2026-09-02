// Cloud agent home: Convex's registry for orchestrator memory documents.
//
// Memory DOCUMENTS (MEMORY.md, memory_map.md, profile.md) live in R2 under
// agent-home/<sha256(ownerId)>/generations/<sha256(ownerGeneration)>/memories/
// and are read and written by the orchestrator DO through its AGENT_HOME
// bucket binding — Convex holds only the registry row for each
// (cloud_agent_home_docs). The generation segment prevents a delayed turn
// from a pre-reset generation from replacing the current profile bytes.

import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { agentHomeGenerationR2Prefix } from "./lib/cloud_home_policy";
import { assertOwnerMemoryRuntimeEnabled } from "./cloud_memory";

const MEMORY_DOC_NAMES = new Set(["MEMORY.md", "memory_map.md", "profile.md"]);
const AGENT_HOME_DOC_MAX_BYTES = 64 * 1024;

export const agentHomeDocumentKey = async (
  ownerId: string,
  ownerGeneration: string,
  name: string,
): Promise<string> => {
  return `${await agentHomeGenerationR2Prefix({ ownerId, ownerGeneration })}memories/${name}`;
};

const documentValidator = v.object({
  name: v.string(),
  r2Key: v.string(),
  sizeBytes: v.number(),
  updatedAt: v.number(),
});

export const listOwnerDocumentsInternal = internalQuery({
  args: { ownerId: v.string(), ownerGeneration: v.string() },
  returns: v.array(documentValidator),
  handler: async (ctx, args) => {
    const memory = await assertOwnerMemoryRuntimeEnabled(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const rows = await ctx.db
      .query("cloud_agent_home_docs")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .order("desc")
      .take(20);
    const currentRows = rows.filter(
      (row) =>
        row.ownerGeneration === args.ownerGeneration ||
        (row.ownerGeneration === undefined &&
          args.ownerGeneration === "legacy"),
    );
    if (
      currentRows.some(
        (row) => (row.memoryEpoch ?? "legacy") !== memory.memoryEpoch,
      )
    ) {
      throw new ConvexError({
        code: "CLOUD_MEMORY_EPOCH_STALE",
        message: "Cloud memory metadata belongs to an erased memory epoch.",
      });
    }
    return currentRows.map((row) => ({
      name: row.name,
      r2Key: row.r2Key,
      sizeBytes: row.sizeBytes,
      updatedAt: row.updatedAt,
    }));
  },
});

// Called after the orchestrator DO writes a memory document to R2, so Convex
// stays the canonical record of what exists. Idempotent per (owner, name).
export const recordDocumentInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    name: v.string(),
    r2Key: v.string(),
    sizeBytes: v.number(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const memory = await assertOwnerMemoryRuntimeEnabled(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    if (!MEMORY_DOC_NAMES.has(args.name)) {
      throw new ConvexError(
        `Unknown memory document "${args.name}". Expected MEMORY.md, memory_map.md, or profile.md.`,
      );
    }
    if (
      !Number.isSafeInteger(args.sizeBytes) ||
      args.sizeBytes < 0 ||
      args.sizeBytes > AGENT_HOME_DOC_MAX_BYTES
    ) {
      throw new ConvexError(
        `Memory documents must be between 0 and ${AGENT_HOME_DOC_MAX_BYTES} bytes.`,
      );
    }
    const expectedKey = await agentHomeDocumentKey(
      args.ownerId,
      args.ownerGeneration,
      args.name,
    );
    if (args.r2Key !== expectedKey) {
      throw new ConvexError(
        "Memory document key does not match its owner and name.",
      );
    }
    const existing = await ctx.db
      .query("cloud_agent_home_docs")
      .withIndex("by_ownerId_and_name", (q) =>
        q.eq("ownerId", args.ownerId).eq("name", args.name),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        r2Key: args.r2Key,
        ownerGeneration: args.ownerGeneration,
        memoryEpoch: memory.memoryEpoch,
        sizeBytes: args.sizeBytes,
        updatedAt: args.now,
      });
      return null;
    }
    await ctx.db.insert("cloud_agent_home_docs", {
      ownerId: args.ownerId,
      name: args.name,
      r2Key: args.r2Key,
      ownerGeneration: args.ownerGeneration,
      memoryEpoch: memory.memoryEpoch,
      sizeBytes: args.sizeBytes,
      createdAt: args.now,
      updatedAt: args.now,
    });
    return null;
  },
});
