/**
 * Resident user-profile store — the small, always-injected doc of durable
 * facts Stella knows about the user (name, location, stable preferences).
 *
 * This is Stella's answer to "remember my name": unlike the Dream ledger
 * (`MEMORY.md` / `memory_map.md`, reachable only via the `Context`
 * lookup tool), `profile.md` is push-injected into the Orchestrator at
 * session start, so durable identity facts are always in context without a
 * lookup. It is written exclusively by the Orchestrator's `Remember` tool —
 * no other writer touches it, so there is no consolidation race with Dream.
 *
 * Entries are one fact per markdown bullet, deduped case-insensitively, with
 * a hard char cap so the resident block stays cheap to inject every session.
 * Mirrors the spirit of Hermes's `USER.md`.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { redactMemoryText } from "./redaction.js";

export const USER_PROFILE_FILE = "profile.md";

/** Cap on the rendered entries body (excludes the header). */
export const MAX_USER_PROFILE_CHARS = 8_000;

/**
 * Hard bound the resident-doc injector applies when reading `profile.md` into
 * the Orchestrator context. Kept coherent with (and above) the write cap so a
 * legitimately at-cap file is never truncated, while a hand-edited or otherwise
 * over-cap file can never blow the always-resident context budget. The slack
 * over {@link MAX_USER_PROFILE_CHARS} covers the header and per-entry markup.
 */
export const USER_PROFILE_INJECT_MAX_CHARS = MAX_USER_PROFILE_CHARS + 1_000;

const HEADER = [
  "# User Profile",
  "",
  "> Durable facts Stella knows about the user — written via the Remember",
  "> tool and injected into the Orchestrator at the start of every session.",
  "> Keep entries short and high-signal.",
  "",
].join("\n");

export const userProfilePath = (stellaDataDir: string): string =>
  path.join(stellaDataDir, "memories", USER_PROFILE_FILE);

const collapseWhitespace = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

/** Parse bullet entries out of the on-disk file. */
export const parseUserProfileEntries = (content: string): string[] => {
  const entries: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const match = rawLine.match(/^\s*-\s+(.*)$/);
    if (!match) continue;
    const entry = collapseWhitespace(match[1] ?? "");
    if (entry) entries.push(entry);
  }
  return entries;
};

const renderUserProfile = (entries: string[]): string => {
  const body = entries.map((entry) => `- ${entry}`).join("\n");
  return `${HEADER}${body}\n`;
};

const entriesBodyLength = (entries: string[]): number =>
  entries.reduce((sum, entry) => sum + entry.length + 3, 0);

export const readUserProfile = async (
  stellaDataDir: string,
): Promise<string | null> => {
  try {
    return await fs.readFile(userProfilePath(stellaDataDir), "utf-8");
  } catch {
    return null;
  }
};

const readEntries = async (stellaDataDir: string): Promise<string[]> => {
  const content = await readUserProfile(stellaDataDir);
  return content ? parseUserProfileEntries(content) : [];
};

const writeEntries = async (
  stellaDataDir: string,
  entries: string[],
): Promise<void> => {
  const target = userProfilePath(stellaDataDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  // Unique temp per write: a fixed `${target}.tmp` would let two concurrent
  // writers corrupt each other's bytes or fail the rename with ENOENT.
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, renderUserProfile(entries), "utf-8");
    // Atomic swap: readers (and the resident-doc injector) never observe a
    // half-written file.
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
};

/**
 * Serializes the profile's read-modify-write. The agent loop runs tool calls
 * in parallel (`multi_tool_use_parallel`), so two `Remember` calls in one turn
 * would otherwise both read the same entries and clobber each other's update.
 * Process-global is fine: there is one profile per kernel process and writes
 * are infrequent.
 */
let profileWriteChain: Promise<unknown> = Promise.resolve();
const withProfileLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = profileWriteChain.then(fn, fn);
  profileWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

const sameEntry = (a: string, b: string): boolean =>
  a.toLocaleLowerCase() === b.toLocaleLowerCase();

export type UserProfileAction = "add" | "replace" | "remove";

export type UserProfileOperation = {
  action: UserProfileAction;
  content?: string;
  oldContent?: string;
};

export type UserProfileOperationResult = {
  ok: boolean;
  message: string;
  entryCount: number;
};

/**
 * Anti-wedge cap enforcement. Eviction policy: OLDEST-FIRST (FIFO) — the
 * front of the list is the oldest fact, so we drop from there until the body
 * fits within {@link MAX_USER_PROFILE_CHARS}, always preserving the entry at
 * `protectIndex` (the fact just added or updated by this operation). This
 * guarantees a write never leaves the store above its cap and never lets an
 * over-cap store reject every subsequent write — the failure mode that
 * previously wedged the profile once it drifted past the old cap.
 *
 * OWNER: to change the eviction policy (e.g. keep-oldest / lowest-signal /
 * LRU), replace the `findIndex` selection below with a different victim
 * chooser; everything else stays the same.
 *
 * Returns the trimmed entries plus how many were evicted, or null when the
 * protected entry alone still exceeds the cap (caller rejects that one write).
 */
const evictOldestToFit = (
  entries: string[],
  protectIndex: number,
): { entries: string[]; evicted: number } | null => {
  const kept = [...entries];
  let protectAt = protectIndex;
  let evicted = 0;
  while (entriesBodyLength(kept) > MAX_USER_PROFILE_CHARS) {
    const victim = kept.findIndex((_, i) => i !== protectAt);
    if (victim === -1) return null;
    kept.splice(victim, 1);
    if (victim < protectAt) protectAt -= 1;
    evicted += 1;
  }
  return { entries: kept, evicted };
};

const evictionNote = (evicted: number): string =>
  evicted > 0
    ? ` (evicted ${evicted} oldest ${evicted === 1 ? "fact" : "facts"} to stay within the size cap)`
    : "";

/**
 * Apply a single add/replace/remove operation to `profile.md`. Content is
 * redacted and whitespace-collapsed; adds dedupe case-insensitively. When a
 * write would push the body past {@link MAX_USER_PROFILE_CHARS} the store
 * evicts the oldest facts to make room (see {@link evictOldestToFit}) rather
 * than rejecting the write, so the profile can never wedge above its cap.
 */
const applyUserProfileOperationLocked = async (
  stellaDataDir: string,
  op: UserProfileOperation,
): Promise<UserProfileOperationResult> => {
  const entries = await readEntries(stellaDataDir);
  const content = op.content
    ? collapseWhitespace(redactMemoryText(op.content))
    : "";
  const oldContent = op.oldContent
    ? collapseWhitespace(redactMemoryText(op.oldContent))
    : "";

  const findIndex = (needle: string): number => {
    if (!needle) return -1;
    const exact = entries.findIndex((entry) => sameEntry(entry, needle));
    if (exact !== -1) return exact;
    const lower = needle.toLocaleLowerCase();
    return entries.findIndex((entry) =>
      entry.toLocaleLowerCase().includes(lower),
    );
  };

  if (op.action === "add") {
    if (!content) {
      return { ok: false, message: "add requires content.", entryCount: entries.length };
    }
    if (entries.some((entry) => sameEntry(entry, content))) {
      return {
        ok: true,
        message: "Already remembered; left unchanged.",
        entryCount: entries.length,
      };
    }
    const next = [...entries, content];
    const bounded = evictOldestToFit(next, next.length - 1);
    if (!bounded) {
      return {
        ok: false,
        message:
          "This fact is larger than the entire user-profile budget; shorten it before remembering.",
        entryCount: entries.length,
      };
    }
    await writeEntries(stellaDataDir, bounded.entries);
    return {
      ok: true,
      message: `Remembered${evictionNote(bounded.evicted)}.`,
      entryCount: bounded.entries.length,
    };
  }

  if (op.action === "replace") {
    if (!oldContent || !content) {
      return {
        ok: false,
        message: "replace requires both old_content and content.",
        entryCount: entries.length,
      };
    }
    const idx = findIndex(oldContent);
    if (idx === -1) {
      return {
        ok: false,
        message: "No matching fact to replace.",
        entryCount: entries.length,
      };
    }
    const next = [...entries];
    next[idx] = content;
    const bounded = evictOldestToFit(next, idx);
    if (!bounded) {
      return {
        ok: false,
        message:
          "This fact is larger than the entire user-profile budget; shorten it before saving.",
        entryCount: entries.length,
      };
    }
    await writeEntries(stellaDataDir, bounded.entries);
    return {
      ok: true,
      message: `Updated${evictionNote(bounded.evicted)}.`,
      entryCount: bounded.entries.length,
    };
  }

  // remove
  const needle = oldContent || content;
  if (!needle) {
    return {
      ok: false,
      message: "remove requires content (the fact to forget).",
      entryCount: entries.length,
    };
  }
  const idx = findIndex(needle);
  if (idx === -1) {
    return {
      ok: false,
      message: "No matching fact to remove.",
      entryCount: entries.length,
    };
  }
  const next = entries.filter((_, i) => i !== idx);
  await writeEntries(stellaDataDir, next);
  return { ok: true, message: "Forgotten.", entryCount: next.length };
};

export const applyUserProfileOperation = (
  stellaDataDir: string,
  op: UserProfileOperation,
): Promise<UserProfileOperationResult> =>
  withProfileLock(() => applyUserProfileOperationLocked(stellaDataDir, op));
