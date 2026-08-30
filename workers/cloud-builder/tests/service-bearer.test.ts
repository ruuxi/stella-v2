import { describe, expect, test } from "bun:test";
import {
  fixedWorkSha256SecretEqual,
  verifyServiceBearerAuthorization,
  verifyServiceBearerRequest,
  type ServiceBearerSubtleCrypto,
} from "../src/service-bearer.js";

const secret = "fixture-service-secret_123";

describe("Cloud Builder service bearer verification", () => {
  test("accepts exactly one well-formed matching Bearer credential", async () => {
    expect(
      await verifyServiceBearerAuthorization(`Bearer ${secret}`, secret),
    ).toBe(true);
    expect(
      await verifyServiceBearerRequest(
        new Request("https://builder.example/internal", {
          headers: { authorization: `bearer ${secret}` },
        }),
        secret,
      ),
    ).toBe(true);
  });

  test("fails closed for absent, empty, malformed, oversized, or mismatched auth", async () => {
    const rejected = [
      null,
      "",
      "Bearer",
      "Bearer ",
      "Bearer  token",
      "Bearer token trailing",
      "Basic token",
      "Bearer token, Bearer second",
      "Bearer token\n",
      `Bearer ${"a".repeat(8_193)}`,
      "Bearer wrong-service-secret",
    ];
    for (const authorization of rejected) {
      expect(
        await verifyServiceBearerAuthorization(authorization, secret),
      ).toBe(false);
    }
    for (const expected of [null, undefined, "", "contains whitespace"]) {
      expect(
        await verifyServiceBearerAuthorization(`Bearer ${secret}`, expected),
      ).toBe(false);
    }
  });

  test("does two hashes and one fixed-length comparison across a length mismatch", async () => {
    const observed: {
      digests: number;
      comparisons: number;
      lengths: number[];
    } = {
      digests: 0,
      comparisons: 0,
      lengths: [],
    };
    const nativeSubtle = crypto.subtle;
    const subtle: ServiceBearerSubtleCrypto = {
      async digest(algorithm, data) {
        observed.digests += 1;
        return await nativeSubtle.digest(algorithm, data);
      },
      timingSafeEqual(left, right) {
        observed.comparisons += 1;
        const leftBytes = new Uint8Array(
          ArrayBuffer.isView(left) ? left.buffer : left,
        );
        const rightBytes = new Uint8Array(
          ArrayBuffer.isView(right) ? right.buffer : right,
        );
        observed.lengths.push(leftBytes.byteLength, rightBytes.byteLength);
        return false;
      },
    };

    expect(
      await fixedWorkSha256SecretEqual("short", "materially-longer", {
        subtle,
      }),
    ).toBe(false);
    expect(observed).toEqual({
      digests: 2,
      comparisons: 1,
      lengths: [32, 32],
    });
  });
});
