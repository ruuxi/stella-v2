import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { redactMemoryText } from "./redaction.js";

export const USER_PROFILE_FILE = "profile.md";

export const MAX_USER_PROFILE_CHARS = 8_000;

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

  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, renderUserProfile(entries), "utf-8");

    await fs.rename(tmp, target);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
};

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
