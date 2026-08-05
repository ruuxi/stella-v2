// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetUserAppsRegistryForTests,
  getSnapshot,
  refreshUserApps,
  subscribe,
} from "@/app/apps/user-apps-registry";

const app = {
  slug: "ledger",
  meta: { label: "Ledger", createdAt: "2026-01-01T00:00:00.000Z" },
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("external user-app registry", () => {
  let changed: (() => void) | null;

  beforeEach(() => {
    vi.useFakeTimers();
    changed = null;
    __resetUserAppsRegistryForTests();
  });

  afterEach(() => {
    __resetUserAppsRegistryForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  const installApi = (
    list: ReturnType<typeof vi.fn>,
    refresh: ReturnType<typeof vi.fn> = list,
  ) => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      userApps: {
        list,
        refresh,
        onUpdated: (callback: () => void) => {
          changed = callback;
          return () => {
            changed = null;
          };
        },
      },
    };
  };

  it("loads on first subscription without flashing a ready empty state", async () => {
    const list = vi.fn().mockResolvedValue({ apps: [app] });
    installApi(list);

    const unsubscribe = subscribe(vi.fn());
    expect(getSnapshot()).toMatchObject({ phase: "loading", apps: [] });

    await flush();
    expect(list).toHaveBeenCalledTimes(1);
    expect(getSnapshot()).toMatchObject({
      phase: "ready",
      apps: [expect.objectContaining({ slug: "ledger" })],
      refreshing: false,
    });
    unsubscribe();
  });

  it("preserves the last-good list when a refresh fails, then retries", async () => {
    const list = vi.fn().mockResolvedValue({ apps: [app] });
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("folder unavailable"))
      .mockResolvedValueOnce({ apps: [app] });
    installApi(list, refresh);
    const unsubscribe = subscribe(vi.fn());
    await flush();

    await refreshUserApps();
    expect(getSnapshot()).toMatchObject({
      phase: "error",
      error: "folder unavailable",
      apps: [expect.objectContaining({ slug: "ledger" })],
    });

    await refreshUserApps();
    expect(getSnapshot()).toMatchObject({
      phase: "ready",
      error: null,
      apps: [expect.objectContaining({ slug: "ledger" })],
    });
    unsubscribe();
  });

  it("coalesces filesystem signals that arrive during a refresh", async () => {
    let resolveRefresh: ((value: { apps: (typeof app)[] }) => void) | null =
      null;
    const list = vi.fn().mockResolvedValue({ apps: [app] });
    const refresh = vi.fn(() =>
      refresh.mock.calls.length === 1
        ? new Promise<{ apps: (typeof app)[] }>((resolve) => {
            resolveRefresh = resolve;
          })
        : Promise.resolve({ apps: [app] }),
    );
    installApi(list, refresh);
    const unsubscribe = subscribe(vi.fn());
    await flush();

    changed?.();
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    changed?.();
    changed?.();
    resolveRefresh?.({ apps: [app] });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    unsubscribe();
  });

  it("reports unsupported when the preload bridge is absent", async () => {
    const unsubscribe = subscribe(vi.fn());
    await flush();
    expect(getSnapshot()).toMatchObject({
      phase: "unsupported",
      apps: [],
    });
    unsubscribe();
  });

  it("recovers from an initial IPC failure without user action", async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error("runtime unavailable"))
      .mockResolvedValueOnce({ apps: [app] });
    installApi(list);

    const unsubscribe = subscribe(vi.fn());
    await flush();
    expect(getSnapshot()).toMatchObject({
      phase: "error",
      error: "runtime unavailable",
      apps: [],
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(list).toHaveBeenCalledTimes(2);
    expect(getSnapshot()).toMatchObject({
      phase: "ready",
      error: null,
      apps: [expect.objectContaining({ slug: "ledger" })],
    });
    unsubscribe();
  });

  it("cancels a scheduled retry after the last subscriber leaves", async () => {
    const list = vi.fn().mockRejectedValue(new Error("runtime unavailable"));
    installApi(list);

    const unsubscribe = subscribe(vi.fn());
    await flush();
    expect(list).toHaveBeenCalledTimes(1);

    unsubscribe();
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(list).toHaveBeenCalledTimes(1);
  });
});
