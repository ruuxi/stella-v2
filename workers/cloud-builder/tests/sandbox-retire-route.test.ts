import { describe, expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
mock.module("@cloudflare/sandbox", () => ({
  DirectoryBackup: class {},
  DirectoryBackupGateway: class {},
  Files: class {},
  SandboxBackupError: { is: () => false },
  SandboxFileError: { is: () => false },
}));
const worker = (await import("../src/index.js")).default;
mock.restore();

const SECRET = "retire-route-secret";

const methods = (...names: string[]): Record<string, () => undefined> =>
  Object.fromEntries(names.map((name) => [name, () => undefined]));

const namespace = (name: string) => ({ name, ...methods("getByName") });

const environment = () => ({
  Sandbox: namespace("Sandbox"),
  BUILD_SESSIONS: methods("getByName"),
  ORCHESTRATOR_SESSIONS: methods("getByName"),
  OWNER_GATES: methods("getByName"),
  BROWSER_GATEWAY: methods("fetch"),
  APP_BUILDS: methods("get", "put", "delete", "list"),
  APP_ROUTES: methods("get", "put", "delete", "list"),
  BACKUP_BUCKET: methods("get", "put", "delete", "list"),
  AGENT_HOME: methods("get", "put", "delete", "list"),
  CONVERSATION_ARCHIVE: methods("get", "put", "delete", "list"),
  LOADER: methods("get", "load"),
  BUILDER_SERVICE_SECRET: SECRET,
  TURN_TIMEOUT_MS: "900000",
  SANDBOX_IDLE_TIMEOUT_MS: "600000",
  APPS_HOST_BASE_URL: "https://apps-untrusted.example",
  TRUSTED_APPS_HOST_BASE_URL: "https://apps-auth.example",
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
  test("refuses a tuple it did not mint", async () => {
    for (const body of [
      { sandboxId: "not-a-lifecycle-id", size: "small", workload: "world" },
      { sandboxId: WORLD_ID, size: "medium", workload: "world" },
      // An agent thread's container is a world container, never an app build.
      {
        sandboxId: `agent-${"a".repeat(40)}`,
        size: "small",
        workload: "app-build",
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
  });

  test("requires the service bearer", async () => {
    const response = await retire(
      { sandboxId: WORLD_ID, size: "small", workload: "world" },
      null,
    );
    expect(response.status).toBe(401);
  });
});
