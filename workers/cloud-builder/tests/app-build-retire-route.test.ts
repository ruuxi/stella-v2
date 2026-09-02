import { describe, expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
mock.module("@cloudflare/sandbox", () => ({
  getSandbox: () => ({}),
  Sandbox: class {},
  ContainerProxy: class {},
}));
const worker = (await import("../src/index.js")).default;
mock.restore();

const SECRET = "retire-route-secret";
const OWNER_ID = "https://deployment.convex.site|owner-1";
// sha256 of OWNER_ID, as the worker derives it for build prefixes.
const ownerHash = async (): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(OWNER_ID),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const methods = (...names: string[]): Record<string, () => undefined> =>
  Object.fromEntries(names.map((name) => [name, () => undefined]));

const fakeBucket = (keys: string[]) => {
  const deleted: string[] = [];
  return {
    deleted,
    bucket: {
      list: async ({ prefix }: { prefix: string }) => ({
        objects: keys
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      }),
      delete: async (batch: string[]) => {
        deleted.push(...batch);
      },
      get: () => undefined,
      put: () => undefined,
    },
  };
};

const environment = (appBuilds: unknown) => ({
  Sandbox: methods("getByName"),
  APP_BUILD_SANDBOX: methods("getByName"),
  BUILD_SESSIONS: methods("getByName"),
  ORCHESTRATOR_SESSIONS: methods("getByName"),
  OWNER_TRANSFER_COORDINATORS: methods("getByName"),
  OWNER_GATES: methods("getByName"),
  TURN_OUTBOX: methods("send", "sendBatch"),
  BROWSER_GATEWAY: methods("fetch"),
  APP_BUILDS: appBuilds,
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
  env: unknown,
  body: unknown,
  secret: string | null = SECRET,
): Promise<Response> =>
  worker.fetch(
    new Request("https://builder.example/internal/apps/builds/retire", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify(body),
    }),
    env as never,
  );

describe("POST /internal/apps/builds/retire", () => {
  test("deletes exactly the owner's superseded build prefix", async () => {
    const hash = await ownerHash();
    const prefix = `builds/${hash}/build-old`;
    const { bucket, deleted } = fakeBucket([
      `${prefix}/index.html`,
      `${prefix}/assets/app.js`,
      `builds/${hash}/build-new/index.html`,
    ]);
    const response = await retire(environment(bucket), {
      ownerId: OWNER_ID,
      artifactPrefix: prefix,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, deleted: 2, done: true });
    expect(deleted).toEqual([`${prefix}/index.html`, `${prefix}/assets/app.js`]);
  });

  test("refuses a prefix that belongs to another owner", async () => {
    const { bucket, deleted } = fakeBucket([]);
    const response = await retire(environment(bucket), {
      ownerId: OWNER_ID,
      artifactPrefix: `builds/${"0".repeat(64)}/build-1`,
    });
    expect(response.status).toBe(403);
    expect(deleted).toEqual([]);
  });

  test("requires the builder service secret", async () => {
    const { bucket, deleted } = fakeBucket([`builds/x/y/index.html`]);
    const response = await retire(
      environment(bucket),
      { ownerId: OWNER_ID, artifactPrefix: "builds/x/y" },
      null,
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(deleted).toEqual([]);
  });
});
