import { describe, expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const { fetchHandler } = await import("../src/index.js");
const { canonicalUserOwnerKey, createPseudonymizer } = await import(
  "../src/pseudonym.js"
);

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
  STELLA_CONVEX_SITE_URL: "https://issuer.convex.site" as const,
  ENABLE_SERVER_BEARER: "1" as const,
  TELEMETRY_PSEUDONYM_KEY: "long-test-pseudonym-secret",
  TELEMETRY_SERVER_SECRET: "service-secret",
  CONVEX_LOG_STREAM_SECRET: "convex-log-stream-secret",
  EVENTS_PIPELINE: { send },
  TELEMETRY_RATE_LIMITER: { limit: async () => ({ success: rate }) },
});

describe("HTTP ingestion", () => {
  test("uses one owner pseudonym across authenticated and Convex lanes", async () => {
    const ownerId = "https://issuer.convex.site|user-123";
    const convexOwnerKey = await canonicalUserOwnerKey(ownerId);
    const pseudonymize = await createPseudonymizer(
      "long-test-pseudonym-secret",
      "development",
    );

    const authenticatedLane = await pseudonymize(
      "owner",
      await canonicalUserOwnerKey(ownerId),
    );
    const convexLane = await pseudonymize("owner", convexOwnerKey);

    expect(authenticatedLane).toBe(convexLane);
    expect(authenticatedLane).toMatch(/^[0-9a-f]{64}$/);
    expect(authenticatedLane).not.toContain(ownerId);
  });

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

  test("turns signed Convex metric logs into deduplicatable lake events", async () => {
    const metric = {
      kind: "inference.completed",
      ownerKey: "b".repeat(64),
      occurredAtMs: Date.now(),
      model: "stella/openai/gpt-5.6-sol",
      agentType: "orchestrator",
      durationMs: 321,
      success: true,
      inputTokens: 12,
      outputTokens: 34,
      totalTokens: 46,
      costMicroCents: 99,
    };
    const body = JSON.stringify([
      {
        topic: "function_execution",
        timestamp: metric.occurredAtMs,
        convex: { deployment_name: "impartial-crab-34" },
      },
      {
        topic: "console",
        timestamp: metric.occurredAtMs,
        convex: { deployment_name: "impartial-crab-34" },
        function: {
          path: "billing:logManagedUsage",
          request_id: "request-123",
          type: "mutation",
        },
        log_level: "LOG",
        message: `'_stella_metric:${JSON.stringify(metric)}'`,
        is_truncated: false,
      },
    ]);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("convex-log-stream-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
    );
    const signatureHex = Array.from(signature, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const convexRequest = () =>
      new Request("https://telemetry.example/v1/convex-logs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": `sha256=${signatureHex}`,
        },
        body,
      });
    const sent: Record<string, unknown>[][] = [];
    const env = environment(async (records) => {
      sent.push(records);
    });

    const first = await fetchHandler(convexRequest(), env);
    const second = await fetchHandler(convexRequest(), env);
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ accepted: 1, ignored: 1 });
    expect(second.status).toBe(202);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toHaveLength(1);
    expect(sent[0]?.[0]).toMatchObject({
      source: "convex-backend",
      event_type: "inference.completed",
      model: "stella/openai/gpt-5.6-sol",
      input_tokens: 12,
      output_tokens: 34,
      cost_micro_cents: 99,
      principal_kind: "service",
    });
    expect(sent[0]?.[0]?.event_id).toBe(sent[1]?.[0]?.event_id);
    expect(sent[0]?.[0]?.owner_id_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(sent)).not.toContain(metric.ownerKey);
  });

  test("rejects a tampered Convex log-stream signature", async () => {
    let called = false;
    const response = await fetchHandler(
      new Request("https://telemetry.example/v1/convex-logs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": `sha256=${"0".repeat(64)}`,
        },
        body: "[]",
      }),
      environment(async () => {
        called = true;
      }),
    );
    expect(response.status).toBe(401);
    expect(called).toBe(false);
  });

  test("rejects a correctly signed stale Convex log-stream batch", async () => {
    const body = JSON.stringify([
      {
        topic: "verification",
        timestamp: Date.now() - 16 * 60_000,
        message: "verification",
      },
    ]);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("convex-log-stream-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
    );
    const signatureHex = Array.from(signature, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    let called = false;
    const response = await fetchHandler(
      new Request("https://telemetry.example/v1/convex-logs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": `sha256=${signatureHex}`,
        },
        body,
      }),
      environment(async () => {
        called = true;
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "request_expired" });
    expect(called).toBe(false);
  });
});
