import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

const deletedResult = v.object({
  deleted: v.boolean(),
  kind: v.string(),
  id: v.string(),
  label: v.optional(v.string()),
  hasMore: v.optional(v.boolean()),
});

export const deleteDesktopRelease = internalMutation({
  args: { platform: v.string() },
  returns: deletedResult,
  handler: async (ctx, args) => {
    const platform = args.platform.trim();
    const row = await ctx.db
      .query("desktop_releases")
      .withIndex("by_platform", (q) => q.eq("platform", platform))
      .unique();
    if (!row) {
      return { deleted: false, kind: "desktop_release", id: platform };
    }
    await ctx.db.delete(row._id);
    return {
      deleted: true,
      kind: "desktop_release",
      id: platform,
      label: row.tag,
    };
  },
});

