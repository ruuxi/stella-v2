import { beforeEach, describe, expect, test } from "bun:test";
import {
  getGatewayConfig,
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
});
