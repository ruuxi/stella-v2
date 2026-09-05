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

// The new scope uses the same SQL ledger implementation inside the owner gate.
describe("colocated owner admission", () => {
  test("owner-wide concurrency spans generations and capabilities, without reserving denied requests", async () => {
    const { OwnerRelayGate } = await import("./helpers/env.js");
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
    const { OwnerRelayGate } = await import("./helpers/env.js");
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
