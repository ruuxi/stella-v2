import { describe, expect, test } from "bun:test";
import {
  GATEWAY_NETWORK_LIMITS,
  GATEWAY_OWNER_RELAY_LIMITS,
  GATEWAY_UPSTREAM_MAX_DURATION_MS,
} from "@stella/contracts/gateway/api";
import {
  createDurableObjectState,
  NetworkGate,
  OwnerRelayGate,
  TierBudget,
} from "./helpers/env.js";

const withClock = async <T>(
  start: number,
  run: (clock: { now: number }) => Promise<T>,
): Promise<T> => {
  const originalNow = Date.now;
  const clock = { now: start };
  Date.now = () => clock.now;
  try {
    return await run(clock);
  } finally {
    Date.now = originalNow;
  }
};

const ownerGate = () =>
  new OwnerRelayGate(createDurableObjectState("owner") as never, {} as never);
const networkGate = () =>
  new NetworkGate(createDurableObjectState("network") as never, {} as never);
const tierBudget = () =>
  new TierBudget(createDurableObjectState("free") as never, {} as never);

describe("OwnerRelayGate", () => {
  test("holds concurrency until release and drops abandoned entries", async () => {
    await withClock(1_000_000, async (clock) => {
      const gate = ownerGate();
      expect(
        await gate.admitRelay({
          audience: "anonymous",
          requestId: "one",
          throttled: false,
        }),
      ).toEqual({ ok: true });
      const refused = await gate.admitRelay({
        audience: "anonymous",
        requestId: "two",
        throttled: false,
      });
      expect(refused).toMatchObject({
        ok: false,
        refused: "concurrency_limit",
      });
      // A retry of the in-flight request id is not a second slot: it passes
      // uncounted so the capability ledger can answer replay or in-flight.
      expect(
        await gate.admitRelay({
          audience: "anonymous",
          requestId: "one",
          throttled: false,
        }),
      ).toEqual({ ok: true, duplicate: true });
      await gate.releaseRelay("one");
      expect(
        await gate.admitRelay({
          audience: "anonymous",
          requestId: "two",
          throttled: false,
        }),
      ).toEqual({ ok: true });
      clock.now += GATEWAY_UPSTREAM_MAX_DURATION_MS + 60_001;
      expect(
        await gate.admitRelay({
          audience: "anonymous",
          requestId: "three",
          throttled: false,
        }),
      ).toEqual({ ok: true });
    });
  });

  test("enforces rolling relay and throttled mint limits", async () => {
    await withClock(2_000_000, async (clock) => {
      const gate = ownerGate();
      for (
        let index = 0;
        index < GATEWAY_OWNER_RELAY_LIMITS.anonymous.perMinute;
        index += 1
      ) {
        const requestId = `relay-${index}`;
        expect(
          await gate.admitRelay({
            audience: "anonymous",
            requestId,
            throttled: false,
          }),
        ).toEqual({ ok: true });
        await gate.releaseRelay(requestId);
      }
      expect(
        await gate.admitRelay({
          audience: "anonymous",
          requestId: "blocked",
          throttled: false,
        }),
      ).toMatchObject({ ok: false, refused: "rate_limited" });
      clock.now += 60_001;
      expect(
        await gate.admitRelay({
          audience: "anonymous",
          requestId: "after-window",
          throttled: false,
        }),
      ).toEqual({ ok: true });

      const mintGate = ownerGate();
      const throttledMintLimit = Math.floor(
        GATEWAY_OWNER_RELAY_LIMITS.free.mintsPerHour / 2,
      );
      for (let index = 0; index < throttledMintLimit; index += 1) {
        expect(
          await mintGate.admitMint({ audience: "free", throttled: true }),
        ).toEqual({ ok: true });
      }
      expect(
        await mintGate.admitMint({ audience: "free", throttled: true }),
      ).toMatchObject({ ok: false, refused: "rate_limited" });
      clock.now += 60 * 60_000 + 1;
      expect(
        await mintGate.admitMint({ audience: "free", throttled: true }),
      ).toEqual({ ok: true });
    });
  });

  test("halves the free in-flight limit for throttled owners", async () => {
    const gate = ownerGate();
    expect(
      await gate.admitRelay({
        audience: "free",
        requestId: "first",
        throttled: true,
      }),
    ).toEqual({ ok: true });
    expect(
      await gate.admitRelay({
        audience: "free",
        requestId: "second",
        throttled: true,
      }),
    ).toMatchObject({ ok: false, refused: "concurrency_limit" });
  });
});

describe("NetworkGate", () => {
  test("enforces anonymous hourly relay and daily mint limits", async () => {
    await withClock(10_000_000, async (clock) => {
      const relayGate = networkGate();
      for (
        let index = 0;
        index < GATEWAY_NETWORK_LIMITS.anonymous.relayPerHour;
        index += 1
      ) {
        expect(
          await relayGate.admitRelay({
            audience: "anonymous",
            capShare: 1,
          }),
        ).toEqual({ ok: true });
      }
      expect(
        await relayGate.admitRelay({ audience: "anonymous", capShare: 1 }),
      ).toMatchObject({ ok: false, refused: "rate_limited" });
      clock.now += 60 * 60_000 + 1;
      expect(
        await relayGate.admitRelay({ audience: "anonymous", capShare: 1 }),
      ).toEqual({ ok: true });

      const mintGate = networkGate();
      for (
        let index = 0;
        index < GATEWAY_NETWORK_LIMITS.anonymous.mintsPerDay;
        index += 1
      ) {
        expect(await mintGate.admitMint()).toEqual({ ok: true });
      }
      expect(await mintGate.admitMint()).toMatchObject({
        ok: false,
        refused: "rate_limited",
      });
    });
  });

  test("enforces anonymous and free daily relay limits but skips go/pro", async () => {
    await withClock(20_000_000, async (clock) => {
      const anonymous = networkGate();
      for (let batch = 0; batch < 4; batch += 1) {
        for (let index = 0; index < 250; index += 1) {
          expect(
            await anonymous.admitRelay({
              audience: "anonymous",
              capShare: 1,
            }),
          ).toEqual({ ok: true });
        }
        clock.now += 61 * 60_000;
      }
      expect(
        await anonymous.admitRelay({ audience: "anonymous", capShare: 1 }),
      ).toMatchObject({ ok: false, refused: "rate_limited" });

      const free = networkGate();
      for (
        let index = 0;
        index < GATEWAY_NETWORK_LIMITS.free.relayPerDay;
        index += 1
      ) {
        expect(
          await free.admitRelay({ audience: "free", capShare: 1 }),
        ).toEqual({ ok: true });
      }
      expect(
        await free.admitRelay({ audience: "free", capShare: 1 }),
      ).toMatchObject({ ok: false, refused: "rate_limited" });
      for (const audience of ["go", "go_fallback", "pro"] as const) {
        expect(await free.admitRelay({ audience, capShare: 1 })).toEqual({
          ok: true,
        });
      }
    });
  });

  test("applies a cap share to free relay traffic", async () => {
    const gate = networkGate();
    const limit = GATEWAY_NETWORK_LIMITS.free.relayPerDay / 2;
    for (let index = 0; index < limit; index += 1) {
      expect(
        await gate.admitRelay({ audience: "free", capShare: 0.5 }),
      ).toEqual({ ok: true });
    }
    expect(
      await gate.admitRelay({ audience: "free", capShare: 0.5 }),
    ).toMatchObject({ ok: false, refused: "rate_limited" });
  });
});

describe("TierBudget", () => {
  test("reserves rolling buckets and settles estimate to actual", async () => {
    const gate = tierBudget();
    const minute = 100;
    expect(
      await gate.reserve({
        estimateMicroCents: 400,
        hourlyCeiling: 1_000,
        dailyCeiling: 10_000,
        now: minute * 60_000,
      }),
    ).toEqual({ ok: true, minute });
    await gate.settle({
      estimateMicroCents: 400,
      actualMicroCents: 250,
      minute,
    });
    expect(await gate.snapshot()).toEqual([{ minute, microCents: 250 }]);
    expect(
      await gate.reserve({
        estimateMicroCents: 800,
        hourlyCeiling: 1_000,
        dailyCeiling: 10_000,
        now: (minute + 1) * 60_000,
      }),
    ).toEqual({
      ok: false,
      refused: "hourly",
      resetAt: (minute + 60) * 60_000,
    });
  });

  test("uses the supplied daily ceiling and treats -1 as unlimited", async () => {
    const gate = tierBudget();
    expect(
      await gate.reserve({
        estimateMicroCents: 700,
        hourlyCeiling: -1,
        dailyCeiling: 1_000,
        now: 10 * 60_000,
      }),
    ).toEqual({ ok: true, minute: 10 });
    expect(
      await gate.reserve({
        estimateMicroCents: 400,
        hourlyCeiling: -1,
        dailyCeiling: 1_000,
        now: 20 * 60_000,
      }),
    ).toEqual({
      ok: false,
      refused: "daily",
      resetAt: (10 + 1_440) * 60_000,
    });
    expect(
      await gate.reserve({
        estimateMicroCents: 400,
        hourlyCeiling: -1,
        dailyCeiling: -1,
        now: 20 * 60_000,
      }),
    ).toEqual({ ok: true, minute: 20 });
  });

  test("rate-limits breaker webhooks per window", async () => {
    const originalFetch = globalThis.fetch;
    const alerts: unknown[] = [];
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      alerts.push(JSON.parse(String(init?.body)) as unknown);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      const gate = new TierBudget(
        createDurableObjectState("anonymous") as never,
        { ALERT_WEBHOOK_URL: "https://alerts.test/hook" } as never,
      );
      await gate.reserve({
        estimateMicroCents: 100,
        hourlyCeiling: 100,
        dailyCeiling: -1,
        now: 1_000_000,
      });
      await gate.reserve({
        estimateMicroCents: 1,
        hourlyCeiling: 100,
        dailyCeiling: -1,
        now: 1_000_001,
      });
      await gate.reserve({
        estimateMicroCents: 1,
        hourlyCeiling: 100,
        dailyCeiling: -1,
        now: 1_001_000,
      });
      expect(alerts).toHaveLength(1);
      await gate.reserve({
        estimateMicroCents: 1,
        hourlyCeiling: 100,
        dailyCeiling: -1,
        now: 1_300_002,
      });
      expect(alerts).toHaveLength(2);
      expect(alerts[0]).toEqual({
        text: JSON.stringify({
          source: "model-gateway",
          audience: "anonymous",
          window: "hourly",
          resetAt: 4_560_000,
        }),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// owner-relay-v2 capabilities account on the owner gate's own SQL ledger.
describe("OwnerRelayGate colocated accounting", () => {
  const args = (jti: string, requestId = "same-request-id") => ({
    jti,
    requestId,
    budgetMicroCents: 1000,
    estimatedMicroCents: 400,
    maxRequests: 2,
    expiresAt: Date.now() + 3600000,
  });
  const settle = (jti: string, body = jti) => ({
    jti,
    requestId: "same-request-id",
    chargedMicroCents: 200,
    refundRequest: false,
    result: { status: 200, body },
  });

  test("owner-wide concurrency spans generations and capabilities, without reserving denied requests", async () => {
    const state = createDurableObjectState("owner");
    const gate = new OwnerRelayGate(state as never, {} as never);
    const reserve = (i: number) => gate.admitAndReserve({
      audience: "pro", requestId: "same-id", throttled: false,
      generation: `generation-${i}`, reservation: args(`jti-${i}`, "same-id"),
    });
    const outcomes = await Promise.all(Array.from({ length: 9 }, (_, i) => reserve(i)));
    expect(outcomes.filter(r => r.admission.ok)).toHaveLength(8);
    expect(outcomes[8]).toMatchObject({ admission: { ok: false, refused: "concurrency_limit" } });
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM ledger").one()).toEqual({ count: 8 });
    expect((await reserve(0)).reservation).toEqual({ kind: "in_flight" });
    const restarted = new OwnerRelayGate(state as never, {} as never);
    expect((await restarted.admitAndReserve({ audience: "pro", requestId: "same-id", throttled: false,
      generation: "generation-0", reservation: args("jti-0", "same-id") })).reservation).toEqual({ kind: "in_flight" });
  });

  test("budget denial releases only its own admission, and duplicate settlement charges once", async () => {
    const state = createDurableObjectState("owner");
    const gate = new OwnerRelayGate(state as never, {} as never);
    const input = { audience: "pro" as const, requestId: "same-request-id", throttled: false, generation: "g", reservation: args("a") };
    expect((await gate.admitAndReserve(input)).reservation?.kind).toBe("reserved");
    expect((await gate.admitAndReserve({ ...input, requestId: "denied", reservation: { ...args("a", "denied"), estimatedMicroCents: 900 } })).reservation?.kind).toBe("budget_exhausted");
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM in_flight").one()).toEqual({ count: 1 });
    await Promise.all([gate.settleCapability({ ...settle("a"), generation: "g" }), gate.settleCapability({ ...settle("a"), generation: "g" })]);
    expect(state.storage.sql.exec("SELECT spent, reserved, requests FROM ledger").one()).toEqual({ spent: 200, reserved: 0, requests: 1 });
    await gate.releaseRelay(JSON.stringify(["g", "a", input.requestId]));
    expect((await gate.admitAndReserve(input)).reservation).toEqual({ kind: "replay", status: 200, body: "a" });
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM in_flight").one()).toEqual({ count: 0 });
  });
});
