import { describe, expect, test } from "bun:test";
import {
  createTestEnv,
  signSession,
  signTurn,
} from "./helpers/env.js";

const { ModelGatewayControl } = await import("../src/model-gateway-control.js");

const controlFor = (env: Env): InstanceType<typeof ModelGatewayControl> =>
  new ModelGatewayControl({} as never, env);

describe("ModelGatewayControl", () => {
  test("rejects malformed owner preparation requests", async () => {
    const control = controlFor(createTestEnv().env);
    for (const args of [{ ownerId: "" }, { ownerId: "x".repeat(513) }, null]) {
      await expect(control.prepareOwner(args as never)).rejects.toMatchObject({
        status: 400,
        code: "bad_request",
      });
    }
  });

  test("refuses session, native, unscoped, and malformed cancellation authority", async () => {
    const control = controlFor(createTestEnv().env);
    const session = await signSession();
    const native = await signTurn({
      credential: "anthropic",
      ledgerScope: "owner-relay-v2",
    });
    const unscoped = await signTurn();
    for (const capability of [session.token, native.token, unscoped.token]) {
      await expect(
        control.cancelManagedRequest({
          capability,
          requestId: "req-refused",
        }),
      ).rejects.toMatchObject({ status: 403, code: "capability_invalid" });
    }
    await expect(
      control.cancelManagedRequest({
        capability: "not-a-capability",
        requestId: "req-refused",
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      control.cancelManagedRequest({
        capability: unscoped.token,
        requestId: "invalid request id",
      }),
    ).rejects.toMatchObject({ status: 400, code: "bad_request" });
  });
});
