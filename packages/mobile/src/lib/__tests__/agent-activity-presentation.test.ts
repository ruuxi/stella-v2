import { describe, expect, test } from "bun:test";
import {
  AGENT_ACTIVITY_INK,
  FILE_PILL_CAP,
  deriveAgentActivityRow,
  deriveFilePillRow,
} from "../agent-activity-presentation";

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

    expect(Object.keys(row).sort()).toEqual(["glyph", "title", "working"]);
  });
});

describe("deriveFilePillRow", () => {
  const files = (count: number) =>
    Array.from({ length: count }, (_, index) => `file-${index}`);

  test("shows every produced file up to the cap with no overflow chip", () => {
    const row = deriveFilePillRow(files(FILE_PILL_CAP), false);
    expect(row.visible).toHaveLength(FILE_PILL_CAP);
    expect(row.hiddenCount).toBe(0);
  });

  test("caps at FILE_PILL_CAP and reports the +N more overflow", () => {
    const row = deriveFilePillRow(files(8), false);
    expect(row.visible).toEqual(files(FILE_PILL_CAP));
    expect(row.hiddenCount).toBe(8 - FILE_PILL_CAP);
  });

  test("expanding reveals the full list and clears the overflow chip", () => {
    const row = deriveFilePillRow(files(8), true);
    expect(row.visible).toHaveLength(8);
    expect(row.hiddenCount).toBe(0);
  });

  test("keeps the pre-redesign cap of 5 chips (desktop PILL_CAP parity)", () => {
    expect(FILE_PILL_CAP).toBe(5);
  });
});

describe("AGENT_ACTIVITY_INK (desktop refinement parity)", () => {
  test("status glyph renders solid full-strength — never the muted ink", () => {

    expect(AGENT_ACTIVITY_INK.glyphInk).toBe("textStrong");
  });

  test("settled description sits one notch above muted — readable but secondary", () => {

    expect(AGENT_ACTIVITY_INK.titleInk).toBe("text");
  });

  test("running shimmer rests at the settled title's strength", () => {

    expect(AGENT_ACTIVITY_INK.runningRestAlpha).toBe(0.8);
  });

  test("file-pill border is visible but one step below the label ink", () => {

    expect(AGENT_ACTIVITY_INK.pillBorderInk).toBe("textMuted");
  });
});
