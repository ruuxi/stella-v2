import { describe, expect, test } from "bun:test";
import { createConvexClient } from "../src/convex-client.js";
import {
  gatewayConfigRevision,
  isCompleteGatewayConfigSnapshot,
  publishSharedGatewayConfig,
  SHARED_GATEWAY_CONFIG_KEY,
  type SharedGatewayConfigRecord,
} from "../src/shared-config.js";
import {
  completeConfigSnapshot,
  configSnapshot,
  createFetchMock,
  createTestEnv,
  json,
} from "./helpers/env.js";

describe("shared gateway config", () => {
  test("the revision covers anonymous caps and tier ceilings", async () => {
    const snapshot = completeConfigSnapshot();
    const anonymousChanged = {
      ...snapshot,
      anonymous: { ...snapshot.anonymous, maxRequestsPerOwner: 21 },
    };
    const ceilingChanged = {
      ...snapshot,
      tierCeilings: snapshot.tierCeilings.map((ceiling) =>
        ceiling.audience === "free"
          ? { ...ceiling, dailyMicroCents: ceiling.dailyMicroCents + 1 }
          : ceiling,
      ),
    };
    expect(await gatewayConfigRevision(anonymousChanged)).not.toBe(
      await gatewayConfigRevision(snapshot),
    );
    expect(await gatewayConfigRevision(ceilingChanged)).not.toBe(
      await gatewayConfigRevision(snapshot),
    );
  });

  test("strict validation refuses missing, duplicate, and invalid policy fields", () => {
    const snapshot = completeConfigSnapshot();
    expect(isCompleteGatewayConfigSnapshot(snapshot)).toBe(true);
    expect(
      isCompleteGatewayConfigSnapshot({ ...snapshot, anonymous: undefined }),
    ).toBe(false);
    expect(
      isCompleteGatewayConfigSnapshot({ ...snapshot, tierCeilings: [] }),
    ).toBe(false);
    expect(
      isCompleteGatewayConfigSnapshot({
        ...snapshot,
        tierCeilings: [...snapshot.tierCeilings, snapshot.tierCeilings[0]],
      }),
    ).toBe(false);
    expect(
      isCompleteGatewayConfigSnapshot({
        ...snapshot,
        tierCeilings: [
          ...snapshot.tierCeilings,
          {
            audience: "unknown",
            hourlyMicroCents: 1,
            dailyMicroCents: 1,
          },
        ],
      }),
    ).toBe(false);
    expect(
      isCompleteGatewayConfigSnapshot({
        ...snapshot,
        prices: [{ ...snapshot.prices[0], inputPerMillionUsd: Number.NaN }],
      }),
    ).toBe(false);
  });

  test("scheduled publication writes the complete snapshot and original fetch time", async () => {
    const snapshot = completeConfigSnapshot();
    const fetchMock = createFetchMock().on(
      (call) => call.url.pathname === "/api/gateway/config",
      () => json(snapshot),
    );
    const writes: Array<{ key: string; value: string }> = [];
    await publishSharedGatewayConfig({
      client: createConvexClient(createTestEnv().env, fetchMock.fetch),
      store: {
        put: async (key, value) => {
          writes.push({ key, value: String(value) });
        },
      },
      source: "https://config.example",
      now: () => 12_345,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.key).toBe(SHARED_GATEWAY_CONFIG_KEY);
    const record = JSON.parse(writes[0]!.value) as SharedGatewayConfigRecord;
    expect(record.originalFetchedAt).toBe(12_345);
    expect(record.source).toBe("https://config.example");
    expect(record.revision).toBe(await gatewayConfigRevision(snapshot));
    expect(record.snapshot).toEqual(snapshot);
  });

  test("scheduled publication leaves the previous record in place on incomplete config", async () => {
    const fetchMock = createFetchMock().on(
      (call) => call.url.pathname === "/api/gateway/config",
      () => json(configSnapshot({ tierCeilings: [] })),
    );
    let writes = 0;
    await publishSharedGatewayConfig({
      client: createConvexClient(createTestEnv().env, fetchMock.fetch),
      store: {
        put: async () => {
          writes += 1;
        },
      },
      source: "https://config.example",
    });
    expect(writes).toBe(0);
  });

  test("scheduled publication reports a KV failure to the runtime", async () => {
    const fetchMock = createFetchMock().on(
      (call) => call.url.pathname === "/api/gateway/config",
      () => json(completeConfigSnapshot()),
    );
    await expect(
      publishSharedGatewayConfig({
        client: createConvexClient(createTestEnv().env, fetchMock.fetch),
        store: {
          put: async () => {
            throw new Error("KV unavailable");
          },
        },
        source: "https://config.example",
      }),
    ).rejects.toThrow("KV unavailable");
  });
});
