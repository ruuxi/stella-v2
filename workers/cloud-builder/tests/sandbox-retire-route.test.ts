import { describe, expect, mock, test } from "bun:test";

type FakeSandbox = {
  calls: string[];
  setKeepAlive: (enabled: boolean) => Promise<void>;
  destroy: () => Promise<void>;
};

const handles: Array<{
  namespace: string;
  id: string;
  options: Record<string, unknown>;
  sandbox: FakeSandbox;
}> = [];
let nextBehaviour: {
  releaseFails?: boolean;
  destroyFails?: boolean;
} = {};

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
mock.module("@cloudflare/sandbox", () => ({
  getSandbox: (
    namespace: { name: string },
    id: string,
    options: Record<string, unknown>,
  ) => {
    const calls: string[] = [];
    const behaviour = nextBehaviour;
    const sandbox: FakeSandbox = {
      calls,
      setKeepAlive(enabled: boolean) {
        calls.push(`keepAlive:${enabled}:${this === sandbox ? "stub" : "detached"}`);
        if (behaviour.releaseFails) {
          return Promise.reject(new Error("release rpc failed"));
        }
        return Promise.resolve();
      },
      destroy: async () => {
        calls.push("destroy");
        if (behaviour.destroyFails) throw new Error("destroy rpc failed");
      },
    };
    handles.push({ namespace: namespace.name, id, options, sandbox });
    return sandbox;
  },
  Sandbox: class {},
  ContainerProxy: class {},
}));
const worker = (await import("../src/index.js")).default;
mock.restore();

const SECRET = "retire-route-secret";

const methods = (...names: string[]): Record<string, () => undefined> =>
  Object.fromEntries(names.map((name) => [name, () => undefined]));

const namespace = (name: string) => ({ name, ...methods("getByName") });

const environment = () => ({
  Sandbox: namespace("Sandbox"),
  SANDBOX_SMALL: namespace("SANDBOX_SMALL"),
  APP_BUILD_SANDBOX: namespace("APP_BUILD_SANDBOX"),
  BUILD_SESSIONS: methods("getByName"),
  ORCHESTRATOR_SESSIONS: methods("getByName"),
  OWNER_TRANSFER_COORDINATORS: methods("getByName"),
  OWNER_GATES: methods("getByName"),
  TURN_OUTBOX: methods("send", "sendBatch"),
  BROWSER_GATEWAY: methods("fetch"),
  APP_BUILDS: methods("get", "put", "delete", "list"),
  APP_ROUTES: methods("get", "put", "delete", "list"),
  BACKUP_BUCKET: methods("get", "put", "delete", "list"),
  AGENT_HOME: methods("get", "put", "delete", "list"),
  CONVERSATION_ARCHIVE: methods("get", "put", "delete", "list"),
  LOADER: methods("get", "load"),
  BUILDER_SERVICE_SECRET: SECRET,
  SANDBOX_TRANSPORT: "rpc",
  TURN_TIMEOUT_MS: "900000",
  SANDBOX_IDLE_TIMEOUT_MS: "600000",
  APPS_HOST_BASE_URL: "https://apps-untrusted.example",
  TRUSTED_APPS_HOST_BASE_URL: "https://apps-auth.example",
  STELLA_CONVEX_SITE_URL: "https://deployment.convex.site",
  STELLA_CONVEX_CLOUD_URL: "https://deployment.convex.cloud",
  MODEL_GATEWAY: methods("fetch"),
  MODEL_GATEWAY_URL: "https://model-gateway.example",
  CLOUD_BUILDER_PUBLIC_URL: "https://builder.example",
  CAPABILITY_SIGNING_KEY:
    "-----BEGIN PRIVATE KEY-----\nMIGH\n-----END PRIVATE KEY-----\n",
  CAPABILITY_SIGNING_KID: "builder-1",
});

const retire = (
  body: unknown,
  secret: string | null = SECRET,
): Promise<Response> =>
  worker.fetch(
    new Request("https://builder.example/internal/sandboxes/retire", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify(body),
    }),
    environment() as never,
  );

const AGENT_ID = `agent-${"a".repeat(40)}`;

const silenced = async <T>(work: () => Promise<T>): Promise<T> => {
  const previousError = console.error;
  const previousLog = console.log;
  console.error = () => undefined;
  console.log = () => undefined;
  try {
    return await work();
  } finally {
    console.error = previousError;
    console.log = previousLog;
  }
};

describe("POST /internal/sandboxes/retire", () => {
  test("releases keep-alive on the stub, then destroys the exact tuple in its own namespace", async () => {
    handles.length = 0;
    nextBehaviour = {};
    const response = await silenced(() =>
      retire({ sandboxId: AGENT_ID, size: "small", workload: "resident-attachment" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      target: { sandboxId: AGENT_ID, size: "small", workload: "resident-attachment" },
      keepAliveReleased: true,
    });
    expect(handles).toHaveLength(1);
    const [handle] = handles;
    // Size selects the namespace; a retire stub never carries keep-alive on.
    expect(handle!.namespace).toBe("SANDBOX_SMALL");
    expect(handle!.id).toBe(AGENT_ID);
    expect(handle!.options).toMatchObject({
      keepAlive: false,
      sleepAfter: 600_000,
      normalizeId: true,
      transport: "rpc",
    });
    expect(handle!.sandbox.calls).toEqual(["keepAlive:false:stub", "destroy"]);
  });

  test("retries the release after destroy when the first release fails", async () => {
    handles.length = 0;
    nextBehaviour = { releaseFails: true };
    const response = await silenced(() =>
      retire({ sandboxId: AGENT_ID, size: "large", workload: "agent" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      keepAliveReleased: false,
    });
    expect(handles[0]!.namespace).toBe("Sandbox");
    expect(handles[0]!.sandbox.calls).toEqual([
      "keepAlive:false:stub",
      "destroy",
      "keepAlive:false:stub",
    ]);
  });

  test("reports a destroy that did not settle as a 502 with safe diagnostics only", async () => {
    handles.length = 0;
    nextBehaviour = { destroyFails: true };
    const response = await silenced(() =>
      retire({ sandboxId: `app-${"b".repeat(40)}`, size: "large", workload: "app-build" }),
    );
    expect(response.status).toBe(502);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: false,
      reason: "destroy_failed",
      failureCode: "sandbox_rpc_failed",
      errorName: "Error",
    });
    expect(JSON.stringify(body)).not.toContain("destroy rpc failed");
    expect(handles[0]!.namespace).toBe("APP_BUILD_SANDBOX");
  });

  test("refuses a tuple it did not mint", async () => {
    handles.length = 0;
    nextBehaviour = {};
    for (const body of [
      { sandboxId: "not-a-lifecycle-id", size: "small", workload: "agent" },
      { sandboxId: AGENT_ID, size: "medium", workload: "agent" },
      { sandboxId: AGENT_ID, size: "small", workload: "something-else" },
      {},
    ]) {
      const response = await retire(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, reason: "invalid_target" });
    }
    expect(handles).toHaveLength(0);
  });

  test("requires the service bearer", async () => {
    handles.length = 0;
    const response = await retire(
      { sandboxId: AGENT_ID, size: "small", workload: "agent" },
      null,
    );
    expect(response.status).toBe(401);
    expect(handles).toHaveLength(0);
  });
});
