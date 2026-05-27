import { defineTable } from "convex/server";
import { v } from "convex/values";

export const desktop_release_artifact_ref_validator = v.object({
  kind: v.literal("native-helpers"),
  platform: v.string(),
  manifestUrl: v.string(),
  manifestSha: v.optional(v.string()),
  commit: v.optional(v.string()),
  builtAt: v.optional(v.string()),
  sourceRevisionId: v.optional(v.string()),
  asset: v.object({
    url: v.string(),
    sha256: v.string(),
    sizeBytes: v.number(),
  }),
});

// One row per platform identifier (e.g. "darwin-arm64", "darwin-x64",
// "win-x64"). The CI publish job upserts the latest published release
// here so installed desktops can subscribe via `useQuery` and receive a
// reactive push when a new version ships, without polling R2.
export const desktop_release_asset_validator = v.object({
  platform: v.string(),
  tag: v.string(),
  /** Upstream GitHub commit SHA the tarball was built from. */
  commit: v.string(),
  /** R2 download URL for the platform-specific tarball. */
  archiveUrl: v.string(),
  archiveSha256: v.string(),
  archiveSize: v.number(),
  sourcePackUrl: v.optional(v.string()),
  sourcePackSha256: v.optional(v.string()),
  sourcePackSize: v.optional(v.number()),
  sourceHistoryUrl: v.optional(v.string()),
  sourceHistorySha256: v.optional(v.string()),
  sourceHistorySize: v.optional(v.number()),
  artifactRefs: v.optional(v.array(desktop_release_artifact_ref_validator)),
  publishedAt: v.number(),
});

const desktopReleaseFields = {
  platform: v.string(),
  tag: v.string(),
  commit: v.string(),
  archiveUrl: v.string(),
  archiveSha256: v.string(),
  archiveSize: v.number(),
  sourcePackUrl: v.optional(v.string()),
  sourcePackSha256: v.optional(v.string()),
  sourcePackSize: v.optional(v.number()),
  sourceHistoryUrl: v.optional(v.string()),
  sourceHistorySha256: v.optional(v.string()),
  sourceHistorySize: v.optional(v.number()),
  artifactRefs: v.optional(v.array(desktop_release_artifact_ref_validator)),
  publishedAt: v.number(),
};

export const desktopReleasesSchema = {
  desktop_releases: defineTable(desktopReleaseFields).index("by_platform", [
    "platform",
  ]),
};
