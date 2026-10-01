import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  RUNTIME_CLIENT_METHODS,
  type RuntimeClientAttachParams,
} from "@stella/contracts/protocol/runtime-client";
import type { JsonRpcPeer } from "@stella/contracts/protocol/rpc-peer";
import {
  RuntimeClientServer,
  type RuntimeHostHandlers,
} from "./client-server.js";
import {
  buildInprocConnectionFactory,
  createInprocPeerPair,
} from "./inproc-connection.js";

const attachParams = (root = "/tmp/stella-root"): RuntimeClientAttachParams => ({
  initializeParams: {
    clientName: "test",
    clientVersion: "0.0.0",
    platform: process.platform,
    isDev: false,
    stellaAppDir: root,
    stellaDataDirPath: `${root}/data`,
    stellaWorkspacePath: `${root}/workspace`,
  },
});

class FakeHost {
  readonly events = new EventEmitter();
  started = 0;
  stopped = 0;
  stalenessChecks = 0;
  constructor(readonly handlers: RuntimeHostHandlers) {}
  async start() {
    this.started += 1;
    // Starting reads the device identity through the attaching client.
    await this.handlers.getDeviceIdentity();
  }
  async stop() {
    this.stopped += 1;
  }
  async ensureWorkerStarted() {
    return { ok: true };
  }
  async checkRuntimeStaleness() {
    this.stalenessChecks += 1;
  }
  onAny(listener: (name: string, payload: unknown) => void) {
    const emit = this.events.emit.bind(this.events);
    this.events.emit = (name: string | symbol, ...args: unknown[]) => {
      listener(String(name), args[0]);
      return emit(name, ...args);
    };
    return () => undefined;
  }
  async health() {
    return { ready: true, hostPid: 1 };
  }
  async startChat(payload: { conversationId: string }) {
    return { runId: `run:${payload.conversationId}` };
  }
  internalOnly() {
    return "should not be reachable";
  }
}

const setup = (options: { clientWaitMs?: number } = {}) => {
  const hosts: FakeHost[] = [];
  let shutdowns = 0;
  const server = new RuntimeClientServer({
    createHost: (_params, handlers) => {
      const host = new FakeHost(handlers);
      hosts.push(host);
      return host;
    },
    ...(options.clientWaitMs ? { clientWaitMs: options.clientWaitMs } : {}),
    onShutdownRequested: () => {
      shutdowns += 1;
    },
  });
  /** A client: its runtime-side peer goes to the server. */
  const connect = (handlers: Record<string, (...args: any[]) => unknown> = {}) => {
    const pair = createInprocPeerPair();
    server.attach(pair.right);
    const events: Array<{ name: string; payload: unknown }> = [];
    const client: JsonRpcPeer = pair.left;
    client.registerRequestHandler(
      RUNTIME_CLIENT_METHODS.HOST_HANDLER,
      async (params) => {
        const { name, args } = params as { name: string; args: unknown[] };
        const handler = handlers[name];
        if (!handler) throw new Error(`no ${name}`);
        return await handler(...args);
      },
    );
    client.registerNotificationHandler(RUNTIME_CLIENT_METHODS.EVENT, (params) => {
      events.push(params as { name: string; payload: unknown });
    });
    return {
      client,
      runtimePeer: pair.right,
      events,
      close: pair.close,
      attach: (params = attachParams()) =>
        client.request<{ hostCreated: boolean }>(RUNTIME_CLIENT_METHODS.ATTACH, params),
      call: (method: string, ...args: unknown[]) =>
        client.request(RUNTIME_CLIENT_METHODS.CALL, { method, args }),
    };
  };
  return { server, hosts, connect, shutdowns: () => shutdowns };
};

const identity = { getDeviceIdentity: () => ({ deviceId: "device-1" }) };

describe("RuntimeClientServer", () => {
  test("the first attach starts the host; later clients join it", async () => {
    const { hosts, connect } = setup();
    const first = connect(identity);
    expect(await first.attach()).toMatchObject({ hostCreated: true });
    const second = connect(identity);
    expect(await second.attach()).toMatchObject({ hostCreated: false });
    expect(hosts).toHaveLength(1);
    expect(hosts[0]!.started).toBe(1);
    expect(hosts[0]!.stalenessChecks).toBe(1);
  });

  test("the host outlives a client, and the next client picks it up", async () => {
    const { hosts, connect } = setup();
    const first = connect(identity);
    await first.attach();
    first.close();
    const next = connect(identity);
    expect(await next.attach()).toMatchObject({ hostCreated: false });
    expect(await next.call("startChat", { conversationId: "c1" })).toEqual({ runId: "run:c1" });
    expect(hosts[0]!.stopped).toBe(0);
  });

  test("calls are limited to the client surface and need an attach", async () => {
    const { connect } = setup();
    const client = connect(identity);
    await expect(client.call("health")).rejects.toThrow(/Attach before/);
    await client.attach();
    expect(await client.call("health")).toEqual({ ready: true, hostPid: 1 });
    await expect(client.call("internalOnly")).rejects.toThrow(/Unknown runtime call/);
  });

  test("events reach every attached client", async () => {
    const { hosts, connect } = setup();
    const a = connect(identity);
    const b = connect(identity);
    await a.attach();
    await b.attach();
    hosts[0]!.events.emit("run-event", { runId: "r1" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(a.events).toEqual([{ name: "run-event", payload: { runId: "r1" } }]);
    expect(b.events).toEqual([{ name: "run-event", payload: { runId: "r1" } }]);
  });

  test("host callbacks go to the newest client, and wait for one across a restart", async () => {
    const { hosts, connect } = setup({ clientWaitMs: 1_000 });
    const first = connect({ ...identity, getActiveConversationId: () => "from-first" });
    await first.attach();
    const second = connect({ ...identity, getActiveConversationId: () => "from-second" });
    await second.attach();
    expect(await hosts[0]!.handlers.getActiveConversationId()).toBe("from-second");

    first.close();
    second.close();
    const pending = hosts[0]!.handlers.getActiveConversationId();
    const restarted = connect({ ...identity, getActiveConversationId: () => "after-restart" });
    await restarted.attach();
    expect(await pending).toBe("after-restart");
  });

  test("a callback with no app fails after the wait; display-only callbacks settle", async () => {
    const { hosts, connect } = setup({ clientWaitMs: 30 });
    const client = connect(identity);
    await client.attach();
    client.close();
    await expect(hosts[0]!.handlers.requestCredential({})).rejects.toThrow(/not running/);
    expect(await hosts[0]!.handlers.showNotification({ title: "t" })).toBeUndefined();
  });

  test("a client for another Stella root is refused", async () => {
    const { connect } = setup();
    await connect(identity).attach();
    await expect(connect(identity).attach(attachParams("/tmp/other"))).rejects.toThrow(
      /different Stella root/,
    );
  });

  test("shutdown asks the runtime to exit, and close stops the host", async () => {
    const { server, hosts, connect, shutdowns } = setup();
    const client = connect(identity);
    await client.attach();
    await client.client.request(RUNTIME_CLIENT_METHODS.SHUTDOWN, {});
    await new Promise((resolve) => setImmediate(resolve));
    expect(shutdowns()).toBe(1);
    await server.close();
    expect(hosts[0]!.stopped).toBe(1);
    expect(client.runtimePeer.isClosed()).toBe(true);
  });
});

describe("in-process worker connection", () => {
  test("peers exchange copies of each message", async () => {
    const { left, right, close } = createInprocPeerPair();
    const seen: unknown[] = [];
    right.registerRequestHandler("echo", (params) => {
      seen.push(params);
      return params;
    });
    const sent = { nested: { value: 1 } };
    const result = await left.request("echo", sent);
    expect(result).toEqual(sent);
    expect(seen[0]).not.toBe(sent);
    close();
    expect(left.isClosed() && right.isClosed()).toBe(true);
  });

  test("ending the connection detaches the worker peer and reports exit", async () => {
    let detached = 0;
    let workerPeer: JsonRpcPeer | null = null;
    const factory = buildInprocConnectionFactory((peer) => {
      workerPeer = peer;
      return () => {
        detached += 1;
      };
    });
    const connection = await factory("/unused");
    expect(connection.pid).toBe(process.pid);
    const exited = new Promise((resolve) => connection.process.once("exit", resolve));
    connection.process.stdin.end();
    await exited;
    expect(detached).toBe(1);
    expect(connection.process.exitCode).toBe(0);
    expect(workerPeer!.isClosed()).toBe(true);
  });
});
