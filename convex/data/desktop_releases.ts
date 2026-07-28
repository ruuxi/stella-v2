import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import { desktop_release_artifact_ref_validator } from "../schema/desktop_releases";

/**
 * Latest published desktop release per platform.
 *
 * The CI publish job calls `publishDesktopRelease` (via an HTTP route
 * gated by a CI shared secret) once per platform after uploading the
 * clone-install manifest to R2. Installed desktops subscribe to
 * `currentDesktopRelease` via `useQuery` and react to a new commit
 * pointer the moment CI finishes — no polling required.
 */

const platformValidator = v.string();

export const currentDesktopRelease = query({
  args: {
    platform: platformValidator,
  },
  returns: v.union(
    v.null(),
    v.object({
      platform: v.string(),
      tag: v.string(),
      commit: v.string(),
      artifactRefs: v.optional(v.array(desktop_release_artifact_ref_validator)),
      publishedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("desktop_releases")
      .withIndex("by_platform", (q) => q.eq("platform", args.platform))
      .unique();
    if (!row) return null;
    return {
      platform: row.platform,
      tag: row.tag,
      commit: row.commit,
      ...(row.artifactRefs ? { artifactRefs: row.artifactRefs } : {}),
      publishedAt: row.publishedAt,
    };
  },
});

export const publishDesktopRelease = internalMutation({
  args: {
    platform: platformValidator,
    tag: v.string(),
    commit: v.string(),
    artifactRefs: v.optional(v.array(desktop_release_artifact_ref_validator)),
    publishedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("desktop_releases")
      .withIndex("by_platform", (q) => q.eq("platform", args.platform))
      .unique();
    const fields = {
      platform: args.platform,
      tag: args.tag,
      commit: args.commit,
      ...(args.artifactRefs ? { artifactRefs: args.artifactRefs } : {}),
      publishedAt: args.publishedAt,
    };
    if (existing) {
      await ctx.db.replace(existing._id, fields);
    } else {
      await ctx.db.insert("desktop_releases", fields);
    }
    return null;
  },
});
