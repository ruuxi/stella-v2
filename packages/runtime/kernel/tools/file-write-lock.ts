/**
 * Per-path serialization for file-mutating tools.
 *
 * When an agent batch issues multiple Edit/Write/apply_patch calls against
 * the same file in parallel, unserialized read-modify-write cycles race:
 * last-write-wins clobbering, lost hunks, and (observed in the wild)
 * NUL-padded tail corruption from interleaved writes. Every tool-level
 * mutation of a file must run its ENTIRE read → apply → write cycle inside
 * `withFileWriteLock` so concurrent edits of the same resolved path execute
 * sequentially. Edits to different paths still run in parallel.
 */

import { promises as fs } from "fs";
import path from "path";

const queues = new Map<string, Promise<void>>();

const normalizeLockKey = (resolved: string): string =>
  process.platform === "linux" ? resolved : resolved.toLowerCase();

const lockKeyForPath = (filePath: string): string => {
  const resolved = path.resolve(filePath);
  // File systems on macOS/Windows are typically case-insensitive; normalize
  // so `/Foo.ts` and `/foo.ts` serialize against each other.
  return normalizeLockKey(resolved);
};

/**
 * Resolve aliases before selecting the process-local lock key. Existing
 * files use their real path; new files use the real parent plus basename.
 * This keeps a symlinked Stella data directory on the same queue as its
 * canonical path, which is essential for archive read-modify-write calls.
 */
export const canonicalFileWriteLockPath = async (
  filePath: string,
): Promise<string> => {
  try {
    return await fs.realpath(filePath);
  } catch {
    try {
      return path.join(
        await fs.realpath(path.dirname(filePath)),
        path.basename(filePath),
      );
    } catch {
      return path.resolve(filePath);
    }
  }
};

/**
 * Run `fn` with an exclusive async lock on `filePath`. Calls targeting the
 * same resolved path are chained FIFO; other paths are unaffected. The
 * caller's read-modify-write cycle must live entirely inside `fn` — no
 * reading current content before acquiring the lock.
 */
export const withFileWriteLock = async <T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const key = lockKeyForPath(filePath);
  const prev = queues.get(key) ?? Promise.resolve();
  // Run regardless of whether the previous holder succeeded or failed.
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) {
      queues.delete(key);
    }
  });
  return run;
};

/**
 * Acquire locks on several paths (e.g. an update that also moves the file).
 * Keys are deduped and acquired in sorted order so two multi-path callers
 * can never deadlock against each other.
 */
export const withFileWriteLocks = async <T>(
  filePaths: string[],
  fn: () => Promise<T>,
): Promise<T> => {
  const keys = [...new Set(filePaths.map(lockKeyForPath))].sort();
  const run = keys.reduceRight<() => Promise<T>>(
    (inner, key) => () => withFileWriteLock(key, inner),
    fn,
  );
  return run();
};

/** Exposed for tests: number of paths with an in-flight lock chain. */
export const pendingFileWriteLockCount = (): number => queues.size;

const containsUnexpectedNul = (written: string, intended: string): boolean =>
  written.includes("\u0000") && !intended.includes("\u0000");

const utf8OnDiskIntent = (content: string): string =>
  Buffer.from(content, "utf8").toString("utf8");

/**
 * Write `content` to `filePath` and verify the bytes on disk don't contain
 * NUL bytes that weren't in the intended content (the corruption signature
 * seen when parallel edits raced). Should be unreachable once writes are
 * serialized — retries once and fails loudly if it ever fires.
 */
export const writeFileWithNulGuard = async (
  filePath: string,
  content: string,
  options?: { flag?: string },
): Promise<void> => {
  const maxAttempts = 2;
  const intended = utf8OnDiskIntent(content);
  let lastWritten = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await fs.writeFile(filePath, content, {
      encoding: "utf-8",
      ...(options?.flag && attempt === 1 ? { flag: options.flag } : {}),
    });
    lastWritten = await fs.readFile(filePath, "utf-8");
    if (lastWritten === intended) {
      return;
    }
    const kind = containsUnexpectedNul(lastWritten, intended)
      ? "NUL-byte corruption"
      : "read-back mismatch";
    console.error(
      `[file-write-lock] ${kind} detected after writing ` +
        `${filePath} (attempt ${attempt}/${maxAttempts}) — this should be ` +
        `impossible with per-path serialization; investigate concurrent ` +
        `writers outside the tool layer.`,
    );
  }
  throw new Error(
    containsUnexpectedNul(lastWritten, intended)
      ? `Write verification failed for ${filePath}: file contains NUL bytes ` +
          `that were not part of the intended content, even after a retry. ` +
          `The file may be corrupted by a concurrent writer.`
      : `Write verification failed for ${filePath}: the bytes on disk do ` +
          `not match the intended content, even after a retry.`,
  );
};

/**
 * Crash-safe whole-file replacement. The temp file and containing directory
 * are fsynced before returning, so a completed rewrite survives a crash as a
 * coherent old-or-new file and leaves no ambiguous partial target.
 */
export const writeFileAtomicWithVerify = async (
  filePath: string,
  content: string,
): Promise<void> => {
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${Math.random()
      .toString(36)
      .slice(2)}`,
  );
  try {
    const handle = await fs.open(tmpPath, "wx");
    try {
      await handle.writeFile(content, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const written = await fs.readFile(tmpPath, "utf-8");
    if (written !== utf8OnDiskIntent(content)) {
      throw new Error(
        `Atomic write verification failed for ${filePath}: temp bytes differ from intent.`,
      );
    }
    await fs.rename(tmpPath, filePath);
    const directory = await fs.open(path.dirname(filePath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // A successfully renamed temp path no longer exists; otherwise cleanup
      // is best-effort and the dot-file is never a memory read source.
    }
    throw error;
  }
};
