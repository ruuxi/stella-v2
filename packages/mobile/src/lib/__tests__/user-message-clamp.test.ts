import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  USER_MESSAGE_COLLAPSE_LINES,
  USER_MESSAGE_MOBILE_FONT_SIZE_PX,
  USER_MESSAGE_MOBILE_LINE_HEIGHT,
  collapsedUserMessageMaxHeight,
  isUserMessageTruncatable,
  shouldRemeasureUserMessageWidth,
  shouldShowUserMessageToggle,
} from "../user-message-clamp";

const chatPane = readFileSync(
  resolve(__dirname, "../../components/ChatPane.tsx"),
  "utf8",
);

describe("mobile user message collapse contract", () => {
  test("clamps long user messages to four rendered lines", () => {
    expect(USER_MESSAGE_COLLAPSE_LINES).toBe(4);
    expect(chatPane).toContain("numberOfLines={clamp ? USER_MESSAGE_COLLAPSE_LINES : undefined}");
    expect(/USER_MESSAGE_COLLAPSE_LINES\s*=\s*[68]/.test(chatPane)).toBe(false);
  });

  test("keeps the mobile type contract that four lines map to 17px at 1.52", () => {
    expect(/fontSize:\s*17,/.test(chatPane)).toBe(true);
    expect(/lineHeight:\s*17 \* 1\.52,/.test(chatPane)).toBe(true);
    expect(USER_MESSAGE_MOBILE_FONT_SIZE_PX).toBe(17);
    expect(USER_MESSAGE_MOBILE_LINE_HEIGHT).toBe(1.52);
    expect(
      Math.abs(
        collapsedUserMessageMaxHeight({
          fontSizePx: USER_MESSAGE_MOBILE_FONT_SIZE_PX,
          lineHeight: USER_MESSAGE_MOBILE_LINE_HEIGHT,
        }) - 103.36,
      ) < 1e-5,
    ).toBe(true);
  });

  test("treats four exact lines as in-bounds and five as overflow", () => {
    expect(isUserMessageTruncatable(null)).toBe(false);
    expect(isUserMessageTruncatable(1)).toBe(false);
    expect(isUserMessageTruncatable(4)).toBe(false);
    expect(isUserMessageTruncatable(5)).toBe(true);
  });

  test("hides the toggle for short content and keeps it while expanded", () => {
    expect(
      shouldShowUserMessageToggle({ overflowing: false, expanded: false }),
    ).toBe(false);
    expect(
      shouldShowUserMessageToggle({ overflowing: true, expanded: false }),
    ).toBe(true);
    expect(
      shouldShowUserMessageToggle({ overflowing: false, expanded: true }),
    ).toBe(true);
  });

  test("remasures when wrap width changes, not on sub-pixel jitter", () => {
    expect(shouldRemeasureUserMessageWidth(null, 280)).toBe(false);
    expect(shouldRemeasureUserMessageWidth(280, 280.4)).toBe(false);
    expect(shouldRemeasureUserMessageWidth(280, 180)).toBe(true);
    expect(shouldRemeasureUserMessageWidth(360, 280)).toBe(true);
  });

  test("scales the four-line cap with font size so Dynamic Type stays layout-based", () => {
    expect(
      Math.abs(
        collapsedUserMessageMaxHeight({
          fontSizePx: USER_MESSAGE_MOBILE_FONT_SIZE_PX * 2,
          lineHeight: USER_MESSAGE_MOBILE_LINE_HEIGHT,
        }) - 206.72,
      ) < 1e-5,
    ).toBe(true);
  });
});
