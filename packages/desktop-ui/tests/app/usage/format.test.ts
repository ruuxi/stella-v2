import { describe, expect, it } from "vitest";
import { formatCost } from "../../../src/app/usage/format";

describe("usage formatting", () => {
  it("formats costs with sub-cent precision", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.0042)).toBe("$0.00420");
    expect(formatCost(1.2345)).toBe("$1.234");
  });
});
