import { describe, expect, test } from "bun:test";
import { deriveAgentActivityRow } from "../agent-activity-presentation";

const payload = (
  overrides: Partial<Parameters<typeof deriveAgentActivityRow>[0]> = {},
) => ({
  state: "running" as const,
  title: "Research the report",
  ...overrides,
});

describe("deriveAgentActivityRow", () => {
  test("running row shimmers behind a static star — never a spinner or check", () => {
    const row = deriveAgentActivityRow(payload());
    expect(row.working).toBe(true);
    expect(row.glyph).toBe("star");
  });

  test("running follow-up keeps the star while working (shimmer carries progress)", () => {
    const row = deriveAgentActivityRow(payload({ followUp: true }));
    expect(row.working).toBe(true);
    expect(row.glyph).toBe("star");
  });

  test("settled row shows the quiet check, shimmer off", () => {
    const row = deriveAgentActivityRow(payload({ state: "done" }));
    expect(row.working).toBe(false);
    expect(row.glyph).toBe("check");
  });

  test("settled send_input follow-up shows the arrow, not the check", () => {
    const row = deriveAgentActivityRow(
      payload({ state: "done", followUp: true }),
    );
    expect(row.working).toBe(false);
    expect(row.glyph).toBe("arrow");
  });

  test("failed/canceled settles plain — no done check, no invented failure glyph", () => {
    const row = deriveAgentActivityRow(payload({ state: "done", failed: true }));
    expect(row.working).toBe(false);
    expect(row.glyph).toBe("star");
  });

  test("row face carries the task DESCRIPTION only", () => {
    const row = deriveAgentActivityRow(
      payload({ title: "Summarize the earnings call" }),
    );
    expect(row.title).toBe("Summarize the earnings call");
    // Description-only contract: the model exposes nothing but the status
    // tell and the description — no subtitle, no provider, no excerpt.
    expect(Object.keys(row).sort()).toEqual(["glyph", "title", "working"]);
  });
});
