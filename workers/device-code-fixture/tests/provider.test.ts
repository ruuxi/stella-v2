import { describe, expect, test } from "bun:test";
import { DeviceCodeFixtureProvider } from "../src/provider.js";
const requestId = "00000000-0000-4000-8000-000000000118";
const consumerId = "00000000-0000-4000-8000-000000000119";

describe("private fixture provider protocol", () => {
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
