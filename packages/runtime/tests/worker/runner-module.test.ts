import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, ManagedRuntime } from "effect";

const harness = { imports: 0, fail: false };

const makeRuntime = async () => {
  // doMock + resetModules gives every test a fresh module and a fresh import.
  vi.doMock("../../kernel/runner.js", () => {
    harness.imports += 1;
    if (harness.fail) throw new Error("runner chunk failed to load");
    return { createStellaHostRunner: () => ({}) };
  });
  const RunnerModule = await import("../../worker/server/runner-module.js");
  const runtime = ManagedRuntime.make(RunnerModule.layer);
  const getService = () =>
    runtime.runPromise(
      Effect.gen(function* () {
        return yield* RunnerModule.Service;
      }),
    );
  return { runtime, getService };
};

afterEach(() => {
  vi.doUnmock("../../kernel/runner.js");
  vi.resetModules();
  harness.imports = 0;
  harness.fail = false;
});

describe("RunnerModule", () => {
  it("imports once: prefetch and later loads join the same import", async () => {
    const { runtime, getService } = await makeRuntime();
    const service = await getService();
    await runtime.runPromise(service.prefetch);
    await runtime.runPromise(service.prefetch);
    const [a, b] = await Promise.all([service.load(), service.load()]);
    expect(a).toBe(b);
    expect(typeof a.createStellaHostRunner).toBe("function");
    expect(harness.imports).toBe(1);
    await runtime.dispose();
  });

  it("load starts the import when nothing prefetched it", async () => {
    const { runtime, getService } = await makeRuntime();
    const service = await getService();
    await expect(service.load()).resolves.toHaveProperty(
      "createStellaHostRunner",
    );
    await runtime.dispose();
  });

  it("stores an import failure and re-raises the original error to load", async () => {
    harness.fail = true;
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { runtime, getService } = await makeRuntime();
      const service = await getService();
      await runtime.runPromise(service.prefetch);
      // Let the failed import settle with nobody awaiting it.
      await new Promise((resolve) => setTimeout(resolve, 20));
      // vitest wraps a throwing mock factory in its own error; what matters
      // is that every load re-raises the one stored import failure.
      const first = await service.load().then(
        () => null,
        (error: unknown) => error,
      );
      const second = await service.load().then(
        () => null,
        (error: unknown) => error,
      );
      expect(first).toBeInstanceOf(Error);
      expect(second).toBe(first);
      expect(harness.imports).toBe(1);
      await runtime.dispose();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("runs no import until prefetch or load", async () => {
    const { runtime, getService } = await makeRuntime();
    await getService();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.imports).toBe(0);
    await runtime.dispose();
  });
});
