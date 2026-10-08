/**
 * The on-disk layout of Stella's memory, and the budgets that bound what is
 * injected from it.
 *
 * Memory is plain markdown under `~/.stella/memories/` (plus the onboarding
 * snapshot at `~/.stella/core-memory.md`). The orchestrator edits it through
 * the `memory` client inside `code` (`memory-client.ts`); every other agent
 * uses its ordinary file tools. In the cloud the same files live in the
 * owner's world under `/workspace/world/.stella/`, and each of the owner's
 * computers keeps its copy the same as the cloud's, both ways (the desktop's
 * memory sync in Electron main, over cloud-builder's `memory.files.*`).
 *
 * Three documents are always resident, and only these three:
 *
 *   - `core-memory.md`  the onboarding-derived snapshot of who the user is,
 *     written by discovery (`runtime/discovery/browser-data.ts`).
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
/**
 * The user's personality override beside memory, `~/.stella/PERSONALITY.md`.
 * Not memory to the model (`memory.*` never names it), but it is kept the
 * same on every computer and in the cloud, and a memory wipe erases it.
 */
export const PERSONALITY_FILE = "PERSONALITY.md";

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
