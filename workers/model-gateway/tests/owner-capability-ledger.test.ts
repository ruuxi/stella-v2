import { describe, expect, test, spyOn } from "bun:test";
import { GATEWAY_RESULT_CACHE_TTL_MS } from "@stella/contracts/gateway/api";
import { IN_FLIGHT_ABANDON_AFTER_MS } from "../src/ledger.js";
import {
  OwnerCapabilityLedger,
  createDurableObjectState,
} from "./helpers/env.js";

const setup = () => {
  const state = createDurableObjectState("owner-generation");
  const ledger = new OwnerCapabilityLedger(state as never, {} as never);
  return { state, ledger };
};
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

describe("OwnerCapabilityLedger", () => {
  test("capabilities share an object but never share budgets, counts, or replay bodies", async () => {
    const { ledger } = setup();
    await Promise.all([ledger.reserve(args("a")), ledger.reserve(args("b"))]);
    await ledger.settle(settle("a"));
    expect(await ledger.snapshot({ jti: "a" })).toMatchObject({
      spentMicroCents: 200,
      reservedMicroCents: 0,
      requests: 1,
    });
    expect(await ledger.snapshot({ jti: "b" })).toMatchObject({
      spentMicroCents: 0,
      reservedMicroCents: 400,
      requests: 1,
    });
    expect(await ledger.reserve(args("a"))).toEqual({
      kind: "replay",
      status: 200,
      body: "a",
    });
    expect(await ledger.reserve(args("b"))).toEqual({ kind: "in_flight" });
    expect(
      await ledger.replay({ jti: "b", requestId: "same-request-id" }),
    ).toBeNull();
    await ledger.settle(settle("b"));
    expect(
      await ledger.replay({ jti: "b", requestId: "same-request-id" }),
    ).toEqual({ status: 200, body: "b" });
  });
  test("concurrent duplicate admission reserves once and duplicate settlement cannot charge twice", async () => {
    const { ledger } = setup();
    const results = await Promise.all([
      ledger.reserve(args("a")),
      ledger.reserve(args("a")),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual([
      "in_flight",
      "reserved",
    ]);
    await Promise.all([ledger.settle(settle("a")), ledger.settle(settle("a"))]);
    expect(await ledger.snapshot({ jti: "a" })).toMatchObject({
      spentMicroCents: 200,
      requests: 1,
      reservedMicroCents: 0,
    });
  });
  test("budget exhaustion, request ceilings and refunds stay capability-local", async () => {
    const { ledger } = setup();
    await ledger.reserve(args("a"));
    expect(
      (
        await ledger.reserve({
          ...args("a", "other"),
          estimatedMicroCents: 700,
        })
      ).kind,
    ).toBe("budget_exhausted");
    expect(
      (await ledger.reserve({ ...args("b"), estimatedMicroCents: 700 })).kind,
    ).toBe("reserved");
    await ledger.settle({
      ...settle("a"),
      refundRequest: true,
      result: undefined,
      chargedMicroCents: 0,
    });
    expect(await ledger.snapshot({ jti: "a" })).toMatchObject({
      requests: 0,
      spentMicroCents: 0,
    });
    await ledger.reserve(args("a", "2"));
    await ledger.reserve(args("a", "3"));
    expect((await ledger.reserve(args("a", "4"))).kind).toBe("request_limit");
    expect(
      (
        await ledger.reserve({
          ...args("unlimited"),
          budgetMicroCents: -1,
          estimatedMicroCents: 9999999,
        })
      ).kind,
    ).toBe("reserved");
  });
  test("restarting retains each capability and replay identity", async () => {
    const { state, ledger } = setup();
    await ledger.reserve(args("a"));
    await ledger.settle(settle("a"));
    const restarted = new OwnerCapabilityLedger(state as never, {} as never);
    expect(await restarted.reserve(args("a"))).toEqual({
      kind: "replay",
      status: 200,
      body: "a",
    });
    expect((await restarted.reserve(args("b"))).kind).toBe("reserved");
  });
  test("expiry prunes only expired capability records and rearms for surviving rows", async () => {
    const { state, ledger } = setup();
    const a = args("a"),
      b = { ...args("b"), expiresAt: a.expiresAt + 60000 };
    await ledger.reserve(a);
    await ledger.settle(settle("a"));
    await ledger.reserve(b);
    const before = state.alarmAt();
    expect(before).toBe(a.expiresAt + GATEWAY_RESULT_CACHE_TTL_MS);
    const clock = spyOn(Date, "now").mockReturnValue(
      a.expiresAt + GATEWAY_RESULT_CACHE_TTL_MS + 1,
    );
    try {
      await ledger.alarm();
      expect(await ledger.snapshot({ jti: "a" })).toBeNull();
      expect(
        await ledger.replay({ jti: "a", requestId: a.requestId }),
      ).toBeNull();
      expect(await ledger.snapshot({ jti: "b" })).not.toBeNull();
      expect(state.alarmAt()).toBe(b.expiresAt + GATEWAY_RESULT_CACHE_TTL_MS);
    } finally {
      clock.mockRestore();
    }
  });
  test("abandoned reservations release only their capability and do not consume another request", async () => {
    const { ledger } = setup();
    const a = args("a"),
      b = args("b");
    await ledger.reserve(a);
    await ledger.reserve(b);
    const clock = spyOn(Date, "now").mockReturnValue(
      Date.now() + IN_FLIGHT_ABANDON_AFTER_MS + 10,
    );
    try {
      expect((await ledger.reserve(a)).kind).toBe("reserved");
      expect(await ledger.snapshot({ jti: "a" })).toMatchObject({
        reservedMicroCents: 400,
        requests: 1,
      });
      expect(await ledger.snapshot({ jti: "b" })).toMatchObject({
        reservedMicroCents: 400,
        requests: 1,
      });
    } finally {
      clock.mockRestore();
    }
  });
});
