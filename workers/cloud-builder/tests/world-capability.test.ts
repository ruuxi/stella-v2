import { describe, expect, test } from "bun:test";
import {
  issueWorldCapability,
  verifyWorldCapability,
  worldCapabilityFromRequest,
} from "../src/world-capability.js";

const secret = "s".repeat(32);
const name = `${"a".repeat(64)}:${"b".repeat(64)}`;

describe("world attach capability", () => {
  test("binds the world, turn, generation, and expiry", async () => {
    const capability = await issueWorldCapability({
      secret,
      worldName: name,
      turnId: "turn-1",
      attemptGeneration: 3,
      now: 1_000,
      ttlMs: 5_000,
    });
    expect(worldCapabilityFromRequest(new Request("https://builder.test", {
      headers: { authorization: `Bearer ${capability}` },
    }))).toBe(capability);
    expect(await verifyWorldCapability({ secret, capability, worldName: name, now: 5_999 })).toMatchObject({
      ok: true,
      claims: { w: name, t: "turn-1", g: 3, e: 6_000 },
    });
    expect(await verifyWorldCapability({ secret, capability, worldName: `${"c".repeat(64)}:${"d".repeat(64)}`, now: 5_999 })).toEqual({ ok: false });
    expect(await verifyWorldCapability({ secret, capability, worldName: name, now: 6_001 })).toEqual({ ok: false });
  });
});
