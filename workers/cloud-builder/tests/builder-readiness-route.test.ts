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

const methods = (...names: string[]): Record<string, () => undefined> =>
  Object.fromEntries(names.map((name) => [name, () => undefined]));

const environment = () => ({
  Sandbox: methods("getByName"),
  APP_BUILD_SANDBOX: methods("getByName"),
  BUILD_SESSIONS: methods("getByName"),
  ORCHESTRATOR_SESSIONS: methods("getByName"),
  OWNER_TRANSFER_COORDINATORS: methods("getByName"),
  BROWSER_GATEWAY: methods("fetch"),
  APP_BUILDS: methods("get", "put", "delete", "list"),
  APP_ROUTES: methods("get", "put", "delete", "list"),
  BACKUP_BUCKET: methods("get", "put", "delete", "list"),
  AGENT_HOME: methods("get", "put", "delete", "list"),
  CONVERSATION_ARCHIVE: methods("get", "put", "delete", "list"),
  LOADER: methods("get", "load"),
  BUILDER_SERVICE_SECRET: "readiness-route-secret",
  SANDBOX_TRANSPORT: "rpc",
  TURN_TIMEOUT_MS: "900000",
  SANDBOX_IDLE_TIMEOUT_MS: "600000",
  APPS_HOST_BASE_URL: "https://apps-untrusted.example",
  TRUSTED_APPS_HOST_BASE_URL: "https://apps-auth.example",
  STELLA_CONVEX_SITE_URL: "https://deployment.convex.site",
  STELLA_CONVEX_CLOUD_URL: "https://deployment.convex.cloud",
});

describe("Cloud Builder readiness route", () => {
  test("returns ready without exposing binding or secret values", async () => {
    const response = await worker.fetch(
      new Request("https://builder.example/readyz"),
      environment() as never,
    );
    expect(response.status).toBe(200);
    const serialized = await response.clone().text();
    expect(await response.json()).toEqual({
      ok: true,
      service: "stella-v2-cloud-builder",
      checks: { missing: [], invalid: [] },
    });
    expect(serialized).not.toContain("readiness-route-secret");
  });

  test("fails closed by allowlisted field name while health remains liveness-only", async () => {
    const env = environment();
    env.BUILDER_SERVICE_SECRET = "invalid secret with spaces";
    const readiness = await worker.fetch(
      new Request("https://builder.example/readyz"),
      env as never,
    );
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toEqual({
      ok: false,
      service: "stella-v2-cloud-builder",
      checks: { missing: [], invalid: ["BUILDER_SERVICE_SECRET"] },
    });
    const health = await worker.fetch(
      new Request("https://builder.example/healthz"),
      env as never,
    );
    expect(health.status).toBe(200);
  });
});
