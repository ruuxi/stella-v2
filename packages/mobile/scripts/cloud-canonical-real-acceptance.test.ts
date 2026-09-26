import { describe, expect, test } from "bun:test";

import { assertBun14 } from "./cloud-canonical-real-acceptance";

describe("mobile cloud-canonical real-product harness", () => {
  test("fails closed unless the fixed harness is running on Bun 1.4", () => {
    expect(assertBun14("1.4.0")).toBe("1.4.0");
    expect(assertBun14("1.4.2+build")).toBe("1.4.2+build");
    expect(() => assertBun14("1.3.14")).toThrow("Bun 1.4.x is required");
    expect(() => assertBun14("2.0.0")).toThrow("Bun 1.4.x is required");
    expect(() => assertBun14(undefined)).toThrow("Bun 1.4.x is required");
  });

});
