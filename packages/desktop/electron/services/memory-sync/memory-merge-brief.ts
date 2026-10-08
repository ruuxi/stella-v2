import path from "node:path";

import {
  CORE_MEMORY_INJECTED_MAX_CHARS,
  MEMORY_INDEX_INJECTED_MAX_CHARS,
  USER_PROFILE_INJECTED_MAX_CHARS,
} from "@stella/runtime/kernel/memory/memory-layout.js";
import { MEMORY_FILE_MAX_CHARS } from "@stella/runtime/kernel/memory/memory-client.js";

/** A memory file both sides changed, and where this computer's version was saved. */
export type MemoryMerge = { path: string; copy: string };

const limit = (relative: string): number =>
  relative === "core-memory.md"
    ? CORE_MEMORY_INJECTED_MAX_CHARS
    : relative === "memories/profile.md"
      ? USER_PROFILE_INJECTED_MAX_CHARS
      : relative === "memories/index.md"
        ? MEMORY_INDEX_INJECTED_MAX_CHARS
        : MEMORY_FILE_MAX_CHARS;

/**
 * The brief a background agent gets when memory changed here and in the
 * cloud at once. Like the app-source briefs, it is not a user message: the
 * user typed nothing, so nothing is filed as though they had. The sync has
 * already put the cloud's version in place and saved this computer's beside
 * it, so the merge is the only work left, and the sync uploads its result.
 */
export const memoryMergeBrief = (
  stellaDataDir: string,
  merges: readonly MemoryMerge[],
): { description: string; prompt: string } => {
  const files = merges
    .map((merge) => {
      const target = path.join(stellaDataDir, ...merge.path.split("/"));
      return `- \`${target}\` (at most ${limit(merge.path).toLocaleString("en-US")} characters). This computer's version: \`${merge.copy}\``;
    })
    .join("\n");
  return {
    description:
      merges.length === 1
        ? `Merge memory edits to ${merges[0]!.path}`
        : `Merge memory edits to ${merges.length} files`,
    prompt: `Stella's memory changed on this computer and in the cloud at the same time, and the two versions below differ. The app kept the cloud's version in place and saved this computer's version beside it. Nobody is waiting on a question: merge them.

${files}

For each file:
- Edit the file in place with your file tools so it holds everything true from both versions: keep what either side added, drop duplicates, and where they contradict keep the one that reads as newer.
- Keep its layout and stay under its character limit; tighten wording rather than drop facts.
- When the file is merged, delete this computer's saved version.

Touch no other file. The app copies the merged file to the cloud and your other computers by itself; never upload anything yourself. Report in one or two lines what you merged.`,
  };
};
