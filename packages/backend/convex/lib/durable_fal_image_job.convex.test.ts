import { describe, expect, it } from "vitest";
import { validateDurableFalRequestInput } from "./durable_fal_image_job";

describe("durable Fal request metadata validation", () => {
  it("accepts bounded Convex-safe provider metadata", () => {
    expect(
      validateDurableFalRequestInput({
        prompt: "draw a mascot",
        image_size: { width: 1024, height: 1024 },
        image_urls: ["[redacted reference]"],
        enabled: true,
        mask: null,
      }),
    ).toEqual({
      prompt: "draw a mascot",
      image_size: { width: 1024, height: 1024 },
      image_urls: ["[redacted reference]"],
      enabled: true,
      mask: null,
    });
  });

  it("rejects malformed values and non-finite numbers", () => {
    expect(() =>
      validateDurableFalRequestInput({ invalid: undefined }),
    ).toThrow(/not Convex-safe JSON/u);
    expect(() => validateDurableFalRequestInput({ invalid: NaN })).toThrow(
      /non-finite number/u,
    );
  });

  it("rejects excessive nesting and retained metadata size", () => {
    let nested: Record<string, unknown> = { value: "bottom" };
    for (let index = 0; index < 9; index += 1) nested = { nested };
    expect(() => validateDurableFalRequestInput(nested)).toThrow(
      /nested too deeply/u,
    );
    expect(() =>
      validateDurableFalRequestInput({ value: "x".repeat(512 * 1024 + 1) }),
    ).toThrow(/too large/u);
  });
});
