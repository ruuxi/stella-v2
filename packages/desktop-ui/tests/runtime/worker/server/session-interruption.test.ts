import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JsonRpcPeer } from "@stella/contracts/protocol/rpc-peer";
import {
  METHOD_NAMES,
  NOTIFICATION_NAMES,
  STELLA_RUNTIME_PROTOCOL_VERSION,
} from "@stella/contracts/protocol";

/**
 * Overlapping INITIALIZE requests are serialized: the losing session is
 * fully torn down in stopWorkerServices order — never leaked — even while
 * its lazy runner build is IN FLIGHT. This is the concurrency regression
 * the old `state.db !== db` guard only protected sequentially.
 *
 * The runner-module import is gated by a manual promise, which a vi.mock
 * factory can only await once per module registry, so this file holds
 * exactly ONE gated test (its sibling in-flight supersede test lives in
 * session-supersede.test.ts). The direct Effect-API interruption/timeout
 * tests live inside the fence at
 * packages/runtime/tests/worker-server-interruption.effect.test.ts —
 * desktop-ui tests must stay Effect-free (see check-boundary fixtures).
 */

const harness = vi.hoisted(() => {
  type FakeRunner = { id: number; stopped: boolean; started: boolean };
  const state = {
    order: [] as string[],
    runners: [] as FakeRunner[],
    runnerImportGate: null as Promise<void> | null,
  };
  const makeRunner = () => {
    const runner: FakeRunner = {
      id: state.runners.length + 1,
      stopped: false,
      started: false,
    };
    state.runners.push(runner);
    return {
      setConvexUrl: () => undefined,
      setConvexSiteUrl: () => undefined,
      setAuthToken: () => undefined,
      setHasConnectedAccount: () => undefined,
      setCloudSyncEnabled: () => undefined,
      setModelCatalogUpdatedAt: () => undefined,
      start: () => {
        runner.started = true;
      },
      stop: async () => {
        runner.stopped = true;
        state.order.push(`runner${runner.id}.stop`);
      },
      waitUntilInitialized: async () => undefined,
      agentHealthCheck: () => ({ ready: true }),
      getActiveOrchestratorRun: () => null,
      listActiveAgentRuns: () => [],
      getActiveAgentCount: () => 0,
      warmModelCatalog: async () => undefined,
      cancelLocalChat: () => undefined,
      cancelLocalChatByConversation: () => false,
    };
  };
  return { state, makeRunner };
});

vi.mock("@stella/runtime/kernel/runner", async () => {
  if (harness.state.runnerImportGate) {
    await harness.state.runnerImportGate;
  }
  return { createStellaHostRunner: () => harness.makeRunner() };
});

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

vi.mock(
  "@stella/runtime/kernel/storage/run-event-log",
  async (importOriginal) => {
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
  },
);

const FULL_TEARDOWN = (runnerId: number) => [
  `runner${runnerId}.stop`,
  "runEventLog.stop",
  "bridge.stop",
  "brokers.clear",
  "db.close",
];

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

const createRpcHarness = async () => {
  const { JsonRpcPeer: Peer } = await import(
    "@stella/contracts/protocol/rpc-peer"
  );
  const { WorkerPeerBroker } = await import(
    "@stella/runtime/worker/peer-broker"
  );
  const { createRuntimeWorkerServer } = await import(
    "@stella/runtime/worker/server/index"
  );
  const broker = new WorkerPeerBroker();
  const server = createRuntimeWorkerServer(broker);
  const host: JsonRpcPeer = new Peer((message) => {
    queueMicrotask(() => worker.handleMessage(message));
  });
  const worker: JsonRpcPeer = new Peer((message) => {
    queueMicrotask(() => host.handleMessage(message));
  });
  host.registerRequestHandler(METHOD_NAMES.HOST_DEVICE_IDENTITY_GET, () => ({
    deviceId: "device-test",
  }));
  host.registerRequestHandler(
    METHOD_NAMES.HOST_LLM_CREDENTIALS_REQUEST,
    () => ({ ok: true, apiKeyProviders: [], oauthProviders: [] }),
  );
  host.registerNotificationHandler(
    NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED,
    () => undefined,
  );
  broker.attach(worker);
  return { broker, server, host };
};

describe("worker concurrent INITIALIZE (Effect session lock)", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "stella-effect-concurrent-"));
    harness.state.order.length = 0;
    harness.state.runners.length = 0;
    harness.state.runnerImportGate = null;
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("serializes overlapping INITIALIZE requests and tears the loser down fully", async () => {
    let openGate!: () => void;
    harness.state.runnerImportGate = new Promise((resolve) => {
      openGate = resolve;
    });
    const { host, server } = await createRpcHarness();
    const appDir = path.join(tempRoot, "app");

    // Both requests are dispatched concurrently; the first one's runner
    // build is still in flight (gated import) when the second arrives.
    const first = host.request(
      METHOD_NAMES.INTERNAL_WORKER_INITIALIZE,
      initParams(path.join(tempRoot, "data-a"), appDir),
    );
    const second = host.request(
      METHOD_NAMES.INTERNAL_WORKER_INITIALIZE,
      initParams(path.join(tempRoot, "data-b"), appDir),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    // Nothing torn down yet: the second initialize is blocked behind the
    // session lock + the in-flight build, not racing past it.
    expect(harness.state.order).toEqual([]);
    openGate();
    const [firstResult, secondResult] = (await Promise.all([
      first,
      second,
    ])) as Array<Record<string, unknown>>;
    expect(firstResult.deviceId).toBe("device-test");
    expect(secondResult.deviceId).toBe("device-test");

    // Exactly one losing session, torn down in the exact
    // stopWorkerServices order — its background-built runner included.
    expect(harness.state.order).toEqual(FULL_TEARDOWN(1));
    expect(harness.state.runners[0]!.stopped).toBe(true);

    // The surviving session is fully functional.
    const conversationId = (await host.request(
      METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_GET_OR_CREATE_DEFAULT,
    )) as string;
    expect(conversationId).toBeTruthy();
    await vi.waitFor(() => {
      expect(harness.state.runners).toHaveLength(2);
    });
    expect(harness.state.runners[1]!.stopped).toBe(false);

    await server.shutdown();
    expect(harness.state.order).toEqual([
      ...FULL_TEARDOWN(1),
      ...FULL_TEARDOWN(2),
    ]);
  });
});
