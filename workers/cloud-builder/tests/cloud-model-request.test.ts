import { describe, expect, it } from "bun:test";
import { cloudModelRequestId } from "../src/cloud-model-request.js";

describe("cloud model logical request id", () => {
  it("is deterministic from turn identity and independent of prompt bytes", async () => {
    const first = await cloudModelRequestId("turn-logical-1");
    const retry = await cloudModelRequestId("turn-logical-1");
    const nextTurn = await cloudModelRequestId("turn-logical-2");

    expect(first).toMatch(/^cloud-model:[a-f0-9]{64}$/u);
    expect(retry).toBe(first);
    expect(nextTurn).not.toBe(first);
  });

  it("rejects an empty turn identity", async () => {
    await expect(cloudModelRequestId("   ")).rejects.toThrow(/turn id/iu);
  });
});
