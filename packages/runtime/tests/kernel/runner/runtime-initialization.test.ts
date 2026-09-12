import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createExtensionReloadScheduler,
  createRuntimeInitialization,
  isExtensionWatchChangeRelevant,
} from "@stella/runtime/kernel/runner/runtime-initialization";

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const emptyExtensions = () => ({
  tools: [],
  hooks: [],
  providers: [],
  prompts: [],
  agents: [],
});

const makeLifecycleHarness = (
  overrides: {
    loadExtensions?: (
      signal: AbortSignal,
    ) => Promise<ReturnType<typeof emptyExtensions>>;
    initializeModels?: (signal: AbortSignal) => Promise<void>;
    refreshModels?: (signal: AbortSignal) => Promise<void>;
  } = {},
) => {
  const events: string[] = [];
  let latchOpen = false;
  const state = {
    isRunning: false,
    isInitialized: false,
    initializationPromise: null as Promise<void> | null,
    initializationStarted: {
      open: () => {
        latchOpen = true;
      },
      reset: () => {
        latchOpen = false;
      },
      isOpen: () => latchOpen,
      awaitOpen: async () => (latchOpen ? "open" : "timeout"),
    },
    loadedAgents: [],
    activeOrchestratorRunId: null,
    activeOrchestratorConversationId: null,
    activeOrchestratorUiVisibility: "visible",
    activeOrchestratorSession: null,
    localAgentManager: null,
    backgroundExitWake: null,
    supervisor: {
      activeRunCount: () => 0,
      abortAllRuns: () => events.push("supervisor-abort"),
      shutdown: async () => {
        events.push("supervisor-stop");
      },
      liveFiberCount: () => 0,
    },
    runCoordinator: null,
    orchestratorSessions: new Map(),
    queuedOrchestratorTurns: [],
    conversationCallbacks: new Map(),
    runCallbacksByRunId: new Map(),
    compactionScheduler: {
      drain: async () => undefined,
      shutdown: async () => {
        events.push("compaction-stop");
      },
    },
  };
  const context = {
    stellaAppDir: "/tmp/stella-app",
    stellaDataDir: "/tmp/stella-data",
    paths: { extensionsPath: "/tmp/stella-data/extensions" },
    runtimeStore: {},
    hookEmitter: {
      register: () => undefined,
      clearBySource: () => undefined,
    },
    toolHost: {
      registerExtensionTools: () => undefined,
      unregisterExtensionTools: () => undefined,
      shutdown: async () => {
        events.push("tool-host-stop");
      },
    },
    cloudTranscript: {
      stop: () => events.push("transcript-stop"),
    },
    state,
  };
  const lifecycle = {
    loadExtensions: async ({ signal }: { signal: AbortSignal }) =>
      overrides.loadExtensions?.(signal) ?? emptyExtensions(),
    initializeModels: async ({ signal }: { signal: AbortSignal }) =>
      overrides.initializeModels?.(signal),
    refreshModels: async ({ signal }: { signal: AbortSignal }) =>
      overrides.refreshModels?.(signal),
    installLoadedExtensions: () => events.push("extensions-installed"),
    startWatchers: () => events.push("watchers-started"),
    stopWatchers: () => events.push("watchers-stopped"),
  };
  const runtime = createRuntimeInitialization(context as never, {
    disposeConvexClient: () => events.push("convex-disposed"),
    shutdownTasks: async () => {
      events.push("tasks-stopped");
    },
    lifecycle,
  });
  return { runtime, state, events };
};

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

    // More writes while the same reload is pending form one debounced retry
    // and do not reopen the busy-log cycle.
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

    // A rejection ends this cycle instead of creating a retry/log storm.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);

    // A later filesystem change starts a clean cycle; `inFlight` was reset.
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

describe("runtime initialization ownership", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("interrupts and joins startup before teardown, with no late registry or watcher commit", async () => {
    const extensions = deferred<ReturnType<typeof emptyExtensions>>();
    const models = deferred<void>();
    const signals: AbortSignal[] = [];
    const { runtime, state, events } = makeLifecycleHarness({
      loadExtensions: (signal) => {
        signals.push(signal);
        return extensions.promise;
      },
      initializeModels: (signal) => {
        signals.push(signal);
        return models.promise;
      },
    });

    runtime.start();
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    const stopped = runtime.stop();

    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(events).toEqual(["watchers-stopped"]);
    expect(state.isRunning).toBe(false);
    expect(state.isInitialized).toBe(false);
    expect(state.initializationPromise).toBeNull();

    extensions.resolve(emptyExtensions());
    models.resolve();
    await stopped;
    await Promise.resolve();

    expect(events).not.toContain("extensions-installed");
    expect(events).not.toContain("watchers-started");
    expect(events.indexOf("convex-disposed")).toBeGreaterThan(
      events.indexOf("watchers-stopped"),
    );
    expect(state.isInitialized).toBe(false);
  });

  it("does not finish initialization when stop lands after extensions but before models", async () => {
    const models = deferred<void>();
    let modelSignal: AbortSignal | null = null;
    const { runtime, state, events } = makeLifecycleHarness({
      loadExtensions: async () => emptyExtensions(),
      initializeModels: (signal) => {
        modelSignal = signal;
        return models.promise;
      },
    });

    runtime.start();
    await vi.waitFor(() => expect(events).toContain("extensions-installed"));
    const stopped = runtime.stop();
    expect(modelSignal?.aborted).toBe(true);
    expect(events).not.toContain("convex-disposed");

    models.resolve();
    await stopped;

    expect(events).not.toContain("watchers-started");
    expect(state.isInitialized).toBe(false);
    expect(events).toContain("convex-disposed");
  });

  it("owns and joins the post-ready catalog refresh before shutdown dependencies", async () => {
    const refresh = deferred<void>();
    let refreshSignal: AbortSignal | null = null;
    const { runtime, state, events } = makeLifecycleHarness({
      loadExtensions: async () => emptyExtensions(),
      initializeModels: async () => undefined,
      refreshModels: (signal) => {
        refreshSignal = signal;
        return refresh.promise;
      },
    });

    runtime.start();
    await state.initializationPromise;
    await vi.waitFor(() => expect(refreshSignal).not.toBeNull());
    expect(state.isInitialized).toBe(true);
    expect(events).toContain("watchers-started");

    const stopped = runtime.stop();
    expect(refreshSignal?.aborted).toBe(true);
    expect(events).toContain("watchers-stopped");
    expect(events).not.toContain("convex-disposed");

    refresh.resolve();
    await stopped;

    expect(events.indexOf("convex-disposed")).toBeGreaterThan(
      events.indexOf("watchers-stopped"),
    );
    expect(state.isInitialized).toBe(false);
  });

  it("keeps initialization failure watcher-free and memoizes repeated stop", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failure = new Error("model initialization failed");
    const { runtime, state, events } = makeLifecycleHarness({
      loadExtensions: async () => emptyExtensions(),
      initializeModels: async () => {
        throw failure;
      },
    });

    runtime.start();
    await expect(state.initializationPromise).rejects.toBe(failure);
    expect(state.isInitialized).toBe(false);
    expect(events).not.toContain("watchers-started");

    const firstStop = runtime.stop();
    const secondStop = runtime.stop();
    expect(secondStop).toBe(firstStop);
    await Promise.all([firstStop, secondStop]);

    expect(events.filter((event) => event === "convex-disposed")).toHaveLength(
      1,
    );
    expect(events.filter((event) => event === "tool-host-stop")).toHaveLength(
      1,
    );
    expect(events.filter((event) => event === "watchers-stopped")).toHaveLength(
      1,
    );
  });

  it("does not admit initialization after the runner was already stopped", async () => {
    const initializeModels = vi.fn(async () => undefined);
    const { runtime, state, events } = makeLifecycleHarness({
      initializeModels,
    });

    const firstStop = runtime.stop();
    const secondStop = runtime.stop();
    await Promise.all([firstStop, secondStop]);
    runtime.start();
    await Promise.resolve();

    expect(initializeModels).not.toHaveBeenCalled();
    expect(state.isRunning).toBe(false);
    expect(state.initializationPromise).toBeNull();
    expect(events).not.toContain("watchers-started");
  });
});
