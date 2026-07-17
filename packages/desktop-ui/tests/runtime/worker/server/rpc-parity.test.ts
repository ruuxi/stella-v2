import { describe, expect, it, vi } from "vitest";
import { JsonRpcPeer } from "@stella/contracts/protocol/rpc-peer";
import {
  METHOD_NAMES,
  STELLA_RUNTIME_PROTOCOL_VERSION,
} from "@stella/contracts/protocol";
import { createEmptySocialSessionServiceSnapshot } from "@stella/contracts";
import { WorkerPeerBroker } from "@stella/runtime/worker/peer-broker";
import { createRuntimeWorkerServer } from "@stella/runtime/worker/server/index";

// No test here initializes a session, so storage is never built — the stub
// only keeps the module graph loadable under node-hosted vitest, where the
// real module's `bun:sqlite` import cannot resolve.
vi.mock("@stella/runtime/kernel/storage/database", () => ({
  createDesktopDatabase: () => {
    throw new Error("storage is not exercised by rpc-parity tests");
  },
}));

/**
 * Dispatch parity for the Effect JSON-RPC adapter: every guard failure must
 * serialize the exact error message the pre-Effect worker/server.ts threw,
 * and every tolerant handler must answer its old default when no session
 * exists. Wire-level via a real JsonRpcPeer pair, like the old worker.
 */
const createHarness = () => {
  const broker = new WorkerPeerBroker();
  const server = createRuntimeWorkerServer(broker);
  const host: JsonRpcPeer = new JsonRpcPeer((message) => {
    queueMicrotask(() => worker.handleMessage(message));
  });
  const worker: JsonRpcPeer = new JsonRpcPeer((message) => {
    queueMicrotask(() => host.handleMessage(message));
  });
  broker.attach(worker);
  return { broker, server, host };
};

const expectRpcFailure = async (
  request: Promise<unknown>,
  message: string,
) => {
  await expect(request).rejects.toMatchObject({ message });
};

describe("worker server Effect RPC adapter (pre-init parity)", () => {
  it("fails session-guarded methods with the old error strings", async () => {
    const { host, server } = createHarness();
    await expectRpcFailure(
      host.request(METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_LIST_EVENTS, {
        conversationId: "c",
      }),
      "Chat store is not available.",
    );
    await expectRpcFailure(
      host.request(METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_APPEND_EVENT, {
        conversationId: "c",
        type: "user_message",
      }),
      "Chat store is not available.",
    );
    await expectRpcFailure(
      host.request(METHOD_NAMES.INTERNAL_WORKER_START_CHAT, {
        conversationId: "c",
        userPrompt: "hi",
      }),
      "Chat store is not available.",
    );
    await expectRpcFailure(
      host.request(METHOD_NAMES.INTERNAL_WORKER_VOICE_EXECUTE_TOOL, {}),
      "Voice runtime service is not available.",
    );
    await expectRpcFailure(
      host.request(METHOD_NAMES.INTERNAL_WORKER_LIST_STORE_PACKAGES),
      "Runtime worker is not ready.",
    );
    await expectRpcFailure(
      host.request(METHOD_NAMES.INTERNAL_WORKER_KILL_ALL_SHELLS),
      "Runtime worker is not ready.",
    );
    await expectRpcFailure(
      host.request(METHOD_NAMES.INTERNAL_WORKER_WEB_SEARCH, { query: "q" }),
      "Runtime worker is not ready.",
    );
    await expectRpcFailure(
      host.request(METHOD_NAMES.INTERNAL_WORKER_APPEND_THREAD_MESSAGE, {
        threadKey: "t",
        role: "user",
        content: "x",
      }),
      "Runtime worker is not ready.",
    );
    await expectRpcFailure(
      host.request(METHOD_NAMES.INTERNAL_WORKER_DREAM_TRIGGER_NOW, {}),
      "Runtime worker is not ready.",
    );
    await expectRpcFailure(
      host.request(
        METHOD_NAMES.INTERNAL_WORKER_DISCOVERY_COLLECT_ALL_SIGNALS,
        {},
      ),
      "Worker has not been initialized.",
    );
    await expectRpcFailure(
      host.request(METHOD_NAMES.INTERNAL_WORKER_ONE_SHOT_COMPLETION, {}),
      "Worker has not been initialized.",
    );
    // The social guard fires before roomId validation, as before.
    await expectRpcFailure(
      host.request(METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_CREATE, {}),
      "Social session service is unavailable.",
    );
    await server.shutdown();
  });

  it("validates SEND_AGENT_INPUT params before the runner guard, as before", async () => {
    const { host, server } = createHarness();
    await expectRpcFailure(
      host.request(METHOD_NAMES.INTERNAL_WORKER_SEND_AGENT_INPUT, {}),
      "conversationId is required.",
    );
    await expectRpcFailure(
      host.request(METHOD_NAMES.INTERNAL_WORKER_SEND_AGENT_INPUT, {
        conversationId: "c",
      }),
      "threadId is required.",
    );
    await expectRpcFailure(
      host.request(METHOD_NAMES.INTERNAL_WORKER_SEND_AGENT_INPUT, {
        conversationId: "c",
        threadId: "t",
      }),
      "message is required.",
    );
    // Params valid → the runner guard is next.
    await expectRpcFailure(
      host.request(METHOD_NAMES.INTERNAL_WORKER_SEND_AGENT_INPUT, {
        conversationId: "c",
        threadId: "t",
        message: "m",
      }),
      "Runtime worker is not ready.",
    );
    await server.shutdown();
  });

  it("rejects a protocol version mismatch with the old message", async () => {
    const { host, server } = createHarness();
    await expectRpcFailure(
      host.request(METHOD_NAMES.INTERNAL_WORKER_INITIALIZE, {
        protocolVersion: "does-not-match",
        stellaAppDir: "/tmp/nowhere",
        stellaDataDirPath: "/tmp/nowhere",
        stellaWorkspacePath: "/tmp/nowhere",
      }),
      `Runtime protocol mismatch: host=does-not-match worker=${STELLA_RUNTIME_PROTOCOL_VERSION}.`,
    );
    await server.shutdown();
  });

  it("keeps tolerant handlers answering their old defaults without a session", async () => {
    const { host, server } = createHarness();
    await expect(
      host.request(METHOD_NAMES.INTERNAL_WORKER_CANCEL, { runId: "r" }),
    ).resolves.toEqual({ ok: true });
    await expect(
      host.request(METHOD_NAMES.INTERNAL_WORKER_CANCEL_BY_CONVERSATION, {
        conversationId: "c",
      }),
    ).resolves.toEqual({ ok: true, cancelled: false });
    await expect(
      host.request(METHOD_NAMES.INTERNAL_WORKER_GET_ACTIVE),
    ).resolves.toBeNull();
    await expect(
      host.request(METHOD_NAMES.INTERNAL_WORKER_GET_AGENT_SNAPSHOT, {
        agentId: "a",
      }),
    ).resolves.toBeNull();
    await expect(
      host.request(METHOD_NAMES.INTERNAL_WORKER_RESUME_EVENTS, {
        runId: "r",
        lastSeq: 0,
      }),
    ).resolves.toEqual({ events: [], exhausted: true });
    await expect(
      host.request(METHOD_NAMES.INTERNAL_WORKER_ACK_EVENTS, {
        runId: "r",
        lastSeq: 3,
      }),
    ).resolves.toEqual({ pruned: 0 });
    await expect(
      host.request(METHOD_NAMES.INTERNAL_WORKER_LIST_ACTIVE_RUNS),
    ).resolves.toEqual({ runs: [] });
    await expect(
      host.request(METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_GET_STATUS),
    ).resolves.toEqual(createEmptySocialSessionServiceSnapshot());
    await expect(
      host.request(METHOD_NAMES.INTERNAL_WORKER_CONFIGURE, {
        authToken: "t",
      }),
    ).resolves.toEqual({ ok: true, queued: true });

    const health = (await host.request(
      METHOD_NAMES.INTERNAL_WORKER_HEALTH,
    )) as Record<string, unknown>;
    expect(health.health).toEqual({ ready: false });
    expect(health.pid).toBe(process.pid);
    expect(health.deviceId).toBeNull();
    expect(health.activeAgentCount).toBe(0);

    const runtimeHealth = (await host.request(
      METHOD_NAMES.RUNTIME_HEALTH,
    )) as Record<string, unknown>;
    expect(runtimeHealth.ready).toBe(false);
    expect(runtimeHealth.workerRunning).toBe(true);
    await server.shutdown();
  });

  it("reports no active work without a session and shuts down idempotently", async () => {
    const { server } = createHarness();
    expect(server.hasActiveWork()).toBe(false);
    await server.shutdown();
    await server.shutdown();
    expect(server.hasActiveWork()).toBe(false);
  });
});
