import { describe, expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const { fetchHandler } = await import("../src/index.js");
const inputEvent = {
  schemaVersion: 1,
  eventId: "01991999-1111-7111-8111-111111111111",
  occurredAtMs: Date.now(),
  project: "stella",
  environment: "development",
  source: "desktop-main",
  ownerIdSha256: "a".repeat(64),
  event: {
    type: "inference.completed",
    provider: "anthropic",
    model: "claude-sonnet",
    agentType: "orchestrator",
    durationMs: 123,
    success: true,
    inputTokens: 10,
    outputTokens: 20,
    costMicroCents: 42,
  },
};

const request = () =>
  new Request("https://telemetry.example/v1/events", {
    method: "POST",
    headers: {
      authorization: "Bearer service-secret",
      "content-type": "application/json",
      "x-stella-service-id": "cloud-builder",
    },
    body: JSON.stringify({ schemaVersion: 1, events: [inputEvent] }),
  });

const environment = (
  send: (records: Record<string, unknown>[]) => Promise<void>,
  rate = true,
) => ({
  ENVIRONMENT: "development" as const,
  STELLA_BACKEND_URL: "https://backend.stella.test" as const,
  ENABLE_SERVER_BEARER: "1" as const,
  TELEMETRY_PSEUDONYM_KEY: "long-test-pseudonym-secret",
  TELEMETRY_SERVER_SECRET: "service-secret",
  EVENTS_PIPELINE: { send },
  TELEMETRY_RATE_LIMITER: { limit: async () => ({ success: rate }) },
});

describe("HTTP ingestion", () => {
  test("awaits Pipeline acknowledgement and replaces producer owner identity", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sent: Record<string, unknown>[] = [];
    const responsePromise = fetchHandler(
      request(),
      environment(async (records) => {
        sent = records;
        await pending;
      }),
    );
    let settled = false;
    void responsePromise.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    release();
    expect((await responsePromise).status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.event_type).toBe("inference.completed");
    expect(sent[0]?.cost_micro_cents).toBe(42);
    expect(sent[0]?.owner_id_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sent[0]?.owner_id_sha256).not.toBe("a".repeat(64));
    expect(sent[0]).not.toHaveProperty("event");
  });

  test("rate limiting prevents Pipeline delivery", async () => {
    let called = false;
    const response = await fetchHandler(
      request(),
      environment(async () => {
        called = true;
      }, false),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(called).toBe(false);
  });

  test("reports Pipeline failures as retryable service errors", async () => {
    const response = await fetchHandler(
      request(),
      environment(async () => {
        throw new Error("unavailable");
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "ingestion_unavailable",
    });
  });

  test("rejects implausible event times before Pipeline delivery", async () => {
    let called = false;
    const staleRequest = new Request("https://telemetry.example/v1/events", {
      method: "POST",
      headers: {
        authorization: "Bearer service-secret",
        "content-type": "application/json",
        "x-stella-service-id": "cloud-builder",
      },
      body: JSON.stringify({
        schemaVersion: 1,
        events: [{ ...inputEvent, occurredAtMs: 1 }],
      }),
    });
    const response = await fetchHandler(
      staleRequest,
      environment(async () => {
        called = true;
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "event_time_out_of_range",
    });
    expect(called).toBe(false);
  });
});
