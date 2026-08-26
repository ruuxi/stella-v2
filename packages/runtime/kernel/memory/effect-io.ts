import { promises as fs } from "node:fs";
import { Effect } from "effect";
import { withFileWriteLock } from "../tools/file-write-lock.js";

/**
 * Shared Effect adapters for the memory subsystem's filesystem IO and its
 * cross-tool write lock. Pure text/parse helpers stay plain functions in the
 * modules that own them; these wrappers exist so every read/write runs as an
 * Effect while preserving the exact error objects Node's fs would throw.
 */

/** Wrap one async fs call; failures carry the original ErrnoException. */
export const tryFs = <A>(
  op: () => Promise<A>,
): Effect.Effect<A, NodeJS.ErrnoException> =>
  Effect.tryPromise({
    try: op,
    catch: (error) => error as NodeJS.ErrnoException,
  });

/** Wrap one sync fs call; failures carry the original ErrnoException. */
export const tryFsSync = <A>(
  op: () => A,
): Effect.Effect<A, NodeJS.ErrnoException> =>
  Effect.try({
    try: op,
    catch: (error) => error as NodeJS.ErrnoException,
  });

/** `readFile(utf-8)` with ENOENT mapped to null; other errors re-fail. */
export const readOptionalTextFile = (
  target: string,
): Effect.Effect<string | null, NodeJS.ErrnoException> =>
  tryFs(() => fs.readFile(target, "utf-8")).pipe(
    Effect.catchIf(
      (error) => error.code === "ENOENT",
      () => Effect.succeed(null),
    ),
  );

/**
 * Run `body` while holding the SAME per-path FIFO write lock the file tools
 * use (`kernel/tools/file-write-lock.ts`) so memory writes serialize with
 * edits made through file tools.
 *
 * The queue slot is modeled as a scoped resource: acquisition resolves when
 * this caller's turn arrives, and the release finalizer hands the lock to
 * the next queued writer on success, failure, or interruption.
 */
export const withFileWriteLockEffect = <A, E, R>(
  target: string,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.promise<() => void>(
        () =>
          new Promise((resolveAcquired) => {
            void withFileWriteLock(
              target,
              () =>
                new Promise<void>((resolveRelease) => {
                  resolveAcquired(() => resolveRelease());
                }),
            );
          }),
      ),
      (release) => Effect.sync(release),
    ).pipe(Effect.flatMap(() => body)),
  );
