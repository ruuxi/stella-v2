/**
 * Mount-time settling for jsdom render-budget tests.
 *
 * A render budget counts every commit inside its window, so any deferred work
 * the tree scheduled at mount must finish before the window opens, or a slow
 * runner lands it mid-window. Two sources exist in the chat trees:
 *
 * - ChatTimeline widens its draw distance from an idle callback. jsdom has no
 *   requestIdleCallback, so that fell back to a 240 ms timer.
 * - The auth-session hook starts a real network read of the session on mount,
 *   and its settle re-renders every session consumer (the panel owner, the
 *   cloud connect / intervention cards) whenever the round trip completes.
 */
import { vi } from "vitest";
import type * as AuthSessionModule from "@/global/auth/services/auth-session";

/**
 * Factory body for
 * `vi.mock("@/global/auth/services/auth-session", ...)`: holds the session at
 * one settled snapshot so no render depends on the network.
 */
export const settledAuthSessionModule = async (
  importOriginal: <T>() => Promise<T>,
) => {
  const actual = await importOriginal<typeof AuthSessionModule>();
  const settled = { ...actual.getAuthSessionSnapshot(), isPending: false };
  return { ...actual, useDesktopAuthSession: () => settled };
};

/**
 * Routes requestIdleCallback / cancelIdleCallback through a queue the test
 * drains explicitly. Call in beforeEach; `vi.unstubAllGlobals()` in afterEach
 * restores the originals.
 */
export const installIdleCallbackQueue = () => {
  const callbacks = new Map<number, IdleRequestCallback>();
  let nextHandle = 1;
  vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
    const handle = nextHandle++;
    callbacks.set(handle, callback);
    return handle;
  });
  vi.stubGlobal("cancelIdleCallback", (handle: number) => {
    callbacks.delete(handle);
  });
  return {
    get pending() {
      return callbacks.size;
    },
    /** Runs queued callbacks, including any they schedule, until empty. */
    flush() {
      while (callbacks.size > 0) {
        const batch = [...callbacks.values()];
        callbacks.clear();
        for (const callback of batch) {
          callback({ didTimeout: false, timeRemaining: () => 50 });
        }
      }
    },
  };
};
