// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mirrorCloudMemoryPreferenceLocally,
  resetCloudMemoryLocalMirrorForTests,
} from "@/features/cloud/cloud-memory-local-mirror";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

describe("cloud Memory local runtime mirror", () => {
  beforeEach(() => {
    resetCloudMemoryLocalMirrorForTests();
  });

  it("serializes writes so a later fail-closed transition always lands last", async () => {
    const first = deferred<{ memoryEnabled: boolean }>();
    const setLocalModelPreferences = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ memoryEnabled: false });
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { system: { setLocalModelPreferences } },
    });

    const enable = mirrorCloudMemoryPreferenceLocally(true);
    const disable = mirrorCloudMemoryPreferenceLocally(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(setLocalModelPreferences).toHaveBeenCalledTimes(1);
    expect(setLocalModelPreferences).toHaveBeenNthCalledWith(1, {
      memoryEnabled: true,
    });

    first.resolve({ memoryEnabled: true });
    await expect(enable).resolves.toBe(true);
    await expect(disable).resolves.toBe(true);
    expect(setLocalModelPreferences).toHaveBeenNthCalledWith(2, {
      memoryEnabled: false,
    });
  });

  it("continues with the fail-closed write after an earlier mirror rejects", async () => {
    const setLocalModelPreferences = vi
      .fn()
      .mockRejectedValueOnce(new Error("IPC closed"))
      .mockResolvedValueOnce({ memoryEnabled: false });
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { system: { setLocalModelPreferences } },
    });

    await expect(mirrorCloudMemoryPreferenceLocally(true)).rejects.toThrow(
      "IPC closed",
    );
    await expect(mirrorCloudMemoryPreferenceLocally(false)).resolves.toBe(true);
    expect(setLocalModelPreferences).toHaveBeenLastCalledWith({
      memoryEnabled: false,
    });
  });
});
