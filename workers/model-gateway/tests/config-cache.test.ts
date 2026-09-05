import { beforeEach, describe, expect, test } from "bun:test";
import type { GatewayConfigSnapshot } from "@stella/contracts/gateway/usage";
import {
  getGatewayConfig,
  CONFIG_TTL_MS,
  resetConfigCacheForTests,
} from "../src/config-cache.js";
import { createConvexClient } from "../src/convex-client.js";
import {
  completeConfigSnapshot,
  configSnapshot,
  createFetchMock,
  createTestEnv,
  json,
} from "./helpers/env.js";
import {
  gatewayConfigRevision,
  type SharedGatewayConfigRecord,
} from "../src/shared-config.js";

const SOURCE = "https://config.example";

const sharedRecord = async (
  snapshot: GatewayConfigSnapshot,
  overrides: Partial<SharedGatewayConfigRecord> = {},
): Promise<SharedGatewayConfigRecord> => ({
  version: 1,
  source: SOURCE,
  originalFetchedAt: 1_000,
  revision: await gatewayConfigRevision(snapshot),
  snapshot,
  ...overrides,
});

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
    const fetchMock = createFetchMock().on(
      (call) => call.url.pathname === "/api/gateway/config",
      () => json(completeConfigSnapshot()),
    );
    let saved: SharedGatewayConfigRecord | undefined;
    const storage = {
      source: SOURCE,
      read: () => saved,
      write: (value: SharedGatewayConfigRecord) => {
        saved = structuredClone(value);
      },
    };
    const client = createConvexClient(harness.env, fetchMock.fetch);
    const initial = await getGatewayConfig(
      client,
      () => undefined,
      () => 1_000,
      storage,
    );
    resetConfigCacheForTests();
    const offline = createConvexClient(harness.env, (async () => {
      throw new Error("No cold request expected");
    }) as typeof fetch);
    const restored = await getGatewayConfig(
      offline,
      () => undefined,
      () => 2_000,
      storage,
    );
    expect(restored.fetchedAt).toBe(1_000);
    expect(restored.snapshot).toEqual(initial.snapshot);
    expect(restored.priceFor(initial.snapshot.prices[0]!.model)).toEqual(
      initial.priceFor(initial.snapshot.prices[0]!.model),
    );
    expect(saved?.originalFetchedAt).toBe(1_000);
  });

  test("expired, future, wrong-source and malformed durable pricing require a fresh load", async () => {
    const harness = createTestEnv();
    const offline = createConvexClient(harness.env, (async () => {
      throw new Error("offline");
    }) as typeof fetch);
    const base = await sharedRecord(completeConfigSnapshot());
    const cases = [
      base,
      { ...base, originalFetchedAt: CONFIG_TTL_MS + 2_000 },
      {
        ...base,
        originalFetchedAt: CONFIG_TTL_MS,
        source: "https://wrong.example",
      },
      { ...base, originalFetchedAt: CONFIG_TTL_MS, snapshot: {} },
    ];
    for (const value of cases) {
      resetConfigCacheForTests();
      await expect(
        getGatewayConfig(
          offline,
          () => undefined,
          () => CONFIG_TTL_MS + 1_000,
          {
            source: base.source,
            read: () => value,
            write: () => {
              throw new Error("must not save");
            },
          },
        ),
      ).rejects.toThrow();
    }
  });

  test("background refresh replaces persisted pricing, not just the resident copy", async () => {
    const harness = createTestEnv();
    let saved: SharedGatewayConfigRecord | undefined;
    const storage = {
      source: SOURCE,
      read: () => saved,
      write: (value: SharedGatewayConfigRecord) => {
        saved = structuredClone(value);
      },
    };
    const client = createConvexClient(
      harness.env,
      createFetchMock().on(
        (call) => call.url.pathname === "/api/gateway/config",
        () => json(completeConfigSnapshot()),
      ).fetch,
    );
    await getGatewayConfig(
      client,
      () => undefined,
      () => 1_000,
      storage,
    );
    const pending: Promise<unknown>[] = [];
    const stale = await getGatewayConfig(
      client,
      (work) => {
        pending.push(work);
      },
      () => CONFIG_TTL_MS + 1_000,
      storage,
    );
    expect(stale.fetchedAt).toBe(1_000);
    await Promise.all(pending);
    expect(saved?.originalFetchedAt).toBe(CONFIG_TTL_MS + 1_000);
  });

  test("a cold owner restores a fresh complete shared snapshot without calling Convex", async () => {
    const snapshot = completeConfigSnapshot();
    const record = await sharedRecord(snapshot);
    let convexCalls = 0;
    const client = createConvexClient(createTestEnv().env, (async () => {
      convexCalls += 1;
      return json(configSnapshot());
    }) as typeof fetch);
    let saved: SharedGatewayConfigRecord | undefined;
    const restored = await getGatewayConfig(
      client,
      () => undefined,
      () => 2_000,
      {
        source: record.source,
        read: () => saved,
        write: (value) => {
          saved = structuredClone(value);
        },
      },
      { source: record.source, read: async () => structuredClone(record) },
    );
    expect(convexCalls).toBe(0);
    expect(restored.fetchedAt).toBe(record.originalFetchedAt);
    expect(restored.snapshot).toEqual(snapshot);
    expect(saved?.originalFetchedAt).toBe(record.originalFetchedAt);
  });

  test("invalid shared snapshots fall back to Convex without extending their age", async () => {
    const complete = completeConfigSnapshot();
    const base = await sharedRecord(complete);
    const cases: unknown[] = [
      null,
      { ...base, source: "https://wrong.example" },
      { ...base, originalFetchedAt: CONFIG_TTL_MS + 2_000 },
      { ...base, originalFetchedAt: 1_000, revision: "wrong" },
      { ...base, snapshot: { ...complete, tierCeilings: [] } },
    ];
    for (const value of cases) {
      resetConfigCacheForTests();
      let convexCalls = 0;
      const client = createConvexClient(createTestEnv().env, (async () => {
        convexCalls += 1;
        return json(complete);
      }) as typeof fetch);
      const loaded = await getGatewayConfig(
        client,
        () => undefined,
        () => CONFIG_TTL_MS + 1_000,
        undefined,
        { source: base.source, read: async () => structuredClone(value) },
      );
      expect(convexCalls).toBe(1);
      expect(loaded.fetchedAt).toBe(CONFIG_TTL_MS + 1_000);
    }
  });

  test("concurrent cold readers share one KV read", async () => {
    const snapshot = completeConfigSnapshot();
    const record = await sharedRecord(snapshot);
    let reads = 0;
    const shared = {
      source: record.source,
      read: async () => {
        reads += 1;
        await Promise.resolve();
        return record;
      },
    };
    const offline = createConvexClient(createTestEnv().env, (async () => {
      throw new Error("No Convex request expected");
    }) as typeof fetch);
    const [first, second] = await Promise.all([
      getGatewayConfig(
        offline,
        () => undefined,
        () => 2_000,
        undefined,
        shared,
      ),
      getGatewayConfig(
        offline,
        () => undefined,
        () => 2_000,
        undefined,
        shared,
      ),
    ]);
    expect(reads).toBe(1);
    expect(first.snapshot).toEqual(snapshot);
    expect(second.snapshot).toEqual(snapshot);
  });

  test("a delayed shared read cannot replace newer owner storage", async () => {
    const olderSnapshot = completeConfigSnapshot({ updatedAt: 1 });
    const olderRecord = await sharedRecord(olderSnapshot);
    const newerRecord = await sharedRecord(
      { ...olderSnapshot, updatedAt: 2 },
      { originalFetchedAt: 2_000 },
    );
    let releaseShared: (() => void) | undefined;
    const sharedBlocked = new Promise<void>((resolve) => {
      releaseShared = resolve;
    });
    const offline = createConvexClient(createTestEnv().env, (async () => {
      throw new Error("No Convex request expected");
    }) as typeof fetch);
    const olderLoad = getGatewayConfig(
      offline,
      () => undefined,
      () => 3_000,
      undefined,
      {
        source: olderRecord.source,
        read: async () => {
          await sharedBlocked;
          return olderRecord;
        },
      },
    );
    await Promise.resolve();
    const newer = await getGatewayConfig(
      offline,
      () => undefined,
      () => 3_000,
      {
        source: olderRecord.source,
        read: () => newerRecord,
        write: () => undefined,
      },
    );
    releaseShared?.();
    const first = await olderLoad;
    expect(first.fetchedAt).toBe(2_000);
    expect(first.snapshot.updatedAt).toBe(2);
    expect(newer.fetchedAt).toBe(2_000);
  });
});

test("warm isolate seeds owner durable storage", async () => {
  resetConfigCacheForTests();
  const harness = createTestEnv();
  const fetchMock = createFetchMock().on(
    (call) => call.url.pathname === "/api/gateway/config",
    () => json(completeConfigSnapshot()),
  );
  const client = createConvexClient(harness.env, fetchMock.fetch);
  await getGatewayConfig(
    client,
    () => undefined,
    () => 1_000,
  );
  let saved: SharedGatewayConfigRecord | undefined;
  await getGatewayConfig(
    client,
    () => undefined,
    () => 1_000,
    {
      source: SOURCE,
      read: () => saved,
      write: (record) => {
        saved = record;
      },
    },
  );
  expect(saved?.originalFetchedAt).toBe(1_000);
  resetConfigCacheForTests();
  const offline = createConvexClient(harness.env, async () => {
    throw new Error("A durable cache hit must not fetch configuration");
  });
  const restored = await getGatewayConfig(
    offline,
    () => undefined,
    () => 2_000,
    {
      source: SOURCE,
      read: () => saved,
      write: (record) => {
        saved = record;
      },
    },
  );
  expect(restored.fetchedAt).toBe(1_000);
  expect(restored.snapshot).toEqual(completeConfigSnapshot());
});
