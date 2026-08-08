import { describe, expect, it } from "vitest";

import {
  resolvePostSendTarget,
  resolveResponseSpacerHeight,
  shouldPlaceLatestTurn,
} from "@/shell/chat-follow-target";

describe("chat response spacer geometry", () => {
  it("reserves two thirds of a tall readable viewport", () => {
    expect(
      resolveResponseSpacerHeight({
        viewportHeight: 900,
        bottomInsetPx: 56,
        minimumHeightPx: 160,
      }),
    ).toBeCloseTo(618.6667, 3);
  });

  it("keeps at least 240px for the latest turn", () => {
    expect(
      resolveResponseSpacerHeight({
        viewportHeight: 600,
        bottomInsetPx: 56,
        minimumHeightPx: 160,
      }),
    ).toBe(360);
    expect(
      resolveResponseSpacerHeight({
        viewportHeight: 600,
        bottomInsetPx: 0,
        minimumHeightPx: 120,
      }),
    ).toBe(360);
  });

  it("retains the surface minimum in very short viewports", () => {
    expect(
      resolveResponseSpacerHeight({
        viewportHeight: 300,
        bottomInsetPx: 56,
        minimumHeightPx: 160,
      }),
    ).toBe(160);
  });

  it("frames a short user row above the response spacer", () => {
    expect(
      resolvePostSendTarget({
        rowTop: 1_000,
        rowBottom: 1_080,
        viewportHeight: 600,
        responseSpacerHeightPx: 360,
      }),
    ).toBe(840);
  });

  it("aligns a tall user row by its top", () => {
    expect(
      resolvePostSendTarget({
        rowTop: 1_000,
        rowBottom: 1_300,
        viewportHeight: 600,
        responseSpacerHeightPx: 360,
      }),
    ).toBe(1_000);
  });

  it("does not pull a submit out of scrollback", () => {
    expect(
      shouldPlaceLatestTurn({
        distanceFromBottomPx: 660,
        responseSpacerHeightPx: 360,
        isFollowingLatest: true,
      }),
    ).toBe(true);
    expect(
      shouldPlaceLatestTurn({
        distanceFromBottomPx: 661,
        responseSpacerHeightPx: 360,
        isFollowingLatest: true,
      }),
    ).toBe(false);
    expect(
      shouldPlaceLatestTurn({
        distanceFromBottomPx: 0,
        responseSpacerHeightPx: 360,
        isFollowingLatest: false,
      }),
    ).toBe(false);
  });
});
