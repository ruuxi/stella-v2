import { describe, expect, mock, test } from "bun:test";

type FakeSandbox = {
  calls: string[];
  destroy: () => Promise<void>;
};

const handles: Array<{
  namespace: string;
  id: string;
  options: Record<string, unknown>;
  sandbox: FakeSandbox;
}> = [];
let nextBehaviour: {
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

const WORLD_ID = `world-${"a".repeat(40)}`;

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
  test("destroys the exact world tuple in its own namespace", async () => {
    handles.length = 0;
    nextBehaviour = {};
    const response = await silenced(() =>
      retire({ sandboxId: WORLD_ID, size: "small", workload: "world" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      target: { sandboxId: WORLD_ID, size: "small", workload: "world" },
    });
    expect(handles).toHaveLength(1);
    const [handle] = handles;
    // Size selects the namespace; a retire stub never carries keep-alive on.
    expect(handle!.namespace).toBe("SANDBOX_SMALL");
    expect(handle!.id).toBe(WORLD_ID);
    expect(handle!.options).toMatchObject({
      keepAlive: false,
      sleepAfter: 600_000,
      normalizeId: true,
      transport: "rpc",
    });
    expect(handle!.sandbox.calls).toEqual(["destroy"]);
  });

  test("reports a destroy that did not settle as a 502 with safe diagnostics only", async () => {
    handles.length = 0;
    nextBehaviour = { destroyFails: true };
    const response = await silenced(() =>
      retire({
        sandboxId: `app-${"b".repeat(40)}`,
        size: "large",
        workload: "app-build",
      }),
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
      { sandboxId: "not-a-lifecycle-id", size: "small", workload: "world" },
      { sandboxId: WORLD_ID, size: "medium", workload: "world" },
      {
        sandboxId: `agent-${"a".repeat(40)}`,
        size: "small",
        workload: "world",
      },
      { sandboxId: WORLD_ID, size: "small", workload: "app-build" },
      { sandboxId: `app-${"a".repeat(40)}`, size: "large", workload: "world" },
      { sandboxId: WORLD_ID, size: "small", workload: "something-else" },
      {},
    ]) {
      const response = await retire(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        ok: false,
        reason: "invalid_target",
      });
    }
    expect(handles).toHaveLength(0);
  });

  test("requires the service bearer", async () => {
    handles.length = 0;
    const response = await retire(
      { sandboxId: WORLD_ID, size: "small", workload: "world" },
      null,
    );
    expect(response.status).toBe(401);
    expect(handles).toHaveLength(0);
  });
});
