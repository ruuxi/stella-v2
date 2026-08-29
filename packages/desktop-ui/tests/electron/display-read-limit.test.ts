import { describe, expect, it } from "vitest";
import {
  MAX_DISPLAY_FILE_BYTES,
  planDisplayFileRead,
} from "@stella/desktop/electron/ipc/display-read-limit.js";

describe("planDisplayFileRead", () => {
  it("rejects unbounded reads above the absolute cap", () => {
    const plan = planDisplayFileRead(MAX_DISPLAY_FILE_BYTES + 1, undefined);
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.error).toContain("File too large to display");
    }
  });

  it("reads a prefix when maxBytes is set, even if the file exceeds the absolute cap", () => {
    const plan = planDisplayFileRead(
      MAX_DISPLAY_FILE_BYTES + 50_000_000,
      2 * 1024 * 1024,
    );
    expect(plan).toEqual({
      ok: true,
      readBytes: 2 * 1024 * 1024,
      truncated: true,
    });
  });

  it("does not mark a short file truncated", () => {
    expect(planDisplayFileRead(128, 2 * 1024 * 1024)).toEqual({
      ok: true,
      readBytes: 128,
      truncated: false,
    });
  });

  it("caps a large-but-allowed file to the requested prefix", () => {
    expect(planDisplayFileRead(50 * 1024 * 1024, 2 * 1024 * 1024)).toEqual({
      ok: true,
      readBytes: 2 * 1024 * 1024,
      truncated: true,
    });
  });

  it("rejects a non-positive maxBytes", () => {
    const plan = planDisplayFileRead(100, 0);
    expect(plan.ok).toBe(false);
  });
});
