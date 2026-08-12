import { describe, expect, it } from "vitest";
import { hasCompleteEmojiSpritePack } from "@/app/chat/emoji-sprites/active-emoji-pack";
import {
  buildEmojiSpriteUrl,
  getEmojiSpriteSheetCount,
  parseEmojiSpriteUrl,
} from "@/app/chat/emoji-sprites/sprite-map";

const sheetUrls = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `file:///emoji-${index}.webp`);

describe("emoji sprite packs", () => {
  it("uses a package-relative sentinel URL for markdown sprite cells", () => {
    const url = buildEmojiSpriteUrl({ sheet: 1, cell: 7 });

    expect(url).toBe("emoji-sprites/sheet-2.webp#emoji-cell=7");
    expect(url.startsWith("/")).toBe(false);
    expect(parseEmojiSpriteUrl(url)).toEqual({ sheet: 1, cell: 7 });
  });

  it("requires every bundled sheet before replacing native chat emoji", () => {
    const required = getEmojiSpriteSheetCount();

    expect(hasCompleteEmojiSpritePack(null)).toBe(false);
    expect(
      hasCompleteEmojiSpritePack({
        packId: "partial",
        sheetUrls: sheetUrls(Math.max(0, required - 1)),
      }),
    ).toBe(false);
    expect(
      hasCompleteEmojiSpritePack({
        packId: "complete",
        sheetUrls: sheetUrls(required),
      }),
    ).toBe(true);
  });
});
