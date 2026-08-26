import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime } from "effect";
import { METHOD_NAMES } from "@stella/contracts/protocol";
import * as HostBus from "../worker/server/host-bus.js";
import * as ModelCatalog from "../worker/server/model-catalog.js";
import * as WorkerSessions from "../worker/server/sessions.js";
import type { WorkerInitializationState } from "../worker/server/types.js";

/**
 * Direct Effect-runtime interruption/timeout tests for the worker session
 * graph. These live inside packages/runtime because `effect` is fenced
 * there — desktop-ui tests may exercise the worker over JSON-RPC but may
 * not import Effect APIs (enforced by check-boundary.mjs).
 *
 * - `Effect.timeout` on a hung initialize fails with `Cause.TimeoutError`,
 *   interrupts the fiber, releases the session lock, publishes nothing;
 * - interrupting an initialize fiber mid-layer-build closes the
 *   partially-built scope, releasing the resources acquired so far
 *   (`Effect.onExit`, which — unlike `onError` — also runs on interrupts).
 */

const harness = vi.hoisted(() => {
  const state = {
    order: [] as string[],
    runnersStopped: 0,
  };
  const makeRunner = () => ({
    setConvexUrl: () => undefined,
    setConvexSiteUrl: () => undefined,
    setAuthToken: () => undefined,
    setHasConnectedAccount: () => undefined,
    setModelCatalogUpdatedAt: () => undefined,
    start: () => undefined,
    stop: async () => {
      state.runnersStopped += 1;
      state.order.push("runner.stop");
    },
    waitUntilInitialized: async () => undefined,
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

vi.mock("../kernel/runner.js", () => ({
  createStellaHostRunner: () => harness.makeRunner(),
}));

vi.mock("../worker/cli-bridge-server.js", () => ({
  startCliBridgeServer: async () => ({
    stop: async () => {
      harness.state.order.push("bridge.stop");
    },
  }),
}));

vi.mock("../worker/runtime-paths.js", () => ({
  resolveRuntimePaths: (stellaAppDir: string) => ({ stellaAppDir }),
  createSecureCliBridgeEndpoint: () => "/tmp/stella-test-bridge.sock",
}));

vi.mock("../kernel/connectors/process-registry.js", () => ({
  sweepStaleConnectorBridgeProcesses: async () => null,
}));

vi.mock("../ai/model-runtime.js", () => ({
  modelRuntime: {
    onCatalogChanged: () => () => undefined,
    getSnapshotForListing: async () => ({ models: [] }),
  },
}));

vi.mock("../kernel/storage/database.js", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { getDesktopDatabasePath, initializeDesktopDatabase } =
    await import("../kernel/storage/database-init.js");
  return {
    createDesktopDatabase: (stellaDataDir: string) => {
      const db = new DatabaseSync(getDesktopDatabasePath(stellaDataDir), {
        timeout: 5000,
      });
      initializeDesktopDatabase(
        db as unknown as Parameters<typeof initializeDesktopDatabase>[0],
      );
      const close = db.close.bind(db);
      db.close = () => {
        harness.state.order.push("db.close");
        close();
      };
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
    modelCatalogUpdatedAt: null,
    localLlmCredentialsUpdatedAt: null,
  }) as unknown as WorkerInitializationState;

type FakePeerBehavior = {
  deviceIdentity: () => Promise<unknown>;
  llmCredentials: () => Promise<unknown>;
};

const makePeer = (behavior: FakePeerBehavior) =>
  ({
    notify: () => undefined,
    request: (method: string) => {
      if (method === METHOD_NAMES.HOST_DEVICE_IDENTITY_GET) {
        return behavior.deviceIdentity();
      }
      if (method === METHOD_NAMES.HOST_LLM_CREDENTIALS_REQUEST) {
        return behavior.llmCredentials();
      }
      return Promise.resolve({});
    },
    registerRequestHandler: () => undefined,
    registerNotificationHandler: () => undefined,
  }) as never;

const makeSessionsRuntime = (behavior: FakePeerBehavior) =>
  ManagedRuntime.make(
    WorkerSessions.layer.pipe(
      Layer.provideMerge(ModelCatalog.layer),
      Layer.provideMerge(HostBus.layer(makePeer(behavior))),
    ),
  );

describe("worker session interruption/timeout (Effect runtime)", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "stella-effect-runtime-"));
    harness.state.order.length = 0;
    harness.state.runnersStopped = 0;
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("Effect.timeout interrupts a hung initialize, releasing the lock and publishing nothing", async () => {
    // Device-identity hop hangs on the first call, resolves afterwards.
    let identityCalls = 0;
    const runtime = makeSessionsRuntime({
      deviceIdentity: () => {
        identityCalls += 1;
        return identityCalls === 1
          ? new Promise(() => undefined)
          : Promise.resolve({ deviceId: "device-test" });
      },
      llmCredentials: () =>
        Promise.resolve({ ok: true, apiKeyProviders: [], oauthProviders: [] }),
    });
    const sessions = await runtime.runPromise(WorkerSessions.Service);
    const init = initParams(path.join(tempRoot, "data-a"), tempRoot);

    const exit = await runtime.runPromiseExit(
      Effect.timeout(sessions.initialize(init), "150 millis"),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;
    expect(Cause.isTimeoutError(failure)).toBe(true);

    // The interrupted initialize published nothing and released the
    // session lock: a retry (identity now resolves) succeeds.
    expect(sessions.current()).toBeNull();
    const result = await runtime.runPromise(sessions.initialize(init));
    expect(result.deviceId).toBe("device-test");
    expect(sessions.current()).not.toBeNull();

    // Shutdown tears the retried session down in stopWorkerServices order.
    await runtime.runPromise(sessions.shutdown());
    expect(harness.state.order).toEqual([
      "runner.stop",
      "bridge.stop",
      "db.close",
    ]);
    await runtime.dispose();
  });

  it("interrupting initialize mid-layer-build releases the resources acquired so far", async () => {
    // The credential-broker layer builds AFTER storage (db already open);
    // hang its host hop so the interrupt lands mid-build.
    let credentialCalls = 0;
    let credentialRequested!: () => void;
    const credentialRequestSeen = new Promise<void>((resolve) => {
      credentialRequested = resolve;
    });
    const runtime = makeSessionsRuntime({
      deviceIdentity: () => Promise.resolve({ deviceId: "device-test" }),
      llmCredentials: () => {
        credentialCalls += 1;
        if (credentialCalls === 1) {
          credentialRequested();
          return new Promise(() => undefined);
        }
        return Promise.resolve({
          ok: true,
          apiKeyProviders: [],
          oauthProviders: [],
        });
      },
    });
    const sessions = await runtime.runPromise(WorkerSessions.Service);
    const init = initParams(path.join(tempRoot, "data-a"), tempRoot);

    const fiber = runtime.runFork(sessions.initialize(init));
    await credentialRequestSeen;
    await runtime.runPromise(Fiber.interrupt(fiber));

    // The partially-built scope was closed: storage (built before the hung
    // broker layer) released its database, and no session was published.
    // The cli bridge builds after the broker layer, so it never started.
    expect(harness.state.order).toEqual(["db.close"]);
    expect(sessions.current()).toBeNull();

    // The lock was released — a retry builds a full session.
    const result = await runtime.runPromise(sessions.initialize(init));
    expect(result.deviceId).toBe("device-test");
    expect(sessions.current()).not.toBeNull();
    await runtime.runPromise(sessions.shutdown());
    await runtime.dispose();
  });
});
