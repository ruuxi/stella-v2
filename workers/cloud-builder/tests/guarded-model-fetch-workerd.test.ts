import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startWorkerdDev, type WorkerdDev } from "./helpers/workerd-dev.js";

describe("Guarded model fetch in real Workerd", () => {
  let dev: WorkerdDev;

  beforeAll(async () => {
    dev = await startWorkerdDev({
      config: "tests/fixtures/guarded-model-fetch-workerd.wrangler.jsonc",
      prefix: "stella-guarded-model-fetch-workerd-",
    });
  });

  afterAll(async () => {
    await dev?.stop();
  });

  test("routes through a service binding and owner object before releasing the body", async () => {
    const response = await fetch(`${dev.origin}/allow`);
    const report = await response.json();
    expect(report.gatewayEnteredDuringGuard).toBe(true);
    expect(report.enteredAt).toBeLessThanOrEqual(report.authorizedAt);
    expect(report.firstBodyAt).toBeGreaterThanOrEqual(report.authorizedAt);
    expect(report.result).toEqual({
      status: 201,
      body: report.expectedBody,
      header: "fixture",
    });
    expect(report.bytes).toBe(
      new TextEncoder().encode(report.expectedBody).byteLength,
    );
  });

  for (const [mode, error] of [
    ["deny", "MEMORY_POLICY_CHANGED"],
    ["cancel", "exact turn canceled"],
  ]) {
    test(`${mode} withholds all body bytes across service and object forwarding`, async () => {
      const response = await fetch(`${dev.origin}/${mode}`);
      const report = await response.json();
      expect(report.gatewayEnteredDuringGuard).toBe(true);
      expect(report.result).toEqual({ error });
      expect(report.bytes).toBe(0);
      expect(report.firstBodyAt).toBe(0);
    });
  }
});
