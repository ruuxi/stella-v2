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

const openWithCss = fs.readFileSync(
  path.join(SOURCE_ROOT, "app/chat/open-with-menu.css"),
  "utf8",
);

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

    expect(chevron).toMatch(/transition:.*color/);
    const hover = blockFor(
      openWithCss,
      ".open-with-menu__trigger--chevron:hover",
    );
    expect(hover).toContain("color: var(--text-strong)");
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
