/**
 * Shared UI state store — owns `~/.stella/ui-state.json`, the renderer's
 * durable key/value state (formerly per-origin localStorage).
 *
 * Two hosts run an instance of this store against the same file at once: the
 * Electron main process and the Vite dev server (for plain-browser tabs).
 * Convergence model:
 *   - Writes are per-key read-merge-write: a flush re-reads the file and
 *     applies only this host's pending deltas on top, so concurrent hosts
 *     converge last-write-wins per key instead of clobbering whole maps.
 *   - Each host watches the file and emits external diffs to its renderers.
 *     Self-writes never emit: after a flush the file equals memory, so the
 *     watcher's diff is empty (content-based suppression, no timing games).
 *
 * Effect-native internals (M5): the debounce timers are Effect fibers
 * (`Effect.sleep` + fork) instead of `setTimeout`, and the fs watchers are
 * scope-managed resources (`Effect.acquireRelease` into a per-store Scope)
 * released by `dispose()`. The public `UiStateStore` API is unchanged —
 * synchronous plain TS, no Effect types — backed by one module-level
 * `ManagedRuntime` (host/lifecycle.ts / supervised-scope.ts pattern).
 * The debounce fibers are forked detached (not into the store Scope) so the
 * synchronous `flushSync`/`dispose` contract can interrupt them without an
 * async scope-close handshake; `dispose()` interrupts them explicitly.
 */

import fs from "fs";
import path from "path";
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Scope,
} from "effect";
import { ensurePrivateDirSync } from "@stella/runtime/kernel/shared/private-fs";
import {
  UI_STATE_FILE_NAME,
  type UiStateChanges,
  type UiStateSnapshot,
} from "@stella/contracts/ui-state";

const FLUSH_DEBOUNCE_MS = 150;
const WATCH_DEBOUNCE_MS = 50;
const PRIVATE_FILE_MODE = 0o600;

/** Shared runtime for every store instance; per-store state lives in `makeCore`. */
const uiStateRuntime = ManagedRuntime.make(Layer.empty);

/** Run a store Effect synchronously, rethrowing the original failure object. */
const runStore = <A, E>(effect: Effect.Effect<A, E>): A => {
  const exit = uiStateRuntime.runSyncExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
};

const readUiStateFile = (filePath: string): Map<string, string> => {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return new Map();
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return new Map();
    }
    const state = new Map<string, string>();
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        state.set(key, value);
      }
    }
    return state;
  } catch {
    return new Map();
  }
};

type StoreCore = {
  snapshot: () => UiStateSnapshot;
  get: (key: string) => string | null;
  apply: (changes: UiStateChanges) => UiStateChanges;
  clear: () => UiStateChanges;
  onExternalChange: (listener: (changes: UiStateChanges) => void) => () => void;
  flushSync: () => void;
  dispose: () => void;
};

const makeCore = Effect.fn("UiStateStore.make")(function* (
  stellaDataDir: string,
) {
  const filePath = path.join(stellaDataDir, UI_STATE_FILE_NAME);
  yield* Effect.sync(() => ensurePrivateDirSync(path.dirname(filePath)));
  const memory = yield* Effect.sync(() => readUiStateFile(filePath));

  const pending = new Map<string, string | null>();
  const listeners = new Set<(changes: UiStateChanges) => void>();
  let pendingClear = false;
  let disposed = false;
  let flushFiber: Fiber.Fiber<void> | null = null;
  let watchFiber: Fiber.Fiber<void> | null = null;

  /** Owns the fs watcher and the stat-poll registration (see below). */
  const scope = Scope.makeUnsafe();

  /**
   * Syncs memory to `next` (the authoritative on-disk state plus our pending
   * deltas) and emits the diff. Self-writes produce an empty diff.
   */
  const reconcileMemory = (next: Map<string, string>) => {
    const changes: UiStateChanges = {};
    for (const [key, value] of next) {
      if (memory.get(key) !== value) {
        changes[key] = value;
      }
    }
    for (const key of memory.keys()) {
      if (!next.has(key)) {
        changes[key] = null;
      }
    }
    if (Object.keys(changes).length === 0) return;

    for (const [key, value] of Object.entries(changes)) {
      if (value === null) {
        memory.delete(key);
      } else {
        memory.set(key, value);
      }
    }
    for (const listener of listeners) {
      try {
        listener(changes);
      } catch (error) {
        console.warn(
          "[ui-state] Change listener failed:",
          (error as Error).message,
        );
      }
    }
  };

  /** Expected on-disk state with our unflushed deltas layered on top. */
  const mergePendingOntoDisk = (): Map<string, string> => {
    const next = pendingClear
      ? new Map<string, string>()
      : readUiStateFile(filePath);
    for (const [key, value] of pending) {
      if (value === null) {
        next.delete(key);
      } else {
        next.set(key, value);
      }
    }
    return next;
  };

  const writeAtomic = (state: Map<string, string>) =>
    Effect.try({
      try: () => {
        const tmpPath = `${filePath}.${process.pid}.${Math.random()
          .toString(36)
          .slice(2)}.tmp`;
        const body = JSON.stringify(Object.fromEntries(state), null, 2);
        fs.writeFileSync(tmpPath, body, {
          encoding: "utf-8",
          mode: PRIVATE_FILE_MODE,
        });
        try {
          fs.renameSync(tmpPath, filePath);
        } catch (error) {
          fs.rmSync(tmpPath, { force: true });
          throw error;
        }
      },
      catch: (error) => error,
    });

  const flushEffect = Effect.fn("UiStateStore.flush")(function* () {
    // Read-merge-write: start from the file's current state (another host
    // may have flushed since our last read) unless this flush carries a
    // clear, then layer only our pending deltas on top.
    const next = yield* Effect.sync(mergePendingOntoDisk);
    pending.clear();
    pendingClear = false;

    const wrote = yield* writeAtomic(next).pipe(
      Effect.map(() => true),
      Effect.catch((error) =>
        Effect.sync(() => {
          console.warn(
            "[ui-state] Failed to persist ui-state.json:",
            (error as Error).message,
          );
          return false;
        }),
      ),
    );
    if (!wrote) return;

    // The merge may have pulled in another host's keys; sync memory to the
    // written state and surface those external diffs to our renderers.
    yield* Effect.sync(() => reconcileMemory(next));
  });

  const scheduleFlush = () => {
    if (flushFiber || disposed) return;
    flushFiber = uiStateRuntime.runFork(
      Effect.gen(function* () {
        yield* Effect.sleep(FLUSH_DEBOUNCE_MS);
        flushFiber = null;
        yield* flushEffect();
      }),
    );
  };

  const watchReadEffect = Effect.fn("UiStateStore.watchRead")(function* () {
    // Expected state = on-disk content with our unflushed deltas on top.
    // Diffing that against memory means our own flushes (file == memory)
    // and pending-key overlaps never emit; only genuinely external
    // changes do.
    const next = yield* Effect.sync(mergePendingOntoDisk);
    yield* Effect.sync(() => reconcileMemory(next));
  });

  const scheduleWatchRead = () => {
    if (watchFiber || disposed) return;
    watchFiber = uiStateRuntime.runFork(
      Effect.gen(function* () {
        yield* Effect.sleep(WATCH_DEBOUNCE_MS);
        watchFiber = null;
        yield* watchReadEffect();
      }),
    );
  };

  // Watch the directory, not the file: atomic renames replace the inode,
  // which silently kills direct file watches on some platforms. The
  // prefix match (not equality) is deliberate — Bun's fs.watch reports a
  // rename only under the *source* tmp name (`ui-state.json.<pid>….tmp`),
  // never the destination, so an exact-name filter drops every event.
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      try {
        return fs.watch(path.dirname(filePath), (_event, filename) => {
          if (filename && !filename.startsWith(UI_STATE_FILE_NAME)) return;
          scheduleWatchRead();
        });
      } catch (error) {
        console.warn(
          "[ui-state] File watcher unavailable; falling back to polling only:",
          (error as Error).message,
        );
        return null;
      }
    }),
    (watcher) => Effect.sync(() => watcher?.close()),
  ).pipe(Scope.provide(scope));

  // Stat-poll fallback: FSEvents/inotify can silently drop or coalesce
  // events; a 1s mtime poll guarantees eventual cross-host convergence.
  // Kept as fs.watchFile (not a Schedule loop) deliberately: its
  // `persistent: false` stat timer never holds the process open, which a
  // fiber-driven sleep loop would.
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      fs.watchFile(
        filePath,
        { interval: 1_000, persistent: false },
        (curr, prev) => {
          if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
            scheduleWatchRead();
          }
        },
      );
    }),
    () => Effect.sync(() => fs.unwatchFile(filePath)),
  ).pipe(Scope.provide(scope));

  const flushSync = () => {
    const fiber = flushFiber;
    if (fiber) {
      flushFiber = null;
      fiber.interruptUnsafe();
    }
    if (!pendingClear && pending.size === 0) return;
    runStore(flushEffect());
  };

  const core: StoreCore = {
    snapshot: () => Object.fromEntries(memory),
    get: (key) => memory.get(key) ?? null,
    apply: (changes) => {
      const applied: UiStateChanges = {};
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) {
          if (!memory.has(key)) continue;
          memory.delete(key);
        } else {
          if (memory.get(key) === value) continue;
          memory.set(key, value);
        }
        pending.set(key, value);
        applied[key] = value;
      }
      if (Object.keys(applied).length > 0) {
        scheduleFlush();
      }
      return applied;
    },
    clear: () => {
      const removed: UiStateChanges = {};
      for (const key of memory.keys()) {
        removed[key] = null;
      }
      memory.clear();
      pending.clear();
      pendingClear = true;
      scheduleFlush();
      return removed;
    },
    onExternalChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    flushSync,
    dispose: () => {
      disposed = true;
      flushSync();
      const fiber = watchFiber;
      if (fiber) {
        watchFiber = null;
        fiber.interruptUnsafe();
      }
      // Releases the fs watcher and the stat-poll registration; both
      // finalizers are synchronous, so the close settles inline.
      runStore(Scope.close(scope, Exit.void));
      listeners.clear();
    },
  };
  return core;
});

export class UiStateStore {
  private readonly core: StoreCore;

  constructor(stellaDataDir: string) {
    this.core = runStore(makeCore(stellaDataDir));
  }

  snapshot(): UiStateSnapshot {
    return this.core.snapshot();
  }

  get(key: string): string | null {
    return this.core.get(key);
  }

  /**
   * Applies a batch of changes (null = remove). Returns the subset that
   * actually changed in-memory state, for broadcasting to renderers.
   */
  apply(changes: UiStateChanges): UiStateChanges {
    return this.core.apply(changes);
  }

  /** Removes every key. Returns the removal change set for broadcasting. */
  clear(): UiStateChanges {
    return this.core.clear();
  }

  /** Listener for changes written by another host (or another process). */
  onExternalChange(listener: (changes: UiStateChanges) => void): () => void {
    return this.core.onExternalChange(listener);
  }

  /** Synchronously persists pending deltas (shutdown path). */
  flushSync(): void {
    this.core.flushSync();
  }

  dispose(): void {
    this.core.dispose();
  }
}
