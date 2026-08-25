import { describe, expect, it } from "vitest";

import {
  POST_SEND_TOP_MARGIN_PX,
  consumeResponseSpacerHeight,
  resolvePostSendTarget,
  resolveResponseSpacerHeight,
  shouldPlaceLatestTurn,
} from "@/shell/chat-follow-target";

describe("chat response spacer geometry", () => {
  it("reserves one half of a tall readable viewport", () => {
    expect(
      resolveResponseSpacerHeight({
        viewportHeight: 900,
        bottomInsetPx: 56,
        minimumHeightPx: 160,
      }),
    ).toBe(478);
  });

  it("keeps at least 240px for the latest turn", () => {
    expect(
      resolveResponseSpacerHeight({
        viewportHeight: 600,
        bottomInsetPx: 56,
        minimumHeightPx: 160,
      }),
    ).toBe(328);
    expect(
      resolveResponseSpacerHeight({
        viewportHeight: 600,
        bottomInsetPx: 0,
        minimumHeightPx: 120,
      }),
    ).toBe(300);
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

  it("consumes the spacer one-for-one while retaining the footer floor", () => {
    expect(
      consumeResponseSpacerHeight({
        currentHeightPx: 600,
        minimumHeightPx: 160,
        distanceDeltaPx: 125,
      }),
    ).toBe(475);
    expect(
      consumeResponseSpacerHeight({
        currentHeightPx: 475,
        minimumHeightPx: 160,
        distanceDeltaPx: 500,
      }),
    ).toBe(160);
    expect(
      consumeResponseSpacerHeight({
        currentHeightPx: 475,
        minimumHeightPx: 160,
        distanceDeltaPx: -40,
      }),
    ).toBe(475);
  });

  it("frames a short user row above the response spacer", () => {
    const viewportHeight = 900;
    const bottomInsetPx = 56;
    const responseSpacerHeightPx = resolveResponseSpacerHeight({
      viewportHeight,
      bottomInsetPx,
      minimumHeightPx: 160,
    });
    const rowBottom = 1_080;
    const target = resolvePostSendTarget({
      rowTop: 1_000,
      rowBottom,
      viewportHeight,
      responseSpacerHeightPx,
    });
    expect(rowBottom - target).toBe((viewportHeight - bottomInsetPx) / 2);
  });

  it("keeps a tall user row below the top fade", () => {
    expect(
      resolvePostSendTarget({
        rowTop: 1_000,
        rowBottom: 1_300,
        viewportHeight: 600,
        responseSpacerHeightPx: 360,
      }),
    ).toBe(1_000 - POST_SEND_TOP_MARGIN_PX);
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
