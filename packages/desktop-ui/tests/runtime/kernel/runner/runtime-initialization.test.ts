import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createExtensionReloadScheduler,
  isExtensionWatchChangeRelevant,
} from "@stella/runtime/kernel/runner/runtime-initialization";

describe("runtime extension watching", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("limits top-level data-dir changes to the atomic system mirror", () => {
    expect(isExtensionWatchChangeRelevant("data-dir", "system")).toBe(true);

    for (const unrelated of [
      "stella.sqlite",
      "stella.sqlite-wal",
      "stella.sqlite-shm",
      "models.json",
      "system.next",
      null,
    ]) {
      expect(isExtensionWatchChangeRelevant("data-dir", unrelated)).toBe(false);
    }

    expect(
      isExtensionWatchChangeRelevant("resource-tree", "agents/general.md"),
    ).toBe(true);
    expect(
      isExtensionWatchChangeRelevant("resource-tree", "agents/.draft"),
    ).toBe(false);
    expect(
      isExtensionWatchChangeRelevant("resource-tree", "agents/general.md~"),
    ).toBe(false);
  });

  it("coalesces bursts and retries a busy runtime without repeated busy logs", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const reload = vi.fn(async (_options: { logBusy: boolean }) => {
      attempts += 1;
      if (attempts < 4) return { status: "busy" as const };
      return { status: "reloaded" as const };
    });
    const scheduler = createExtensionReloadScheduler(reload, {
      debounceMs: 500,
      busyRetryMs: 2_000,
    });

    for (let index = 0; index < 50; index += 1) scheduler.schedule();
    await vi.advanceTimersByTimeAsync(499);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reload.mock.calls.map(([options]) => options.logBusy)).toEqual([
      true,
    ]);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(reload.mock.calls.map(([options]) => options.logBusy)).toEqual([
      true,
      false,
    ]);

    for (let index = 0; index < 100; index += 1) scheduler.schedule();
    await vi.advanceTimersByTimeAsync(500);
    expect(reload.mock.calls.map(([options]) => options.logBusy)).toEqual([
      true,
      false,
      false,
    ]);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(reload.mock.calls.map(([options]) => options.logBusy)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reload).toHaveBeenCalledTimes(4);
  });

  it("cancels a pending debounce during shutdown", async () => {
    vi.useFakeTimers();
    const reload = vi.fn(async () => ({ status: "reloaded" as const }));
    const scheduler = createExtensionReloadScheduler(reload);
    scheduler.schedule();
    scheduler.cancel();
    await vi.runAllTimersAsync();
    expect(reload).not.toHaveBeenCalled();
  });

  it("recovers on the next schedule after a reload rejects", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reload = vi
      .fn<(options: { logBusy: boolean }) => Promise<{ status: "reloaded" }>>()
      .mockRejectedValueOnce(new Error("reload crashed"))
      .mockResolvedValue({ status: "reloaded" });
    const scheduler = createExtensionReloadScheduler(reload, {
      debounceMs: 500,
      busyRetryMs: 2_000,
    });

    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(500);
    expect(reload).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);

    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(500);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(reload.mock.calls.map(([options]) => options.logBusy)).toEqual([
      true,
      true,
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
