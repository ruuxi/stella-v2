import { describe, expect, test } from "bun:test";
import { GATEWAY_OWNER_ENFORCEMENT_PATH } from "@stella/contracts/gateway/api";
import { ownerEnforcementAdmission } from "../src/owner-enforcement.js";
import { handleRequest } from "../src/router.js";
import {
  createFetchMock,
  createTestEnv,
  fakeExecutionContext,
  readError,
  SERVICE_SECRET,
} from "./helpers/env.js";

const enforcementRequest = (body: unknown, secret = SERVICE_SECRET) =>
  new Request(`https://gateway.test${GATEWAY_OWNER_ENFORCEMENT_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

describe("POST /internal/owners/enforcement", () => {
  test("writes the compact KV record until the requested expiry", async () => {
    const now = 1_000_000;
    const harness = createTestEnv();
    const response = await handleRequest(
      enforcementRequest({
        ownerId: "owner-1",
        enforcement: {
          status: "suspended",
          until: now + 120_000,
          reason: "chargeback",
        },
        updatedAt: now - 1,
      }),
      harness.env,
      fakeExecutionContext(),
      harness.deps(createFetchMock().fetch, () => now),
    );
    expect(response.status).toBe(200);
    expect(harness.enforcementCalls.at(-1)).toEqual({
      kind: "put",
      key: "owner-1",
      value: JSON.stringify({
        status: "suspended",
        until: now + 120_000,
        updatedAt: now - 1,
      }),
      expirationTtl: 120,
    });
    expect(
      await ownerEnforcementAdmission(harness.env, "owner-1", now),
    ).toEqual({ suspended: true, throttled: false });
    expect(harness.enforcementCalls.at(-1)).toEqual({
      kind: "get",
      key: "owner-1",
      cacheTtl: 60,
    });
  });

  test("stores indefinite statuses for seven days and deletes ok status", async () => {
    const harness = createTestEnv();
    const run = (body: unknown) =>
      handleRequest(
        enforcementRequest(body),
        harness.env,
        fakeExecutionContext(),
        harness.deps(createFetchMock().fetch, () => 2_000_000),
      );
    expect(
      (
        await run({
          ownerId: "owner-2",
          enforcement: { status: "throttled" },
          updatedAt: 2_000_000,
        })
      ).status,
    ).toBe(200);
    expect(harness.enforcementCalls.at(-1)).toMatchObject({
      kind: "put",
      expirationTtl: 7 * 24 * 60 * 60,
    });
    expect(
      await ownerEnforcementAdmission(harness.env, "owner-2", 2_000_000),
    ).toEqual({ suspended: false, throttled: true });
    expect(
      (
        await run({
          ownerId: "owner-2",
          enforcement: { status: "ok" },
          updatedAt: 2_000_001,
        })
      ).status,
    ).toBe(200);
    expect(harness.enforcementValues.has("owner-2")).toBe(false);
    expect(harness.enforcementCalls.at(-1)).toEqual({
      kind: "delete",
      key: "owner-2",
    });
  });

  test("rejects the wrong service bearer and malformed bodies", async () => {
    const harness = createTestEnv();
    const run = (request: Request) =>
      handleRequest(
        request,
        harness.env,
        fakeExecutionContext(),
        harness.deps(createFetchMock().fetch),
      );
    const unauthorized = await run(
      enforcementRequest(
        {
          ownerId: "owner-1",
          enforcement: { status: "suspended" },
          updatedAt: 1,
        },
        "wrong",
      ),
    );
    expect(unauthorized.status).toBe(401);
    expect((await readError(unauthorized)).error.code).toBe("unauthorized");
    const malformed = await run(
      enforcementRequest({
        ownerId: "owner-1",
        enforcement: { status: "made-up" },
        updatedAt: 1,
      }),
    );
    expect(malformed.status).toBe(400);
    expect((await readError(malformed)).error.code).toBe("bad_request");
    expect(harness.enforcementCalls).toHaveLength(0);
  });
});
