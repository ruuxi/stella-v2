/**
 * CSS contracts for the agent-activity row glyph and the agent-thread
 * transcript.
 *
 * 1. Glyph is SOLID: the leading status glyph (star / check / arrow) renders
 *    at full strength — strong ink, no opacity dimming. Only the description
 *    text keeps its muted/shimmer treatment. A regression that re-dims the
 *    glyph (translucent star, weak grey check) made the status tell nearly
 *    invisible.
 * 2. Agent-thread transcript reads as a tight chat: small list gap and no
 *    inherited 10px block padding on chrome-less assistant items — the old
 *    combination spaced consecutive one-line narration messages ~34px apart.
 * 3. The transcript's hover timestamp lives in the left gutter and is
 *    revealed only on row hover.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = path.resolve(__dirname, "../../../src");

const activityCss = fs.readFileSync(
  path.join(SOURCE_ROOT, "app/chat/agent-activity-row.css"),
  "utf8",
);

const openWithCss = fs.readFileSync(
  path.join(SOURCE_ROOT, "app/chat/open-with-menu.css"),
  "utf8",
);

/** Extracts the declaration block for a selector (first match). */
const blockFor = (css: string, selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  expect(start, `selector "${selector}" present`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
};

describe("agent-activity glyph is solid", () => {
  it("colors the glyph slot at full strength, not muted", () => {
    const glyph = blockFor(activityCss, ".agent-activity-row__glyph");
    expect(glyph).toContain("color: var(--text-strong)");
    expect(glyph).not.toContain("--text-weak");
    expect(glyph).not.toMatch(/opacity:/);
  });

  it("applies no opacity dimming to the star glyph", () => {
    const star = blockFor(activityCss, ".agent-activity-star");
    expect(star).not.toMatch(/opacity:/);
  });

  it("keeps the description title secondary — mid-muted, not full strength", () => {
    // The title sits one step above the weakest ink (readable) but stays
    // below main-chat body strength, and matches the shimmer resting base.
    const title = blockFor(activityCss, ".agent-activity-row__title");
    expect(title).toContain("color: var(--text-base)");
    expect(title).not.toContain("color: var(--text-strong)");
    const shimmer = blockFor(
      activityCss,
      ".agent-activity-row__title .text-shimmer",
    );
    expect(shimmer).toContain("--text-shimmer-from: var(--text-base)");
  });
});

describe("agent-activity file pills", () => {
  it("outlines the pill at label-aligned strength (visible, below the text)", () => {
    const pill = blockFor(activityCss, ".agent-activity-files__pill");
    expect(pill).toContain("border: 1px solid var(--text-weaker)");
    expect(pill).not.toContain("--panel-surface-border");
  });

  it("renders the menu trigger as a bare chevron — no border, no fill", () => {
    const chevron = blockFor(openWithCss, ".open-with-menu__trigger--chevron");
    expect(chevron).toContain("border: none");
    expect(chevron).toContain("background: transparent");
    expect(chevron).toContain("box-shadow: none");
    expect(chevron).toContain("color: var(--text-weak)");
    // Quiet at rest, obviously interactive on hover.
    expect(chevron).toMatch(/transition:.*color/);
    const hover = blockFor(
      openWithCss,
      ".open-with-menu__trigger--chevron:hover",
    );
    expect(hover).toContain("color: var(--text-strong)");
  });
});

