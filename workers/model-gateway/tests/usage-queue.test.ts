import { describe, expect, test } from "bun:test";
import type { GatewayUsageEvent } from "@stella/contracts/gateway/usage";
import { createConvexClient } from "../src/convex-client.js";
import { handleUsageBatch } from "../src/usage-queue.js";
import {
  createFetchMock,
  CONVEX_SITE,
  json,
  SERVICE_SECRET,
} from "./helpers/env.js";

const event = (requestId: string): GatewayUsageEvent => ({
  v: 1,
  requestId,
  capabilityId: "jti",
  kind: "session",
  ownerId: "owner",
  ownerGeneration: "gen-1",
  audience: "pro",
  agentType: "orchestrator",
  provider: "openrouter",
  protocol: "openai-responses",
  requestedModel: "stella/default",
  resolvedModel: "meta/muse-spark-1.2-contributor",
  usage: { inputTokens: 1, outputTokens: 2, reported: true },
  chargedMicroCents: 3,
  outcome: "succeeded",
  startedAt: 1,
  finishedAt: 2,
  billable: true,
});

const batchOf = (bodies: unknown[], attempts = 1) => {
  const acked: string[] = [];
  const retried: string[] = [];
  let ackedAll = false;
  let retriedAll: { delaySeconds?: number } | null = null;
  const batch = {
    queue: "stella-v2-gateway-usage-dev",
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    messages: bodies.map((body, index) => ({
      id: `m${index}`,
      timestamp: new Date(),
      body,
      attempts,
      ack: () => {
        acked.push(`m${index}`);
      },
      retry: () => {
        retried.push(`m${index}`);
      },
    })),
    ackAll: () => {
      ackedAll = true;
    },
    retryAll: (options?: { delaySeconds?: number }) => {
      retriedAll = options ?? {};
    },
  };
  return {
    batch: batch as unknown as MessageBatch<unknown>,
    acked,
    retried,
    ackedAll: () => ackedAll,
    retriedAll: () => retriedAll as { delaySeconds?: number } | null,
  };
};

const env = {
  STELLA_CONVEX_SITE_URL: CONVEX_SITE,
  GATEWAY_SERVICE_SECRET: SERVICE_SECRET,
} as Env;

describe("usage queue consumer", () => {
  test("posts one batch with the service secret and acks on 2xx", async () => {
    const fetchMock = createFetchMock().on(
      (call) => call.url.pathname === "/api/gateway/usage",
      () => json({ accepted: ["a", "b"], duplicate: [], rejected: [] }),
    );
    const { batch, ackedAll, retriedAll } = batchOf([event("a"), event("b")]);
    await handleUsageBatch(
      batch,
      env,
      createConvexClient(env, fetchMock.fetch),
    );
    expect(ackedAll()).toBe(true);
    expect(retriedAll()).toBeNull();
    const call = fetchMock.calls[0]!;
    expect(call.url.href).toBe(`${CONVEX_SITE}/api/gateway/usage`);
    expect(call.headers.get("authorization")).toBe(`Bearer ${SERVICE_SECRET}`);
    expect(JSON.parse(call.body ?? "{}")).toEqual({
      v: 1,
      events: [event("a"), event("b")],
    });
  });

  test("retries the whole batch with backoff on 5xx and on network failure", async () => {
    const down = createFetchMock().on(
      (call) => call.url.pathname === "/api/gateway/usage",
      () => new Response("down", { status: 503 }),
    );
    const first = batchOf([event("a")], 1);
    await handleUsageBatch(
      first.batch,
      env,
      createConvexClient(env, down.fetch),
    );
    expect(first.ackedAll()).toBe(false);
    expect(first.retriedAll()).toEqual({ delaySeconds: 5 });

    const third = batchOf([event("a")], 3);
    await handleUsageBatch(
      third.batch,
      env,
      createConvexClient(env, down.fetch),
    );
    expect(third.retriedAll()).toEqual({ delaySeconds: 60 });

    const unreachable = createConvexClient(env, (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    const offline = batchOf([event("a")], 2);
    await handleUsageBatch(offline.batch, env, unreachable);
    expect(offline.retriedAll()).toEqual({ delaySeconds: 15 });
  });

  test("acks on 4xx so a bad batch cannot poison the queue, and acks malformed messages individually", async () => {
    const rejecting = createFetchMock().on(
      (call) => call.url.pathname === "/api/gateway/usage",
      () => json({ error: { code: "bad_request", message: "nope" } }, 400),
    );
    const { batch, acked, ackedAll, retriedAll } = batchOf([
      event("a"),
      { garbage: true },
      "text",
    ]);
    await handleUsageBatch(
      batch,
      env,
      createConvexClient(env, rejecting.fetch),
    );
    expect(acked).toEqual(["m1", "m2"]);
    expect(ackedAll()).toBe(true);
    expect(retriedAll()).toBeNull();
    expect(JSON.parse(rejecting.calls[0]!.body ?? "{}")).toEqual({
      v: 1,
      events: [event("a")],
    });
  });

  test("a batch of only malformed messages never calls Convex", async () => {
    const fetchMock = createFetchMock();
    const { batch, acked } = batchOf([null, 42]);
    await handleUsageBatch(
      batch,
      env,
      createConvexClient(env, fetchMock.fetch),
    );
    expect(acked).toEqual(["m0", "m1"]);
    expect(fetchMock.calls).toHaveLength(0);
  });
});
