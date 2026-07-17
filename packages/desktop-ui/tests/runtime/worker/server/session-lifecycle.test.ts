import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonRpcPeer } from "@stella/contracts/protocol/rpc-peer";
import {
  METHOD_NAMES,
  NOTIFICATION_NAMES,
  STELLA_RUNTIME_PROTOCOL_VERSION,
} from "@stella/contracts/protocol";
import { WorkerPeerBroker } from "@stella/runtime/worker/peer-broker";

/**
 * Session lifecycle over the Effect layer graph: initialize builds the
 * scoped session, same-root re-init is a config patch, different-root
 * re-init closes the old scope in the EXACT stopWorkerServices order
 * (runner stop → runEventLog.stop → cli-bridge stop → brokers cleared →
 * db.close; a background-built runner is stopped even if nothing ever
 * accessed it — the supersede guarantee), and shutdown is idempotent.
 *
 * Storage runs on node:sqlite (the kernel storage tests' seam) so this
 * suite is green under the repository's node-hosted `bun run test:run`.
 */

const harness = vi.hoisted(() => {
  type FakeRunner = {
    id: number;
    stopped: boolean;
    started: boolean;
    config: Record<string, unknown>;
    activeRun: { runId: string; conversationId: string } | null;
  };
  const state = {
    order: [] as string[],
    runners: [] as FakeRunner[],
    ready: true,
  };
  const makeRunner = () => {
    const runner: FakeRunner = {
      id: state.runners.length + 1,
      stopped: false,
      started: false,
      config: {},
      activeRun: null,
    };
    state.runners.push(runner);
    const api = {
      setConvexUrl: (v: unknown) => (runner.config.convexUrl = v),
      setConvexSiteUrl: (v: unknown) => (runner.config.convexSiteUrl = v),
      setAuthToken: (v: unknown) => (runner.config.authToken = v),
      setHasConnectedAccount: (v: unknown) =>
        (runner.config.hasConnectedAccount = v),
      setCloudSyncEnabled: (v: unknown) => (runner.config.cloudSyncEnabled = v),
      setModelCatalogUpdatedAt: (v: unknown) =>
        (runner.config.modelCatalogUpdatedAt = v),
      start: () => {
        runner.started = true;
      },
      stop: async () => {
        runner.stopped = true;
        state.order.push(`runner${runner.id}.stop`);
      },
      waitUntilInitialized: async () => undefined,
      agentHealthCheck: () => ({ ready: state.ready }),
      getActiveOrchestratorRun: () => runner.activeRun,
      listActiveAgentRuns: () => [] as Array<{
        runId: string;
        conversationId: string;
      }>,
      getActiveAgentCount: () => 0,
      warmModelCatalog: async () => undefined,
      cancelLocalChat: () => undefined,
      cancelLocalChatByConversation: () => false,
    };
    return api;
  };
  return { state, makeRunner };
});

vi.mock("@stella/runtime/kernel/runner", () => ({
  createStellaHostRunner: () => harness.makeRunner(),
}));

vi.mock("@stella/runtime/worker/cli-bridge-server", () => ({
  startCliBridgeServer: async () => ({
    stop: async () => {
      harness.state.order.push("bridge.stop");
    },
  }),
}));

vi.mock("@stella/runtime/worker/runtime-paths", () => ({
  resolveRuntimePaths: (stellaAppDir: string) => ({ stellaAppDir }),
  createSecureCliBridgeEndpoint: () => "/tmp/stella-test-bridge.sock",
}));

vi.mock("@stella/runtime/kernel/connectors/process-registry", () => ({
  sweepStaleConnectorBridgeProcesses: async () => null,
}));

vi.mock("@stella/runtime/ai/model-runtime", () => ({
  modelRuntime: {
    onCatalogChanged: () => () => undefined,
    getSnapshotForListing: async () => ({ models: [] }),
  },
}));

// node:sqlite instead of bun:sqlite (the kernel storage tests' seam) so the
// suite runs under node-hosted vitest; close() is recorded for the teardown
// order assertions.
vi.mock("@stella/runtime/kernel/storage/database", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { getDesktopDatabasePath, initializeDesktopDatabase } = await import(
    "@stella/runtime/kernel/storage/database-init"
  );
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

vi.mock("@stella/runtime/kernel/storage/run-event-log", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@stella/runtime/kernel/storage/run-event-log")
    >();
  class RecordedRunEventLog extends original.RunEventLog {
    override stop() {
      harness.state.order.push("runEventLog.stop");
      super.stop();
    }
  }
  return { ...original, RunEventLog: RecordedRunEventLog };
});

vi.mock("@stella/runtime/kernel/connectors/oauth", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@stella/runtime/kernel/connectors/oauth")
    >();
  return {
    ...original,
    setConnectorTokenStoreBroker: (
      broker: Parameters<typeof original.setConnectorTokenStoreBroker>[0],
    ) => {
      if (broker === null) {
        harness.state.order.push("brokers.clear");
      }
      original.setConnectorTokenStoreBroker(broker);
    },
  };
});

const createHarness = async () => {
  const { createRuntimeWorkerServer } = await import(
    "@stella/runtime/worker/server/index"
  );
  const broker = new WorkerPeerBroker();
  const server = createRuntimeWorkerServer(broker);
  const host: JsonRpcPeer = new JsonRpcPeer((message) => {
    queueMicrotask(() => worker.handleMessage(message));
  });
  const worker: JsonRpcPeer = new JsonRpcPeer((message) => {
    queueMicrotask(() => host.handleMessage(message));
  });
  host.registerRequestHandler(METHOD_NAMES.HOST_DEVICE_IDENTITY_GET, () => ({
    deviceId: "device-test",
  }));
  host.registerRequestHandler(
    METHOD_NAMES.HOST_LLM_CREDENTIALS_REQUEST,
    () => ({ ok: true, apiKeyProviders: [], oauthProviders: [] }),
  );
  const localChatNotifications: unknown[] = [];
  host.registerNotificationHandler(
    NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED,
    (params) => {
      localChatNotifications.push(params);
    },
  );
  broker.attach(worker);
  return { broker, server, host, localChatNotifications };
};

const initParams = (dataDir: string, appDir: string) => ({
  protocolVersion: STELLA_RUNTIME_PROTOCOL_VERSION,
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
});

describe("worker session lifecycle (Effect scope)", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "stella-effect-session-"));
    harness.state.order.length = 0;
    harness.state.runners.length = 0;
    harness.state.ready = true;
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("initializes, serves storage, patches config in place on same-root re-init", async () => {
    const { host, server, localChatNotifications } = await createHarness();
    const dataDir = path.join(tempRoot, "data-a");
    const appDir = path.join(tempRoot, "app");

    const result = (await host.request(
      METHOD_NAMES.INTERNAL_WORKER_INITIALIZE,
      initParams(dataDir, appDir),
    )) as Record<string, unknown>;
    expect(result.protocolVersion).toBe(STELLA_RUNTIME_PROTOCOL_VERSION);
    expect(result.deviceId).toBe("device-test");

    // Storage is live: append + list a local chat event, notification fans out.
    const conversationId = (await host.request(
      METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_GET_OR_CREATE_DEFAULT,
    )) as string;
    expect(conversationId).toBeTruthy();
    await host.request(METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_APPEND_EVENT, {
      conversationId,
      type: "user_message",
      payload: { type: "user_message", payload: { text: "hello" } },
    });
    const events = (await host.request(
      METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_LIST_EVENTS,
      { conversationId },
    )) as unknown[];
    expect(events.length).toBeGreaterThan(0);
    expect(localChatNotifications.length).toBeGreaterThan(0);

    // Wait for the background runner build.
    await vi.waitFor(() => {
      expect(harness.state.runners).toHaveLength(1);
      expect(harness.state.runners[0]!.started).toBe(true);
    });

    // Health now reflects the built runner.
    const health = (await host.request(
      METHOD_NAMES.INTERNAL_WORKER_HEALTH,
    )) as { health: { ready: boolean }; deviceId: string };
    expect(health.health.ready).toBe(true);
    expect(health.deviceId).toBe("device-test");

    // CONFIGURE fans out to the live runner.
    await host.request(METHOD_NAMES.INTERNAL_WORKER_CONFIGURE, {
      authToken: "tok-1",
    });
    expect(harness.state.runners[0]!.config.authToken).toBe("tok-1");

    // Same-root re-init with a built runner: config patch, no teardown.
    const again = (await host.request(
      METHOD_NAMES.INTERNAL_WORKER_INITIALIZE,
      { ...initParams(dataDir, appDir), authToken: "tok-2" },
    )) as Record<string, unknown>;
    expect(again.deviceId).toBe("device-test");
    expect(harness.state.runners).toHaveLength(1);
    expect(harness.state.runners[0]!.stopped).toBe(false);
    expect(harness.state.runners[0]!.config.authToken).toBe("tok-2");
    expect(harness.state.order).toEqual([]);

    await server.shutdown();
  });

  it("re-init with a new root tears the session down in stopWorkerServices order", async () => {
    const { host, server } = await createHarness();
    const appDir = path.join(tempRoot, "app");

    await host.request(
      METHOD_NAMES.INTERNAL_WORKER_INITIALIZE,
      initParams(path.join(tempRoot, "data-a"), appDir),
    );
    await vi.waitFor(() => {
      expect(harness.state.runners).toHaveLength(1);
    });

    // Different data dir ⇒ full re-init. The first session's scope closes
    // in the EXACT old stopWorkerServices order: runner stop (supersede
    // guarantee for the background build) → runEventLog.stop → cli bridge
    // stop → credential brokers cleared → db.close.
    await host.request(
      METHOD_NAMES.INTERNAL_WORKER_INITIALIZE,
      initParams(path.join(tempRoot, "data-b"), appDir),
    );
    expect(harness.state.order).toEqual([
      "runner1.stop",
      "runEventLog.stop",
      "bridge.stop",
      "brokers.clear",
      "db.close",
    ]);
    expect(harness.state.runners[0]!.stopped).toBe(true);

    // The new session is fully functional.
    const conversationId = (await host.request(
      METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_GET_OR_CREATE_DEFAULT,
    )) as string;
    expect(conversationId).toBeTruthy();
    await vi.waitFor(() => {
      expect(harness.state.runners).toHaveLength(2);
    });

    // Shutdown closes the second session the same way, and is idempotent.
    await server.shutdown();
    expect(harness.state.order).toEqual([
      "runner1.stop",
      "runEventLog.stop",
      "bridge.stop",
      "brokers.clear",
      "db.close",
      "runner2.stop",
      "runEventLog.stop",
      "bridge.stop",
      "brokers.clear",
      "db.close",
    ]);
    await server.shutdown();
    expect(harness.state.order).toHaveLength(10);

    // Post-shutdown, session-guarded methods fail with the parity error.
    await expect(
      host.request(METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_LIST_EVENTS, {
        conversationId,
      }),
    ).rejects.toMatchObject({ message: "Chat store is not available." });
  });

  it("hasActiveWork reflects runner activity", async () => {
    const { host, server } = await createHarness();
    await host.request(
      METHOD_NAMES.INTERNAL_WORKER_INITIALIZE,
      initParams(path.join(tempRoot, "data-a"), path.join(tempRoot, "app")),
    );
    await vi.waitFor(() => {
      expect(harness.state.runners).toHaveLength(1);
    });
    expect(server.hasActiveWork()).toBe(false);
    harness.state.runners[0]!.activeRun = {
      runId: "r1",
      conversationId: "c1",
    };
    expect(server.hasActiveWork()).toBe(true);
    harness.state.runners[0]!.activeRun = null;
    expect(server.hasActiveWork()).toBe(false);
    await server.shutdown();
  });
});
