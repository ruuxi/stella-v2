import { promises as fs } from "fs";
import path from "path";

const queues = new Map<string, Promise<void>>();

const lockKeyForPath = (filePath: string): string => {
  const resolved = path.resolve(filePath);

  return process.platform === "linux" ? resolved : resolved.toLowerCase();
};

export const withFileWriteLock = async <T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const key = lockKeyForPath(filePath);
  const prev = queues.get(key) ?? Promise.resolve();

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

export const pendingFileWriteLockCount = (): number => queues.size;

const containsUnexpectedNul = (written: string, intended: string): boolean =>
  written.includes("\u0000") && !intended.includes("\u0000");

export const writeFileWithNulGuard = async (
  filePath: string,
  content: string,
  options?: { flag?: string },
): Promise<void> => {
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await fs.writeFile(filePath, content, {
      encoding: "utf-8",
      ...(options?.flag && attempt === 1 ? { flag: options.flag } : {}),
    });
    const written = await fs.readFile(filePath, "utf-8");
    if (!containsUnexpectedNul(written, content)) {
      return;
    }
    console.error(
      `[file-write-lock] NUL-byte corruption detected after writing ` +
        `${filePath} (attempt ${attempt}/${maxAttempts}) — this should be ` +
        `impossible with per-path serialization; investigate concurrent ` +
        `writers outside the tool layer.`,
    );
  }
  throw new Error(
    `Write verification failed for ${filePath}: file contains NUL bytes ` +
      `that were not part of the intended content, even after a retry. ` +
      `The file may be corrupted by a concurrent writer.`,
  );
};
