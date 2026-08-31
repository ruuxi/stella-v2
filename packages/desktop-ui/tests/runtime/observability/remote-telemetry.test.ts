import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isTelemetryBatchV1,
  isTelemetryEventBody,
  type TelemetryEventBody,
} from "@stella/contracts/telemetry/events";
import { RemoteTelemetryClient } from "@stella/runtime/observability/remote-telemetry";
import {
  closeRuntimeTelemetry,
  configureRuntimeTelemetry,
  recordRuntimeTelemetry,
  resolveRuntimeTelemetryPrincipalScope,
  updateRuntimeTelemetryAuth,
} from "@stella/runtime/observability/runtime-telemetry";

const roots: string[] = [];

const makeRoot = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stella-remote-telemetry-"));
  roots.push(root);
  return root;
};

const HASH = "a".repeat(64);
let nextId = 0;
const eventId = () =>
  `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;

const lifecycle = (
  phase: "starting" | "ready" | "stopping" | "stopped" | "crashed" = "ready",
) =>
  ({
    type: "app.lifecycle",
    component: "runtime-worker",
    phase,
  }) satisfies TelemetryEventBody;

const makeClient = async (
  overrides: Partial<
    ConstructorParameters<typeof RemoteTelemetryClient>[0]
  > = {},
) => {
  const root = await makeRoot();
  const spoolPath = path.join(root, "runtime-worker.jsonl");
  const client = new RemoteTelemetryClient({
    spoolPath,
    getContext: () => ({
      environment: "test",
      source: "runtime-worker",
      release: "0.0.0-test",
      installationIdSha256: HASH,
    }),
    getTransportConfig: () => null,
    eventId,
    flushIntervalMs: 60_000,
    ...overrides,
  });
  return { client, spoolPath };
};

afterEach(async () => {
  await closeRuntimeTelemetry();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("metadata-only telemetry contract", () => {
  it("accepts named metadata and rejects arbitrary or content-bearing fields", () => {
    expect(
      isTelemetryEventBody({
        type: "inference.completed",
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4",
        agentType: "orchestrator",
        durationMs: 123,
        success: true,
        inputTokens: 10,
        outputTokens: 5,
        costMicroCents: 42,
      }),
    ).toBe(true);
    expect(
      isTelemetryEventBody({
        ...lifecycle(),
        prompt: "private user content",
      }),
    ).toBe(false);
    expect(
      isTelemetryEventBody({
        type: "app.error",
        component: "desktop-renderer",
        severity: "error",
        message: "private error text",
        stack: "private stack",
      }),
    ).toBe(false);
  });
});

describe("RemoteTelemetryClient", () => {
  it("durably spools and sends a strict authenticated batch", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    let token = "first-token";
    const { client, spoolPath } = await makeClient({
      getTransportConfig: () => ({
        endpoint: "http://127.0.0.1:8787/v1/events",
        authToken: token,
      }),
      allowInsecureEndpoint: true,
      fetch: async (input, init) => {
        requests.push({ input: String(input), init });
        return new Response(null, { status: 202 });
      },
    });

    const id = await client.record(lifecycle("starting"));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readFile(spoolPath, "utf8")).toContain(id!);

    token = "fresh-token";
    expect(await client.flush()).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe("http://127.0.0.1:8787/v1/events");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      "Bearer fresh-token",
    );
    const payload: unknown = JSON.parse(String(requests[0]?.init?.body));
    expect(isTelemetryBatchV1(payload)).toBe(true);
    expect(
      (payload as { events: Array<{ eventId: string }> }).events[0]?.eventId,
    ).toBe(id);
    expect(await client.getStats()).toMatchObject({ queued: 0, sent: 1 });
    expect(await readFile(spoolPath, "utf8")).toBe("");
    await client.close();
  });

  it("keeps the same idempotent event across failure and retry", async () => {
    let attempts = 0;
    const bodies: string[] = [];
    const { client } = await makeClient({
      getTransportConfig: () => ({
        endpoint: "http://localhost:8787/events",
      }),
      allowInsecureEndpoint: true,
      fetch: async (_input, init) => {
        attempts += 1;
        bodies.push(String(init?.body));
        if (attempts === 1) throw new Error("offline");
        return new Response(null, { status: 204 });
      },
      initialRetryMs: 60_000,
      random: () => 1,
    });

    const id = await client.record(lifecycle());
    expect(await client.flush()).toBe(false);
    expect((await client.getStats()).queued).toBe(1);
    expect(await client.flush()).toBe(true);
    const sentIds = bodies.map(
      (body) => JSON.parse(body).events[0].eventId as string,
    );
    expect(sentIds).toEqual([id, id]);
    await client.close();
  });

  it("never flushes a principal-scoped spool with another principal's transport", async () => {
    let transportScope = "b".repeat(64);
    let requests = 0;
    const { client } = await makeClient({
      principalScope: "a".repeat(64),
      getTransportConfig: () => ({
        endpoint: "http://127.0.0.1:8787/v1/events",
        authToken: "current-token",
        principalScope: transportScope,
      }),
      allowInsecureEndpoint: true,
      fetch: async () => {
        requests += 1;
        return new Response(null, { status: 202 });
      },
    });

    await client.record(lifecycle());
    expect(await client.flush()).toBe(false);
    expect(requests).toBe(0);
    expect((await client.getStats()).queued).toBe(1);

    transportScope = "a".repeat(64);
    expect(await client.flush()).toBe(true);
    expect(requests).toBe(1);
    expect((await client.getStats()).queued).toBe(0);
    await client.close();
  });

  it("drops a permanently rejected batch so it cannot poison later events", async () => {
    const { client, spoolPath } = await makeClient({
      getTransportConfig: () => ({
        endpoint: "http://127.0.0.1:8787/v1/events",
      }),
      allowInsecureEndpoint: true,
      fetch: async () => new Response(null, { status: 400 }),
    });
    await client.record(lifecycle());
    expect(await client.flush()).toBe(true);
    expect(await client.getStats()).toMatchObject({
      queued: 0,
      sent: 0,
      dropped: 1,
      rejected: 1,
    });
    expect(await readFile(spoolPath, "utf8")).toBe("");
    await client.close();
  });

  it("recovers a previous process spool", async () => {
    const root = await makeRoot();
    const spoolPath = path.join(root, "main.jsonl");
    const first = new RemoteTelemetryClient({
      spoolPath,
      getContext: () => ({ environment: "test", source: "desktop-main" }),
      getTransportConfig: () => null,
      eventId,
      flushIntervalMs: 60_000,
    });
    const id = await first.record({
      type: "app.lifecycle",
      component: "desktop-main",
      phase: "starting",
    });
    expect(await first.close()).toBe(false);

    let deliveredId = "";
    const second = new RemoteTelemetryClient({
      spoolPath,
      getContext: () => ({ environment: "test", source: "desktop-main" }),
      getTransportConfig: () => ({
        endpoint: "https://telemetry.example.test",
      }),
      fetch: async (_input, init) => {
        deliveredId = JSON.parse(String(init?.body)).events[0].eventId;
        return new Response(null, { status: 200 });
      },
      flushIntervalMs: 60_000,
    });
    expect(await second.flush()).toBe(true);
    expect(deliveredId).toBe(id);
    await second.close();
  });

  it("bounds both memory and the durable JSONL spool", async () => {
    const { client, spoolPath } = await makeClient({
      maxQueuedEvents: 2,
      maxSpoolBytes: 4_096,
    });
    await client.record(lifecycle("starting"));
    await client.record(lifecycle("ready"));
    await client.record(lifecycle("stopping"));

    const stats = await client.getStats();
    expect(stats.queued).toBe(2);
    expect(stats.dropped).toBe(1);
    const lines = (await readFile(spoolPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    await client.close();
  });

  it("rejects malformed events and never throws on config/network failure", async () => {
    const { client } = await makeClient({
      getTransportConfig: () => {
        throw new Error("credentials unavailable");
      },
    });
    await expect(
      client.record({ ...lifecycle(), arbitrary: true } as never),
    ).resolves.toBeNull();
    await expect(client.flush()).resolves.toBe(true);
    await expect(client.close()).resolves.toBe(true);
  });
});

describe("runtime telemetry principal scope", () => {
  const token = (payload: Record<string, unknown>, signature: string) =>
    [
      Buffer.from('{"alg":"none"}').toString("base64url"),
      Buffer.from(JSON.stringify(payload)).toString("base64url"),
      signature,
    ].join(".");

  it("is stable across JWT refreshes and changes with issuer or subject", () => {
    const first = token({ iss: "https://issuer.test", sub: "owner-a" }, "one");
    const refreshed = token(
      { iss: "https://issuer.test", sub: "owner-a", exp: 9999999999 },
      "two",
    );
    const otherSubject = token(
      { iss: "https://issuer.test", sub: "owner-b" },
      "three",
    );
    const otherIssuer = token(
      { iss: "https://other-issuer.test", sub: "owner-a" },
      "four",
    );

    expect(resolveRuntimeTelemetryPrincipalScope(first)).toBe(
      resolveRuntimeTelemetryPrincipalScope(refreshed),
    );
    expect(resolveRuntimeTelemetryPrincipalScope(first)).not.toBe(
      resolveRuntimeTelemetryPrincipalScope(otherSubject),
    );
    expect(resolveRuntimeTelemetryPrincipalScope(first)).not.toBe(
      resolveRuntimeTelemetryPrincipalScope(otherIssuer),
    );
  });

  it("never exposes the raw principal and isolates opaque credentials", () => {
    const subject = "private-owner@example.test";
    const scope = resolveRuntimeTelemetryPrincipalScope(
      token({ iss: "https://issuer.test", sub: subject }, "signature"),
    );
    expect(scope).toMatch(/^[0-9a-f]{64}$/);
    expect(scope).not.toContain(subject);
    expect(resolveRuntimeTelemetryPrincipalScope("opaque-token-a")).not.toBe(
      resolveRuntimeTelemetryPrincipalScope("opaque-token-b"),
    );
    expect(resolveRuntimeTelemetryPrincipalScope(null)).toBeNull();
  });

  it("keeps each durable runtime spool on its original auth principal", async () => {
    const root = await makeRoot();
    const firstToken = token(
      { iss: "https://issuer.test", sub: "owner-a" },
      "first",
    );
    const secondToken = token(
      { iss: "https://issuer.test", sub: "owner-b" },
      "second",
    );
    const firstScope = resolveRuntimeTelemetryPrincipalScope(firstToken)!;
    const secondScope = resolveRuntimeTelemetryPrincipalScope(secondToken)!;
    const firstSpool = path.join(
      root,
      "telemetry",
      `runtime-worker-v2-${firstScope}.jsonl`,
    );
    const secondSpool = path.join(
      root,
      "telemetry",
      `runtime-worker-v2-${secondScope}.jsonl`,
    );
    const originalFetch = globalThis.fetch;
    const originalEndpoint = process.env.STELLA_TELEMETRY_ENDPOINT;
    const requests: Array<{ authorization: string | null; body: string }> = [];
    globalThis.fetch = async (_input, init) => {
      requests.push({
        authorization: new Headers(init?.headers).get("authorization"),
        body: String(init?.body),
      });
      return new Response(null, { status: 202 });
    };
    process.env.STELLA_TELEMETRY_ENDPOINT =
      "https://telemetry.example.test/v1/events";

    try {
      configureRuntimeTelemetry({
        stellaDataDirPath: root,
        authToken: firstToken,
        isDev: false,
      });
      recordRuntimeTelemetry(lifecycle("starting"));
      await expect
        .poll(() => readFile(firstSpool, "utf8").catch(() => ""), {
          timeout: 2_000,
        })
        .toContain('"phase":"starting"');

      updateRuntimeTelemetryAuth(secondToken);
      await expect.poll(() => requests.length, { timeout: 2_000 }).toBe(1);
      expect(requests[0]?.authorization).toBe(`Bearer ${firstToken}`);
      expect(requests[0]?.body).toContain('"phase":"starting"');

      recordRuntimeTelemetry(lifecycle("ready"));
      await expect
        .poll(() => readFile(secondSpool, "utf8").catch(() => ""), {
          timeout: 2_000,
        })
        .toContain('"phase":"ready"');
      await closeRuntimeTelemetry();

      expect(requests).toHaveLength(2);
      expect(requests[1]?.authorization).toBe(`Bearer ${secondToken}`);
      expect(requests[1]?.body).toContain('"phase":"ready"');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalEndpoint === undefined) {
        delete process.env.STELLA_TELEMETRY_ENDPOINT;
      } else {
        process.env.STELLA_TELEMETRY_ENDPOINT = originalEndpoint;
      }
      await closeRuntimeTelemetry();
    }
  });
});
