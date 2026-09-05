import { beforeEach, describe, expect, test } from "bun:test";
import {
  getGatewayConfig,
  CONFIG_TTL_MS,
  type GatewayConfigRecord,
  resetConfigCacheForTests,
} from "../src/config-cache.js";
import { createConvexClient } from "../src/convex-client.js";
import {
  configSnapshot,
  createFetchMock,
  createTestEnv,
  json,
} from "./helpers/env.js";

describe("gateway config cache", () => {
  beforeEach(() => resetConfigCacheForTests());

  test("indexes tier ceilings by limits audience and exposes the owner request cap", async () => {
    const harness = createTestEnv();
    const fetchMock = createFetchMock().on(
      (call) => call.url.pathname === "/api/gateway/config",
      () =>
        json(
          configSnapshot({
            anonymous: { maxRequestsPerOwner: 17, maxRequestsPerIp: 90 },
            tierCeilings: [
              {
                audience: "anonymous",
                hourlyMicroCents: 100,
                dailyMicroCents: 1_000,
              },
              {
                audience: "go_fallback",
                hourlyMicroCents: 200,
                dailyMicroCents: 2_000,
              },
            ],
          }),
        ),
    );
    const config = await getGatewayConfig(
      createConvexClient(harness.env, fetchMock.fetch),
      () => undefined,
      () => 1_000,
    );
    expect(config.anonymous.maxRequestsPerOwner).toBe(17);
    expect(config.tierCeilings.get("anonymous")).toEqual({
      hourlyMicroCents: 100,
      dailyMicroCents: 1_000,
    });
    expect(config.tierCeilings.get("go")).toEqual({
      hourlyMicroCents: 200,
      dailyMicroCents: 2_000,
    });
  });

  test("accepts older snapshots with no ceiling or anonymous fields", async () => {
    const harness = createTestEnv();
    const fetchMock = createFetchMock().on(
      (call) => call.url.pathname === "/api/gateway/config",
      () =>
        json({
          v: 1,
          prices: configSnapshot().prices,
          updatedAt: 1,
        }),
    );
    const config = await getGatewayConfig(
      createConvexClient(harness.env, fetchMock.fetch),
      () => undefined,
    );
    expect(config.anonymous.maxRequestsPerOwner).toBeNull();
    expect(config.tierCeilings.size).toBe(0);
  });
  test("a restart restores fresh durable pricing without renewing its age", async () => {
    const harness = createTestEnv();
    const fetchMock = createFetchMock().on(call => call.url.pathname === "/api/gateway/config", () => json(configSnapshot()));
    let saved: GatewayConfigRecord | undefined;
    const storage = { endpoint: "https://config.example", read: () => saved, write: (value: GatewayConfigRecord) => { saved = structuredClone(value); } };
    const client = createConvexClient(harness.env, fetchMock.fetch);
    const initial = await getGatewayConfig(client, () => undefined, () => 1_000, storage);
    resetConfigCacheForTests();
    const offline = createConvexClient(harness.env, (async () => { throw new Error("No cold request expected"); }) as typeof fetch);
    const restored = await getGatewayConfig(offline, () => undefined, () => 2_000, storage);
    expect(restored.fetchedAt).toBe(1_000);
    expect(restored.snapshot).toEqual(initial.snapshot);
    expect(restored.priceFor(initial.snapshot.prices[0]!.model)).toEqual(initial.priceFor(initial.snapshot.prices[0]!.model));
    expect(saved?.fetchedAt).toBe(1_000);
  });

  test("expired, future, wrong-source and malformed durable pricing require a fresh load", async () => {
    const harness = createTestEnv();
    const offline = createConvexClient(harness.env, (async () => { throw new Error("offline"); }) as typeof fetch);
    const base = { version: 1, endpoint: "https://config.example", fetchedAt: 1_000, snapshot: configSnapshot() };
    const cases = [base, { ...base, fetchedAt: CONFIG_TTL_MS + 2_000 },
      { ...base, fetchedAt: CONFIG_TTL_MS, endpoint: "https://wrong.example" }, { ...base, fetchedAt: CONFIG_TTL_MS, snapshot: {} }];
    for (const value of cases) {
      resetConfigCacheForTests();
      await expect(getGatewayConfig(offline, () => undefined, () => CONFIG_TTL_MS + 1_000,
        { endpoint: base.endpoint, read: () => value, write: () => { throw new Error("must not save"); } })).rejects.toThrow();
    }
  });

  test("background refresh replaces persisted pricing, not just the resident copy", async () => {
    const harness = createTestEnv();
    let saved: GatewayConfigRecord | undefined;
    const storage = { endpoint: "https://config.example", read: () => saved, write: (value: GatewayConfigRecord) => { saved = structuredClone(value); } };
    const client = createConvexClient(harness.env, createFetchMock().on(call => call.url.pathname === "/api/gateway/config", () => json(configSnapshot())).fetch);
    await getGatewayConfig(client, () => undefined, () => 1_000, storage);
    const pending: Promise<unknown>[] = [];
    const stale = await getGatewayConfig(client, work => { pending.push(work); }, () => CONFIG_TTL_MS + 1_000, storage);
    expect(stale.fetchedAt).toBe(1_000);
    await Promise.all(pending);
    expect(saved?.fetchedAt).toBe(CONFIG_TTL_MS + 1_000);
  });

});
