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

const threadCss = fs.readFileSync(
  path.join(SOURCE_ROOT, "shell/display/agent-thread-chat-tab.css"),
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

  it("keeps the muted treatment on the description title", () => {
    // Only the ICON got stronger — the shimmering/muted title is intentional.
    const title = blockFor(activityCss, ".agent-activity-row__title");
    expect(title).toContain("color: var(--text-weak)");
  });
});

describe("agent-thread transcript spacing + hover timestamp", () => {
  it("keeps the message list gap tight", () => {
    const list = blockFor(threadCss, ".agent-thread-chat__messages");
    const gap = /gap:\s*(\d+)px/.exec(list);
    expect(gap).not.toBeNull();
    expect(Number(gap![1])).toBeLessThanOrEqual(6);
  });

  it("strips the inherited block padding from chrome-less assistant items", () => {
    const item = blockFor(
      threadCss,
      ".agent-thread-chat__messages .event-item.assistant",
    );
    const padding = /padding-block:\s*(\d+)px/.exec(item);
    expect(padding).not.toBeNull();
    expect(Number(padding![1])).toBeLessThanOrEqual(4);
  });

  it("reveals the left-gutter timestamp only on row hover", () => {
    const stamp = blockFor(threadCss, ".agent-thread-chat__timestamp");
    expect(stamp).toContain("opacity: 0");
    expect(stamp).toContain("right: calc(100% + 10px)");
    const hover = blockFor(
      threadCss,
      ".agent-thread-chat__message:hover .agent-thread-chat__timestamp",
    );
    expect(hover).toContain("opacity: 1");
  });
});
