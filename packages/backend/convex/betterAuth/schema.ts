/**
 * Better Auth component schema. Mirrors `@convex-dev/better-auth` with one
 * app-specific deltas: an `isAnonymous_updatedAt` index on `user` so
 * `anon_cleanup` can scan anonymous users by `updatedAt` without a full table
 * scan. The vendored table snapshot also carries optional lifecycle binding
 * fields for auth writers. Verification adds exact owner/value indexes so
 * durable account deletion never depends on a filtered component page.
 */
import { defineSchema } from "convex/server";
import { tables } from "./generatedTables";

export default defineSchema({
  ...tables,
  user: tables.user.index("isAnonymous_updatedAt", [
    "isAnonymous",
    "updatedAt",
  ]),
  verification: tables.verification
    .index("value", ["value"])
    .index("ownerId_createdAt", ["ownerId", "createdAt"]),
});
