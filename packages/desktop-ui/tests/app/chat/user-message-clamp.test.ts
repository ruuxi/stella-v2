import { describe, expect, it } from "vitest";
import {
  USER_MESSAGE_DESKTOP_FONT_SIZE_PX,
  USER_MESSAGE_DESKTOP_LINE_HEIGHT,
  collapsedUserMessageMaxHeight,
  isUserMessageOverflowing,
  shouldShowUserMessageToggle,
} from "@/app/chat/user-message-clamp";

describe("user message collapse contract", () => {

  it("treats four exact lines as in-bounds and five as overflow", () => {
    const fourLineHeight = collapsedUserMessageMaxHeight({
      fontSizePx: USER_MESSAGE_DESKTOP_FONT_SIZE_PX,
      lineHeight: USER_MESSAGE_DESKTOP_LINE_HEIGHT,
      maxLines: 4,
    });
    const fiveLineHeight = collapsedUserMessageMaxHeight({
      fontSizePx: USER_MESSAGE_DESKTOP_FONT_SIZE_PX,
      lineHeight: USER_MESSAGE_DESKTOP_LINE_HEIGHT,
      maxLines: 5,
    });

    expect(
      isUserMessageOverflowing({
        scrollHeight: fourLineHeight,
        clientHeight: fourLineHeight,
      }),
    ).toBe(false);
    expect(
      isUserMessageOverflowing({
        scrollHeight: fourLineHeight + 1,
        clientHeight: fourLineHeight,
      }),
    ).toBe(false);
    expect(
      isUserMessageOverflowing({
        scrollHeight: fiveLineHeight,
        clientHeight: fourLineHeight,
      }),
    ).toBe(true);
  });

  it("hides the toggle for short content and keeps it while expanded", () => {
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

  it("scales the four-line cap with font size so Unicode/AX type stays layout-based", () => {
    expect(
      collapsedUserMessageMaxHeight({
        fontSizePx: 30,
        lineHeight: USER_MESSAGE_DESKTOP_LINE_HEIGHT,
      }),
    ).toBe(180);
  });
});
