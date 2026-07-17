import { closeSync, openSync, writeFileSync, promises as fsPromises } from "node:fs";
import { Effect, Schedule, type Scope } from "effect";
import { HostLockBusyError, HostLockTimeoutError } from "./errors.js";

/**
 * Host-side lockfile serialization (`runtime.lock.host`): concurrent host
 * starts for the same stellaAppDir must not race the discover-or-spawn
 * critical section. Scope-managed — the release finalizer (close fd +
 * unlink) runs on success, failure, AND interruption, so an interrupted
 * attach can never strand the lock.
 *
 * The acquire loop mirrors opencode's effect-flock: a single `wx`-create
 * attempt that fails with the retryable HostLockBusyError, driven by
 * `Schedule.spaced(50ms)` bounded by `Schedule.during(timeoutMs)` —
 * observably the same 50ms spacing and total budget as the old hand-rolled
 * while-loop, with the same atomic rename-based stale takeover inside the
 * attempt.
 */

const ACQUIRE_POLL_INTERVAL_MS = 50;

export type HostLockHandle = {
  readonly lockFile: string;
  readonly fd: number;
};

/**
 * One acquire attempt. On EEXIST: if the recorded holder is alive, fail
 * busy; if it is dead (or unreadable), take over the stale lock via atomic
 * rename() — only one racing host wins the takeover; the loser's rename
 * fails and it simply retries rather than blindly deleting what may already
 * be another host's freshly created lock (the TOCTOU close the old code
 * documented). Non-EEXIST errors (and write-pid failures) are not retried.
 */
const tryAcquireLockFile = (
  lockFile: string,
): Effect.Effect<HostLockHandle, HostLockBusyError | Error> =>
  Effect.gen(function* () {
    let fd: number;
    try {
      fd = openSync(lockFile, "wx");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        return yield* Effect.fail(error as Error);
      }
      yield* takeOverStaleLock(lockFile);
      return yield* Effect.fail(new HostLockBusyError({ lockFile }));
    }
    try {
      writeFileSync(fd, String(process.pid), "utf-8");
    } catch (error) {
      closeSync(fd);
      yield* Effect.promise(() =>
        fsPromises.unlink(lockFile).catch(() => undefined),
      );
      return yield* Effect.fail(error as Error);
    }
    return { lockFile, fd };
  });

/** If the holder died, clear the stale lock so the next attempt can win. */
const takeOverStaleLock = (lockFile: string): Effect.Effect<void> =>
  Effect.promise(async () => {
    try {
      const raw = await fsPromises.readFile(lockFile, "utf-8");
      const pid = Number.parseInt(raw.trim(), 10);
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          // Holder is alive; keep waiting.
          return;
        } catch {
          // Holder is dead — fall through to the atomic takeover below.
        }
      }
      const stalePath = `${lockFile}.${process.pid}.stale`;
      try {
        await fsPromises.rename(lockFile, stalePath);
      } catch {
        // Lost the takeover race (or the lock was already gone); retry.
        return;
      }
      await fsPromises.unlink(stalePath).catch(() => undefined);
    } catch {
      // Lock removed by another process; try again.
    }
  });

const releaseLock = (handle: HostLockHandle): Effect.Effect<void> =>
  Effect.promise(async () => {
    try {
      closeSync(handle.fd);
    } catch {
      // Ignore close errors during release.
    }
    await fsPromises.unlink(handle.lockFile).catch(() => undefined);
  });

/**
 * Acquire the host lock as a scoped resource. The enclosing scope's close
 * releases it in all exits.
 */
export const acquireHostLock = (
  lockFile: string,
  timeoutMs: number,
): Effect.Effect<HostLockHandle, HostLockTimeoutError | Error, Scope.Scope> =>
  Effect.acquireRelease(
    tryAcquireLockFile(lockFile).pipe(
      Effect.retry({
        while: (error) => error instanceof HostLockBusyError,
        schedule: Schedule.both(
          Schedule.spaced(ACQUIRE_POLL_INTERVAL_MS),
          Schedule.during(timeoutMs),
        ),
      }),
      Effect.mapError((error) =>
        error instanceof HostLockBusyError
          ? new HostLockTimeoutError({ lockFile, timeoutMs })
          : error,
      ),
    ),
    (handle) => releaseLock(handle),
  );
