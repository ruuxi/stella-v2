import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Exit, Layer, ManagedRuntime } from "effect";
import { METHOD_NAMES } from "@stella/contracts/protocol";
import * as HostBus from "../../worker/server/host-bus.js";
import * as ModelCatalog from "../../worker/server/model-catalog.js";
import * as RunnerModule from "../../worker/server/runner-module.js";
import * as WorkerSessions from "../../worker/server/sessions.js";
import type { WorkerInitializationState } from "../../worker/server/types.js";

/**
 * Worker boot timing: one initialize that builds a session reports exactly
 * one `worker.ready.timing` event with the per-step breakdown, and the
 * session's runner is constructed only after initialize has returned (so
 * runner construction/start never delays the initialize response).
 */

const harness = vi.hoisted(() => {
  const state = {
    order: [] as string[],
    initialized: null as null | (() => void),
    failUserApps: false,
  };
  const makeRunner = () => ({
    setConvexUrl: () => undefined,
    setConvexSiteUrl: () => undefined,
    setAuthToken: () => undefined,
    setHasConnectedAccount: () => undefined,
    setCloudSyncEnabled: () => undefined,
    setModelCatalogUpdatedAt: () => undefined,
    start: () => {
      state.order.push("runner.start");
    },
    stop: async () => {
      state.order.push("runner.stop");
    },
    waitUntilInitialized: () =>
      new Promise<void>((resolve) => {
        state.initialized = resolve;
      }),
    agentHealthCheck: () => ({ ready: true }),
    getActiveOrchestratorRun: () => null,
    listActiveAgentRuns: () => [],
    getActiveAgentCount: () => 0,
    warmModelCatalog: async () => undefined,
    cancelLocalChat: () => undefined,
    cancelLocalChatByConversation: () => false,
  });
  return { state, makeRunner };
});

vi.mock("../../kernel/runner.js", () => ({
  createStellaHostRunner: () => {
    harness.state.order.push("runner.construct");
    return harness.makeRunner();
  },
}));

vi.mock("../../worker/cli-bridge-server.js", () => ({
  startCliBridgeServer: async () => ({ stop: async () => undefined }),
}));

vi.mock("../../worker/runtime-paths.js", () => ({
  resolveRuntimePaths: (stellaAppDir: string) => ({ stellaAppDir }),
  createSecureCliBridgeEndpoint: () => "/tmp/stella-test-boot-bridge.sock",
}));

// UserApps builds LAST in the session chain (after RunnerHandle), so failing
// its start exercises a build failure after the runner build was scheduled.
vi.mock("../../worker/user-apps/project-service.js", () => ({
  UserAppProjectService: class {
    async start() {
      if (harness.state.failUserApps) throw new Error("apps root unavailable");
    }
    async shutdown() {}
    hasActiveWork() {
      return false;
    }
  },
}));

vi.mock("../../kernel/connectors/process-registry.js", () => ({
  sweepStaleConnectorBridgeProcesses: async () => null,
}));

vi.mock("../../ai/model-runtime.js", () => ({
  modelRuntime: {
    onCatalogChanged: () => () => undefined,
    getSnapshotForListing: async () => ({ models: [] }),
  },
}));

vi.mock("../../kernel/storage/database.js", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { getDesktopDatabasePath, initializeDesktopDatabase } = await import(
    "../../kernel/storage/database-init.js"
  );
  return {
    createDesktopDatabase: (
      stellaDataDir: string,
      options?: { onTiming?: (timing: unknown) => void },
    ) => {
      const db = new DatabaseSync(getDesktopDatabasePath(stellaDataDir), {
        timeout: 5000,
      });
      const init = initializeDesktopDatabase(
        db as unknown as Parameters<typeof initializeDesktopDatabase>[0],
      );
      options?.onTiming?.({ ...init, openMs: 0 });
      return db;
    },
  };
});

const initParams = (dataDir: string, appDir: string) =>
  ({
    protocolVersion: undefined,
    stellaAppDir: appDir,
    stellaDataDirPath: dataDir,
    stellaWorkspacePath: path.join(dataDir, "workspace"),
    authToken: null,
    convexUrl: null,
    convexSiteUrl: null,
    hasConnectedAccount: false,
    cloudSyncEnabled: false,
    modelCatalogUpdatedAt: null,
    localLlmCredentialsUpdatedAt: null,
  }) as unknown as WorkerInitializationState;

const makeRuntime = (llmCredentials: () => Promise<unknown>) =>
  ManagedRuntime.make(
    WorkerSessions.layer.pipe(
      Layer.provideMerge(ModelCatalog.layer),
      Layer.provideMerge(RunnerModule.layer),
      Layer.provideMerge(
        HostBus.layer({
          notify: () => undefined,
          request: (method: string) => {
            if (method === METHOD_NAMES.HOST_DEVICE_IDENTITY_GET) {
              return Promise.resolve({ deviceId: "device-test" });
            }
            if (method === METHOD_NAMES.HOST_LLM_CREDENTIALS_REQUEST) {
              return llmCredentials();
            }
            return Promise.resolve({});
          },
          registerRequestHandler: () => undefined,
          registerNotificationHandler: () => undefined,
        } as never),
      ),
    ),
  );

const TIMING_PREFIX = "[stella:boot] worker.ready.timing ";

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("worker boot timing", () => {
  let tempRoot: string;
  let reports: Record<string, unknown>[];

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "stella-boot-timing-"));
    harness.state.order.length = 0;
    harness.state.initialized = null;
    harness.state.failUserApps = false;
    reports = [];
    // No file logger in tests: the event goes to stderr as one JSON line.
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const line = String(args[0] ?? "");
      if (line.startsWith(TIMING_PREFIX)) {
        reports.push(JSON.parse(line.slice(TIMING_PREFIX.length)));
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("reports one per-step event at runner ready, after a runner built post-initialize", async () => {
    const runtime = makeRuntime(() =>
      Promise.resolve({ ok: true, apiKeyProviders: [], oauthProviders: [] }),
    );
    const sessions = await runtime.runPromise(WorkerSessions.Service);
    const result = await runtime.runPromise(
      sessions.initialize(initParams(path.join(tempRoot, "data"), tempRoot)),
    );
    expect(result.deviceId).toBe("device-test");
    // Initialize returned before the runner was constructed or started.
    expect(harness.state.order).toEqual([]);

    await waitFor(() => harness.state.initialized !== null);
    expect(harness.state.order).toEqual(["runner.construct", "runner.start"]);
    expect(reports).toHaveLength(0); // not ready yet
    harness.state.initialized!();
    await waitFor(() => reports.length > 0);

    expect(reports).toHaveLength(1);
    const timing = reports[0]!;
    expect(timing.outcome).toBe("success");
    for (const key of [
      "totalMs",
      "uptimeAtInitializeMs",
      "maxEventLoopStallMs",
      "sessionLockWaitMs",
      "deviceIdentityMs",
      "dbOpenMs",
      "dbMigrateMs",
      "layerStorageMs",
      "layerBrokersMs",
      "layerCliBridgeMs",
      "layerRunnerHandleMs",
      "layerUserAppsMs",
      "sessionBuildMs",
      "runnerConstructMs",
      "initializedAtMs",
      "readyAfterInitializeMs",
    ]) {
      expect(typeof timing[key], key).toBe("number");
    }
    // A fresh data dir migrates from version 0.
    expect(timing.dbFromVersion).toBe(0);
    expect(timing.dbMigrated).toBe(true);
    expect(timing.totalMs as number).toBeGreaterThanOrEqual(
      timing.initializedAtMs as number,
    );

    // Re-initializing the same live session is not a boot: no new report.
    await runtime.runPromise(
      sessions.initialize(initParams(path.join(tempRoot, "data"), tempRoot)),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reports).toHaveLength(1);

    await runtime.runPromise(sessions.shutdown());
    expect(harness.state.order).toContain("runner.stop");
    await runtime.dispose();
  });

  it("a session build failing after RunnerHandle never constructs a runner and reports the failed step", async () => {
    harness.state.failUserApps = true;
    const runtime = makeRuntime(() =>
      Promise.resolve({ ok: true, apiKeyProviders: [], oauthProviders: [] }),
    );
    const sessions = await runtime.runPromise(WorkerSessions.Service);
    const exit = await runtime.runPromiseExit(
      sessions.initialize(initParams(path.join(tempRoot, "data"), tempRoot)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // RunnerHandle was built (its finalizer ran on the failed scope) but the
    // gated build never constructed or started a runner.
    expect(harness.state.order).not.toContain("runner.construct");
    expect(harness.state.order).not.toContain("runner.start");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      outcome: "failure",
      failedStep: "sessionBuild",
    });
    await runtime.dispose();
  });
});
