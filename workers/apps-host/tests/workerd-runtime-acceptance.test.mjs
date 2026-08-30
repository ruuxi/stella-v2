import { describe, expect, test } from "bun:test";
import { runSecurityTopologyWorkerd } from "../scripts/security-topology-workerd.mjs";

describe("production bundle in workerd", () => {
  test("uses the real service-binding and durable SQLite replay boundary", async () => {
    const result = await runSecurityTopologyWorkerd();
    expect(result).toEqual({
      engine: "workerd",
      role: "untrusted",
      firstStatus: 200,
      replayStatus: 409,
      replayAfterRestartStatus: 409,
      serviceBindingVerified: true,
      sqliteDurabilityVerified: true,
    });
  }, 120_000);
});
