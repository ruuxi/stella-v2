import { describe, expect, test } from "bun:test";
import {
  GATEWAY_RESULT_CACHE_TTL_MS,
  GATEWAY_UPSTREAM_MAX_DURATION_MS,
} from "@stella/contracts/gateway/api";
import { GATEWAY_BUDGET_UNLIMITED } from "@stella/contracts/gateway/capability";
import { createDurableObjectState, CapabilityLedger } from "./helpers/env.js";

const newLedger = () => {
  const state = createDurableObjectState("jti-1");
  const ledger = new CapabilityLedger(state as never, {} as never);
  return { state, ledger };
};

const expiresAt = Date.now() + 60 * 60_000;

describe("CapabilityLedger", () => {
  test("reserves, settles, and reports remaining budget", async () => {
    const { state, ledger } = newLedger();
    const first = await ledger.reserve({
      jti: "jti-1",
      budgetMicroCents: 1_000,
      expiresAt,
      requestId: "req-1",
      estimatedMicroCents: 400,
    });
    expect(first).toEqual({ kind: "reserved", remainingMicroCents: 600 });
    expect(await ledger.snapshot()).toMatchObject({
      reservedMicroCents: 400,
      spentMicroCents: 0,
      requests: 1,
    });
    expect(state.alarmAt()).toBe(expiresAt + GATEWAY_RESULT_CACHE_TTL_MS);

    const settled = await ledger.settle({
      requestId: "req-1",
      chargedMicroCents: 250,
      refundRequest: false,
      result: { status: 200, body: '{"ok":true}' },
    });
    expect(settled).toEqual({
      ok: true,
      spentMicroCents: 250,
      reservedMicroCents: 0,
      cached: true,
    });
    expect(await ledger.replay({ requestId: "req-1" })).toEqual({
      status: 200,
      body: '{"ok":true}',
    });
  });

  test("refuses when the reservation would exceed the budget", async () => {
    const { ledger } = newLedger();
    await ledger.reserve({
      jti: "jti-1",
      budgetMicroCents: 1_000,
      expiresAt,
      requestId: "a",
      estimatedMicroCents: 700,
    });
    const refused = await ledger.reserve({
      jti: "jti-1",
      budgetMicroCents: 1_000,
      expiresAt,
      requestId: "b",
      estimatedMicroCents: 400,
    });
    expect(refused).toEqual({
      kind: "budget_exhausted",
      remainingMicroCents: 300,
    });
    // Settling below the estimate frees room for the next request.
    await ledger.settle({
      requestId: "a",
      chargedMicroCents: 100,
      refundRequest: false,
    });
    const retried = await ledger.reserve({
      jti: "jti-1",
      budgetMicroCents: 1_000,
      expiresAt,
      requestId: "b",
      estimatedMicroCents: 400,
    });
    expect(retried).toEqual({ kind: "reserved", remainingMicroCents: 500 });
  });

  test("an unlimited budget never refuses on money", async () => {
    const { ledger } = newLedger();
    for (let index = 0; index < 5; index += 1) {
      const result = await ledger.reserve({
        jti: "jti-1",
        budgetMicroCents: GATEWAY_BUDGET_UNLIMITED,
        expiresAt,
        requestId: `req-${index}`,
        estimatedMicroCents: 1_000_000_000,
      });
      expect(result).toEqual({ kind: "reserved", remainingMicroCents: null });
    }
  });

  test("enforces maxRequests after completed requests", async () => {
    const { ledger } = newLedger();
    const args = {
      jti: "jti-1",
      budgetMicroCents: GATEWAY_BUDGET_UNLIMITED,
      maxRequests: 2,
      expiresAt,
      estimatedMicroCents: 1,
    };
    expect((await ledger.reserve({ ...args, requestId: "1" })).kind).toBe(
      "reserved",
    );
    await ledger.settle({
      requestId: "1",
      chargedMicroCents: 0,
      refundRequest: false,
    });
    expect((await ledger.reserve({ ...args, requestId: "2" })).kind).toBe(
      "reserved",
    );
    expect(await ledger.reserve({ ...args, requestId: "3" })).toEqual({
      kind: "request_limit",
      maxRequests: 2,
    });
  });

  test("refunds the request count when settlement says no upstream byte arrived", async () => {
    const { ledger } = newLedger();
    const args = {
      jti: "jti-1",
      budgetMicroCents: GATEWAY_BUDGET_UNLIMITED,
      maxRequests: 1,
      expiresAt,
      estimatedMicroCents: 1,
    };
    expect((await ledger.reserve({ ...args, requestId: "failed" })).kind).toBe(
      "reserved",
    );
    await ledger.settle({
      requestId: "failed",
      chargedMicroCents: 0,
      refundRequest: true,
    });
    expect(await ledger.snapshot()).toMatchObject({ requests: 0 });
    expect((await ledger.reserve({ ...args, requestId: "retry" })).kind).toBe(
      "reserved",
    );
  });

  test("a known settled request id replays; a known in-flight id reports in_flight", async () => {
    const { ledger } = newLedger();
    const args = {
      jti: "jti-1",
      budgetMicroCents: 5_000,
      expiresAt,
      requestId: "same",
      estimatedMicroCents: 100,
    };
    expect((await ledger.reserve(args)).kind).toBe("reserved");
    expect(await ledger.reserve(args)).toEqual({ kind: "in_flight" });
    await ledger.settle({
      requestId: "same",
      chargedMicroCents: 50,
      refundRequest: false,
      result: { status: 200, body: "{}" },
    });
    expect(await ledger.reserve(args)).toEqual({
      kind: "replay",
      status: 200,
      body: "{}",
    });
    // Replays never touch the ledger.
    expect(await ledger.snapshot()).toMatchObject({
      requests: 1,
      spentMicroCents: 50,
      reservedMicroCents: 0,
    });
  });

  test("an abandoned in-flight reservation is released and re-run without a second request count", async () => {
    const { ledger } = newLedger();
    const args = {
      jti: "jti-1",
      budgetMicroCents: 1_000,
      maxRequests: 1,
      expiresAt,
      requestId: "orphan",
      estimatedMicroCents: 400,
    };
    expect((await ledger.reserve(args)).kind).toBe("reserved");
    expect(await ledger.reserve(args)).toEqual({ kind: "in_flight" });
    // Simulate the reserving isolate dying: age the pending row past the
    // abandonment window without settling it.
    const state = (
      ledger as unknown as {
        ctx: {
          storage: { sql: { exec: (q: string, ...b: unknown[]) => unknown } };
        };
      }
    ).ctx;
    state.storage.sql.exec(
      "UPDATE results SET created_at = ? WHERE request_id = ?",
      // Mirrors IN_FLIGHT_ABANDON_AFTER_MS in src/ledger.ts (the module is
      // loaded through the helper's cloudflare:workers mock, so the constant
      // is restated here rather than imported before the mock is installed).
      Date.now() - (GATEWAY_UPSTREAM_MAX_DURATION_MS + 60_000) - 1,
      "orphan",
    );
    const again = await ledger.reserve(args);
    expect(again).toEqual({ kind: "reserved", remainingMicroCents: 600 });
    expect(await ledger.snapshot()).toMatchObject({
      reservedMicroCents: 400,
      spentMicroCents: 0,
      requests: 1,
    });
    await ledger.settle({
      requestId: "orphan",
      chargedMicroCents: 100,
      refundRequest: false,
      result: { status: 200, body: "{}" },
    });
    expect(await ledger.snapshot()).toMatchObject({
      reservedMicroCents: 0,
      spentMicroCents: 100,
      requests: 1,
    });
  });

  test("a failed settle drops the row so a retry with the same id executes again", async () => {
    const { ledger } = newLedger();
    const args = {
      jti: "jti-1",
      budgetMicroCents: 5_000,
      expiresAt,
      requestId: "retry",
      estimatedMicroCents: 100,
    };
    await ledger.reserve(args);
    await ledger.settle({
      requestId: "retry",
      chargedMicroCents: 0,
      refundRequest: false,
    });
    expect(await ledger.replay({ requestId: "retry" })).toBeNull();
    expect((await ledger.reserve(args)).kind).toBe("reserved");
  });

  test("settle is idempotent and ignores unknown request ids", async () => {
    const { ledger } = newLedger();
    await ledger.reserve({
      jti: "jti-1",
      budgetMicroCents: 5_000,
      expiresAt,
      requestId: "x",
      estimatedMicroCents: 100,
    });
    await ledger.settle({
      requestId: "x",
      chargedMicroCents: 40,
      refundRequest: false,
      result: { status: 200, body: "{}" },
    });
    expect(
      (
        await ledger.settle({
          requestId: "x",
          chargedMicroCents: 40,
          refundRequest: false,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await ledger.settle({
          requestId: "nope",
          chargedMicroCents: 40,
          refundRequest: false,
        })
      ).ok,
    ).toBe(false);
    expect(await ledger.snapshot()).toMatchObject({ spentMicroCents: 40 });
  });

  test("the alarm wipes the ledger and its results", async () => {
    const { state, ledger } = newLedger();
    await ledger.reserve({
      jti: "jti-1",
      budgetMicroCents: 5_000,
      expiresAt,
      requestId: "x",
      estimatedMicroCents: 100,
    });
    await ledger.settle({
      requestId: "x",
      chargedMicroCents: 40,
      refundRequest: false,
      result: { status: 200, body: "{}" },
    });
    await ledger.alarm();
    expect(await ledger.snapshot()).toBeNull();
    expect(await ledger.replay({ requestId: "x" })).toBeNull();
    expect(state.alarmAt()).toBeNull();
  });
});
