import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  USER_MESSAGE_COLLAPSE_LINES,
  USER_MESSAGE_DESKTOP_FONT_SIZE_PX,
  USER_MESSAGE_DESKTOP_LINE_HEIGHT,
  collapsedUserMessageMaxHeight,
  isUserMessageOverflowing,
  shouldShowUserMessageToggle,
} from "@/app/chat/user-message-clamp";

const chatCss = readFileSync(
  resolve(__dirname, "../../../src/app/chat/full-shell.chat.css"),
  "utf8",
);
const compactCss = readFileSync(
  resolve(__dirname, "../../../src/features/chat/compact-conversation.css"),
  "utf8",
);
const tokensCss = readFileSync(
  resolve(__dirname, "../../../src/index.css"),
  "utf8",
);

describe("user message collapse contract", () => {
  it("clamps long user messages to four rendered lines", () => {
    expect(USER_MESSAGE_COLLAPSE_LINES).toBe(4);
    expect(chatCss).toMatch(/--user-message-clamp-lines:\s*4;/);
    expect(chatCss).not.toMatch(/--user-message-clamp-lines:\s*(?:8|12);/);
    expect(compactCss).not.toMatch(/--user-message-clamp-lines:/);
  });

  it("keeps the desktop type contract that four lines map to 90px", () => {
    expect(tokensCss).toMatch(/--font-size-lg:\s*15px;/);
    expect(chatCss).toMatch(/--chat-text-size:\s*var\(--font-size-lg\);/);
    expect(chatCss).toMatch(/--chat-text-line-height:\s*1\.5;/);
    expect(USER_MESSAGE_DESKTOP_FONT_SIZE_PX).toBe(15);
    expect(USER_MESSAGE_DESKTOP_LINE_HEIGHT).toBe(1.5);
    expect(
      collapsedUserMessageMaxHeight({
        fontSizePx: USER_MESSAGE_DESKTOP_FONT_SIZE_PX,
        lineHeight: USER_MESSAGE_DESKTOP_LINE_HEIGHT,
      }),
    ).toBe(90);
  });

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
