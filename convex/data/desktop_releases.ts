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
      sourcePackUrl: v.optional(v.string()),
      sourcePackSha256: v.optional(v.string()),
      sourcePackSize: v.optional(v.number()),
      sourceHistoryUrl: v.optional(v.string()),
      sourceHistorySha256: v.optional(v.string()),
      sourceHistorySize: v.optional(v.number()),
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
      ...(row.sourcePackUrl ? { sourcePackUrl: row.sourcePackUrl } : {}),
      ...(row.sourcePackSha256
        ? { sourcePackSha256: row.sourcePackSha256 }
        : {}),
      ...(typeof row.sourcePackSize === "number"
        ? { sourcePackSize: row.sourcePackSize }
        : {}),
      ...(row.sourceHistoryUrl
        ? { sourceHistoryUrl: row.sourceHistoryUrl }
        : {}),
      ...(row.sourceHistorySha256
        ? { sourceHistorySha256: row.sourceHistorySha256 }
        : {}),
      ...(typeof row.sourceHistorySize === "number"
        ? { sourceHistorySize: row.sourceHistorySize }
        : {}),
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
    sourcePackUrl: v.optional(v.string()),
    sourcePackSha256: v.optional(v.string()),
    sourcePackSize: v.optional(v.number()),
    sourceHistoryUrl: v.optional(v.string()),
    sourceHistorySha256: v.optional(v.string()),
    sourceHistorySize: v.optional(v.number()),
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
      ...(args.sourcePackUrl ? { sourcePackUrl: args.sourcePackUrl } : {}),
      ...(args.sourcePackSha256
        ? { sourcePackSha256: args.sourcePackSha256 }
        : {}),
      ...(typeof args.sourcePackSize === "number"
        ? { sourcePackSize: args.sourcePackSize }
        : {}),
      ...(args.sourceHistoryUrl
        ? { sourceHistoryUrl: args.sourceHistoryUrl }
        : {}),
      ...(args.sourceHistorySha256
        ? { sourceHistorySha256: args.sourceHistorySha256 }
        : {}),
      ...(typeof args.sourceHistorySize === "number"
        ? { sourceHistorySize: args.sourceHistorySize }
        : {}),
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
