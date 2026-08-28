import { createApi } from "@convex-dev/better-auth";
import { options } from "../../node_modules/@convex-dev/better-auth/dist/auth-options.js";
import { v } from "convex/values";
import { query } from "./_generated/server";
import schema from "./schema";

/**
 * Same pattern as the bundled Better Auth component: static `options` for
 * `getAuthTables` at module init. App-level auth uses `createAuth` in `../auth`.
 */
export const {
  create,
  findOne,
  findMany,
  updateOne,
  updateMany,
  deleteOne,
  deleteMany,
} = createApi(schema, () => options);

/**
 * Resolve a possible Better Auth user id without passing opaque verification
 * values directly to `db.get`, which rejects malformed Convex ids.
 */
export const findUserIdSafely = query({
  args: { value: v.string() },
  returns: v.union(v.id("user"), v.null()),
  handler: async (ctx, args) => {
    const userId = ctx.db.normalizeId("user", args.value);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    return user?._id ?? null;
  },
});
