import { describe, expect, test } from "bun:test";
import { DeviceCodeFixtureProvider } from "../src/provider.js";
import {
  applyPublicDecision,
  consumeGrant,
  readGrantStatus,
  type AuthorizationState,
} from "../src/state-machine.js";

const requestId = "00000000-0000-4000-8000-000000000118";
const consumerId = "00000000-0000-4000-8000-000000000119";
const otherConsumerId = "00000000-0000-4000-8000-000000000120";

describe("private fixture provider protocol", () => {
  test("returns RFC-like public fields plus one private device code", async () => {
    let now = 1_000;
    const records = new Map<string, AuthorizationState>();
    let randomCall = 0;
    const provider = new DeviceCodeFixtureProvider({
      publicOrigin:
        "https://stella-v2-device-code-fixture-basic-nightingale-118.lolruuxi.workers.dev",
      now: () => now,
      randomBytes: (length) => {
        randomCall += 1;
        return new Uint8Array(length).fill(randomCall);
      },
      authorizations: {
        getByName: (name) => ({
          create: async (input) => {
            if (records.has(name)) return { created: false };
            records.set(name, {
              schemaVersion: 1,
              userCode: input.userCode,
              deviceCodeDigest: input.deviceCodeDigest,
              status: "pending",
              createdAt: input.createdAt,
              expiresAt: input.expiresAt,
            });
            return { created: true };
          },
          status: async (digest) => {
            const result = readGrantStatus(records.get(name), digest, now);
            if (result.state) records.set(name, result.state);
            return result.response;
          },
          consume: async (digest, consumedBy) => {
            const result = consumeGrant(
              records.get(name),
              digest,
              now,
              consumedBy,
            );
            if (result.state) records.set(name, result.state);
            return result.response;
          },
        }),
      },
    });

    const authorization = await provider.authorize({
      schemaVersion: 1,
      requestId,
    });
    expect(authorization.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/u);
    expect(authorization.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(authorization.verificationUri).toBe(
      "https://stella-v2-device-code-fixture-basic-nightingale-118.lolruuxi.workers.dev/activate",
    );
    expect(authorization.expiresAt).toBe(301_000);

    const grant = {
      schemaVersion: 1,
      userCode: authorization.userCode,
      deviceCode: authorization.deviceCode,
    } as const;
    expect((await provider.status(grant)).status).toBe("authorization_pending");
    const normalized = authorization.userCode.replace("-", "");
    records.set(
      normalized,
      applyPublicDecision(records.get(normalized)!, "approve", now).state,
    );
    expect((await provider.status(grant)).status).toBe("approved");
    expect(
      (await provider.consume({ ...grant, consumerId })).outcome,
    ).toBe("approved");
    expect(
      (await provider.consume({ ...grant, consumerId })).outcome,
    ).toBe("approved");
    expect(
      (await provider.consume({ ...grant, consumerId: otherConsumerId }))
        .outcome,
    ).toBe("already_consumed");

    now = 301_001;
    expect((await provider.status(grant)).status).toBe("already_consumed");
    expect(
      (await provider.consume({ ...grant, consumerId })).outcome,
    ).toBe("approved");
  });

  test("rejects extra fields and non-HTTPS fixture origins", async () => {
    expect(
      () =>
        new DeviceCodeFixtureProvider({
          publicOrigin: "http://fixture.invalid",
          authorizations: { getByName: () => undefined as never },
        }),
    ).toThrow("invalid_public_origin");
    const provider = new DeviceCodeFixtureProvider({
      publicOrigin: "https://fixture.invalid",
      randomBytes: (length) => new Uint8Array(length).fill(3),
      authorizations: {
        getByName: () => ({
          create: async () => ({ created: true }),
          status: async () => ({ schemaVersion: 1, status: "invalid_grant" }),
          consume: async () => ({ schemaVersion: 1, outcome: "invalid_grant" }),
        }),
      },
    });
    await expect(
      provider.authorize({ schemaVersion: 1, requestId, extra: true }),
    ).rejects.toThrow("invalid_request");
    await expect(
      provider.consume({
        schemaVersion: 1,
        userCode: "BCDF-2345",
        deviceCode: "A".repeat(43),
      }),
    ).rejects.toThrow("invalid_request");
    await expect(
      provider.consume({
        schemaVersion: 1,
        userCode: "BCDF-2345",
        deviceCode: "A".repeat(43),
        consumerId,
        extra: true,
      }),
    ).rejects.toThrow("invalid_request");
  });
});
