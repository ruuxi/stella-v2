/**
 * The on-disk layout of Stella's memory, and the budgets that bound what is
 * injected from it.
 *
 * Memory is plain markdown under `~/.stella/memories/` (plus the onboarding
 * snapshot at `~/.stella/core-memory.md`). There is no bespoke memory tool:
 * the agent reads and edits these files with the ordinary file tools, so the
 * model's normal editing ability is the whole write path.
 *
 * Three documents are always resident, and only these three:
 *
 *   - `core-memory.md`  the onboarding-derived snapshot of who the user is.
 *     Written by discovery (`runtime/discovery/browser-data.ts`), not by the
 *     agent during conversation.
 *   - `memories/profile.md`  curated durable facts and standing rules.
 *   - `memories/index.md`  a routing index: one line per nested memory file,
 *     saying what lives there. This is what makes on-demand memory reachable;
 *     an unindexed file is an archive, not a memory.
 *
 * Everything else nests under `~/.stella/memories/` and is opened on demand.
 *
 * The budgets below bound INJECTION only — they never delete anything on
 * disk. An over-budget document is truncated at a line boundary with a
 * visible marker, so the agent can see that it is not reading the whole file
 * and curate it down. The previous design enforced its cap on the write path
 * by silently evicting the oldest facts, which destroyed memory without
 * telling anyone; nothing here can do that.
 */

import path from "node:path";

export const MEMORIES_DIR = "memories";

export const CORE_MEMORY_FILE = "core-memory.md";
export const USER_PROFILE_FILE = "profile.md";
export const MEMORY_INDEX_FILE = "index.md";

/** Display paths — these are what the model sees and what it edits. */
export const CORE_MEMORY_DISPLAY_PATH = "~/.stella/core-memory.md";
export const USER_PROFILE_DISPLAY_PATH = "~/.stella/memories/profile.md";
export const MEMORY_INDEX_DISPLAY_PATH = "~/.stella/memories/index.md";

/**
 * Injection budgets, in unicode code points. Deliberately generous relative to
 * the curated size each document should sit at: hitting one of these means the
 * document needs editing down, not that memory should be thrown away.
 */
export const CORE_MEMORY_INJECTED_MAX_CHARS = 8_000;
export const USER_PROFILE_INJECTED_MAX_CHARS = 9_000;
export const MEMORY_INDEX_INJECTED_MAX_CHARS = 6_000;

export const memoriesDirPath = (stellaDataDir: string): string =>
  path.join(stellaDataDir, MEMORIES_DIR);

export const coreMemoryPath = (stellaDataDir: string): string =>
  path.join(stellaDataDir, CORE_MEMORY_FILE);

export const userProfilePath = (stellaDataDir: string): string =>
  path.join(stellaDataDir, MEMORIES_DIR, USER_PROFILE_FILE);

export const memoryIndexPath = (stellaDataDir: string): string =>
  path.join(stellaDataDir, MEMORIES_DIR, MEMORY_INDEX_FILE);
