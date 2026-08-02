/**
 * Resident user-profile store — the small, always-injected doc of durable
 * facts Stella knows about the user (name, location, stable preferences).
 *
 * This is Stella's answer to "remember my name": unlike the Dream ledger
 * (`MEMORY.md` / `memory_map.md`, reachable through Recall
 * lookup tool), `profile.md` is push-injected into the Orchestrator at
 * session start, so durable identity facts are always in context without a
 * lookup. It is written exclusively by the Orchestrator's `Remember` tool —
 * no other writer touches it, so there is no consolidation race with Dream.
 *
 * Entries are one fact per markdown bullet, deduped case-insensitively, with
 * a hard char cap so the resident block stays cheap to inject every session.
 * Mirrors the spirit of Hermes's `USER.md`.
 *
 * Effect-native: reads/writes are Effects and the read-modify-write cycle is
 * serialized by a process-global `Semaphore(1)` (replacing the old promise
 * chain). The exported Promise API is a facade over the shared memory
 * ManagedRuntime and rejects with the original failure objects.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Effect, Semaphore } from "effect";

import { redactMemoryText } from "./redaction.js";
import { runMemoryPromise } from "./effect-runtime.js";
import { tryFs } from "./effect-io.js";

export const USER_PROFILE_FILE = "profile.md";

/** Cap on the rendered entries body (excludes the fixed header). */
export const MAX_USER_PROFILE_CHARS = 6_000;

/**
 * Read-side safety ceiling. Remember is the only supported writer and rejects
 * at 6K; the extra headroom bounds manually damaged files without clipping a
 * valid profile produced by the tool.
 */
export const USER_PROFILE_INJECTED_MAX_CHARS = MAX_USER_PROFILE_CHARS + 1_000;

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

/** Read the raw profile file; any failure (missing file, …) reads as null. */
export const readUserProfileEffect = (
  stellaDataDir: string,
): Effect.Effect<string | null> =>
  tryFs(() => fs.readFile(userProfilePath(stellaDataDir), "utf-8")).pipe(
    Effect.catch(() => Effect.succeed(null)),
  );

export const readUserProfile = (
  stellaDataDir: string,
): Promise<string | null> => runMemoryPromise(readUserProfileEffect(stellaDataDir));

const readEntriesEffect = (
  stellaDataDir: string,
): Effect.Effect<string[]> =>
  readUserProfileEffect(stellaDataDir).pipe(
    Effect.map((content) =>
      content ? parseUserProfileEntries(content) : [],
    ),
  );

const writeEntriesEffect = (
  stellaDataDir: string,
  entries: string[],
): Effect.Effect<void, NodeJS.ErrnoException> =>
  Effect.suspend(() => {
    const target = userProfilePath(stellaDataDir);
    // Unique temp per write: a fixed `${target}.tmp` would let two concurrent
    // writers corrupt each other's bytes or fail the rename with ENOENT.
    const tmp = `${target}.${randomUUID()}.tmp`;
    return tryFs(() =>
      fs.mkdir(path.dirname(target), { recursive: true }),
    ).pipe(
      Effect.andThen(
        tryFs(() => fs.writeFile(tmp, renderUserProfile(entries), "utf-8")),
      ),
      // Atomic swap: readers (and the resident-doc injector) never observe a
      // half-written file.
      Effect.andThen(tryFs(() => fs.rename(tmp, target))),
      Effect.tapError(() =>
        Effect.promise(() => fs.rm(tmp, { force: true }).catch(() => {})),
      ),
      Effect.asVoid,
    );
  });

/**
 * Serializes the profile's read-modify-write. The agent loop runs tool calls
 * in parallel (`multi_tool_use_parallel`), so two `Remember` calls in one turn
 * would otherwise both read the same entries and clobber each other's update.
 * Process-global is fine: there is one profile per kernel process and writes
 * are infrequent.
 */
const profileLock = Semaphore.makeUnsafe(1);

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
 * Apply a single add/replace/remove operation to `profile.md`. Content is
 * redacted and whitespace-collapsed; adds dedupe case-insensitively and are
 * rejected when they would push the body past {@link MAX_USER_PROFILE_CHARS}.
 */
const applyUserProfileOperationLocked = (
  stellaDataDir: string,
  op: UserProfileOperation,
): Effect.Effect<UserProfileOperationResult, NodeJS.ErrnoException> =>
  Effect.gen(function* () {
    const entries = yield* readEntriesEffect(stellaDataDir);
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
        return {
          ok: false,
          message: "add requires content.",
          entryCount: entries.length,
        };
      }
      if (entries.some((entry) => sameEntry(entry, content))) {
        return {
          ok: true,
          message: "Already remembered; left unchanged.",
          entryCount: entries.length,
        };
      }
      const next = [...entries, content];
      if (entriesBodyLength(next) > MAX_USER_PROFILE_CHARS) {
        return {
          ok: false,
          message:
            "User profile is full. Replace or remove a stale fact before adding more.",
          entryCount: entries.length,
        };
      }
      yield* writeEntriesEffect(stellaDataDir, next);
      return { ok: true, message: "Remembered.", entryCount: next.length };
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
      if (entriesBodyLength(next) > MAX_USER_PROFILE_CHARS) {
        return {
          ok: false,
          message: "Replacement would exceed the user-profile size cap.",
          entryCount: entries.length,
        };
      }
      yield* writeEntriesEffect(stellaDataDir, next);
      return { ok: true, message: "Updated.", entryCount: next.length };
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
    yield* writeEntriesEffect(stellaDataDir, next);
    return { ok: true, message: "Forgotten.", entryCount: next.length };
  });

export const applyUserProfileOperationEffect = (
  stellaDataDir: string,
  op: UserProfileOperation,
): Effect.Effect<UserProfileOperationResult, NodeJS.ErrnoException> =>
  profileLock.withPermit(applyUserProfileOperationLocked(stellaDataDir, op));

export const applyUserProfileOperation = (
  stellaDataDir: string,
  op: UserProfileOperation,
): Promise<UserProfileOperationResult> =>
  runMemoryPromise(applyUserProfileOperationEffect(stellaDataDir, op));
