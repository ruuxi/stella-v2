import { describe, expect, test } from "bun:test";
import type { DeviceCodeFixtureBinding } from "@stella/device-code-fixture/protocol";
import { CloudflareDeviceCodeFixtureClient } from "../src/device-code-fixture-client.js";

const origin =
  "https://stella-v2-device-code-fixture-basic-nightingale-118.lolruuxi.workers.dev";
const deviceCode = "A".repeat(43);
const requestId = "00000000-0000-4000-8000-000000000118";
const consumerId = "00000000-0000-4000-8000-000000000119";

const binding = (overrides: Partial<DeviceCodeFixtureBinding> = {}) =>
  ({
    authorize: async () => ({
      schemaVersion: 1,
      deviceCode,
      userCode: "BCDF-2345",
      verificationUri: `${origin}/activate`,
      verificationUriComplete: `${origin}/activate?user_code=BCDF-2345`,
      expiresAt: 301_000,
      intervalSeconds: 2,
    }),
    status: async () => ({ schemaVersion: 1, status: "approved" }),
    consume: async () => ({ schemaVersion: 1, outcome: "approved" }),
    ...overrides,
  }) as DeviceCodeFixtureBinding;

describe("browser gateway device-code fixture client", () => {
  test("accepts only the exact bn118 authorization projection", async () => {
    let consumeRequest: unknown;
    const client = new CloudflareDeviceCodeFixtureClient(
      binding({
        consume: async (value) => {
          consumeRequest = value;
          return { schemaVersion: 1, outcome: "approved" };
        },
      }),
      origin,
      () => 1_000,
    );
    const authorization = await client.authorize(requestId);
    expect(authorization).toMatchObject({
      schemaVersion: 1,
      userCode: "BCDF-2345",
      verificationUri: `${origin}/activate`,
      expiresAt: 301_000,
    });
    const grant = { userCode: authorization.userCode, deviceCode };
    expect((await client.status(grant)).status).toBe("approved");
    expect((await client.consume(grant, consumerId)).outcome).toBe("approved");
    expect(consumeRequest).toEqual({
      schemaVersion: 1,
      ...grant,
      consumerId,
    });
  });

  test("rejects redirects, extra secret fields, and malformed states", async () => {
    const redirected = new CloudflareDeviceCodeFixtureClient(
      binding({
        authorize: async () => ({
          ...(await binding().authorize({})),
          verificationUri: "https://attacker.invalid/activate",
        }),
      }),
      origin,
      () => 1_000,
    );
    await expect(redirected.authorize(requestId)).rejects.toThrow();

    const extra = new CloudflareDeviceCodeFixtureClient(
      binding({
        authorize: async () =>
          ({
            ...(await binding().authorize({})),
            accessToken: "must-not-cross",
          }) as never,
      }),
      origin,
      () => 1_000,
    );
    await expect(extra.authorize(requestId)).rejects.toThrow();

    const malformed = new CloudflareDeviceCodeFixtureClient(
      binding({
        status: async () => ({ schemaVersion: 1, status: "unknown" }) as never,
      }),
      origin,
      () => 1_000,
    );
    await expect(
      malformed.status({ userCode: "BCDF-2345", deviceCode }),
    ).rejects.toThrow();
    await expect(
      malformed.consume(
        { userCode: "BCDF-2345", deviceCode },
        "not-an-interaction-id",
      ),
    ).rejects.toThrow();
  });
});
