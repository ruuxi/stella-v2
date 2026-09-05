import { describe, expect, test } from "bun:test";
import {
  createTestEnv,
  OWNER_ID,
  signSession,
  signTurn,
} from "./helpers/env.js";

const { ModelGatewayControl } = await import("../src/model-gateway-control.js");

const controlFor = (env: Env): InstanceType<typeof ModelGatewayControl> =>
  new ModelGatewayControl({} as never, env);

describe("ModelGatewayControl", () => {
  test("prepares only the owner relay's read caches without inference or accounting", async () => {
    const harness = createTestEnv();
    const calls: string[] = [];
    (harness.env as unknown as { OWNER_RELAY_GATE: unknown }).OWNER_RELAY_GATE = {
      idFromName: (ownerId: string) => ({ ownerId }),
      get: (_id: { ownerId: string }) => ({
        prepare: async (ownerId: string) => {
          calls.push(ownerId);
        },
      }),
    };
    const control = controlFor(harness.env);

    await control.prepareOwner({ ownerId: OWNER_ID });

    expect(calls).toEqual([OWNER_ID]);
    expect(harness.ownerGate.objects.size).toBe(0);
    expect(harness.usageEvents).toHaveLength(0);
    expect(harness.ledger.objects.size).toBe(0);
    expect(harness.ownerLedger.objects.size).toBe(0);
    expect(harness.tierBudget.objects.size).toBe(0);
  });

  test("rejects malformed owner preparation requests", async () => {
    const control = controlFor(createTestEnv().env);
    for (const args of [{ ownerId: "" }, { ownerId: "x".repeat(513) }, null]) {
      await expect(control.prepareOwner(args as never)).rejects.toMatchObject({
        status: 400,
        code: "bad_request",
      });
    }
  });

  test("authenticates a turn capability and records cancellation in its owner object", async () => {
    const harness = createTestEnv();
    const control = controlFor(harness.env);
    const { token, claims } = await signTurn({ ledgerScope: "owner-relay-v2" });
    if (!claims.turn) throw new Error("expected turn binding");
    expect(await control.cancelManagedRequest({
      capability: token,
      requestId: "req-control-cancel",
    })).toEqual({ canceled: true });
    const owner = harness.ownerGate.namespace.get(
      harness.ownerGate.namespace.idFromName(OWNER_ID),
    );
    expect(owner.beginManagedRequest({
      ownerId: claims.sub,
      ownerGeneration: claims.gen,
      capabilityId: claims.jti,
      requestId: "req-control-cancel",
      turnId: claims.turn.turnId,
      conversationId: claims.turn.conversationId,
      expiresAt: claims.exp * 1_000,
    })).toEqual({ canceled: true });
  });

  test("refuses session, native, legacy, and malformed cancellation authority", async () => {
    const control = controlFor(createTestEnv().env);
    const session = await signSession();
    const native = await signTurn({ credential: "anthropic", ledgerScope: "owner-relay-v2" });
    const legacy = await signTurn({ ledgerScope: "owner-v1" });
    for (const capability of [session.token, native.token, legacy.token]) {
      await expect(control.cancelManagedRequest({
        capability,
        requestId: "req-refused",
      })).rejects.toMatchObject({ status: 403, code: "capability_invalid" });
    }
    await expect(control.cancelManagedRequest({
      capability: "not-a-capability",
      requestId: "req-refused",
    })).rejects.toMatchObject({ status: 401 });
    await expect(control.cancelManagedRequest({
      capability: legacy.token,
      requestId: "invalid request id",
    })).rejects.toMatchObject({ status: 400, code: "bad_request" });
  });
});
