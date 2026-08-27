import { describe, expect, test } from "bun:test";
import {
  consumeResponseSpacerHeight,
  resolvePostSendPlacement,
  resolvePostSendTarget,
  resolveResponseSpacerHeight,
  shouldPlaceLatestTurn,
} from "../chat-response-spacer";
import {
  USER_MESSAGE_MOBILE_FONT_SIZE_PX,
  USER_MESSAGE_MOBILE_LINE_HEIGHT,
  collapsedUserMessageMaxHeight,
} from "../user-message-clamp";

describe("chat response spacer geometry", () => {
  test("reserves two thirds of the readable viewport", () => {
    expect(
      resolveResponseSpacerHeight({
        viewportHeight: 900,
        bottomInsetPx: 120,
        minimumHeightPx: 160,
      }),
    ).toBe(640);
  });

  test("keeps at least 240px for the latest turn", () => {
    expect(
      resolveResponseSpacerHeight({
        viewportHeight: 600,
        bottomInsetPx: 80,
        minimumHeightPx: 120,
      }),
    ).toBe(360);
  });

  test("retains the surface minimum in a short viewport", () => {
    expect(
      resolveResponseSpacerHeight({
        viewportHeight: 300,
        bottomInsetPx: 120,
        minimumHeightPx: 160,
      }),
    ).toBe(160);
  });

  test("consumes the spacer one-for-one while retaining the footer floor", () => {
    expect(
      consumeResponseSpacerHeight({
        currentHeightPx: 600,
        minimumHeightPx: 44,
        distanceDeltaPx: 125,
      }),
    ).toBe(475);
    expect(
      consumeResponseSpacerHeight({
        currentHeightPx: 475,
        minimumHeightPx: 44,
        distanceDeltaPx: 500,
      }),
    ).toBe(44);
    expect(
      consumeResponseSpacerHeight({
        currentHeightPx: 475,
        minimumHeightPx: 44,
        distanceDeltaPx: -40,
      }),
    ).toBe(475);
  });

  test("frames a short user row above the response spacer", () => {
    expect(
      resolvePostSendTarget({
        rowTop: 1_000,
        rowBottom: 1_080,
        viewportHeight: 600,
        responseSpacerHeightPx: 360,
      }),
    ).toBe(840);
  });

  test("aligns a tall user row by its top", () => {
    expect(
      resolvePostSendTarget({
        rowTop: 1_000,
        rowBottom: 1_300,
        viewportHeight: 600,
        responseSpacerHeightPx: 360,
      }),
    ).toBe(1_000);
  });

  test("anchors a >4-line send to its clamped height, not the pre-clamp paint", () => {
    const viewportHeightPx = 700;
    const trailingSlackPx = 460;

    const unclampedRowHeightPx = 600;
    const clampedRowHeightPx =
      collapsedUserMessageMaxHeight({
        fontSizePx: USER_MESSAGE_MOBILE_FONT_SIZE_PX,
        lineHeight: USER_MESSAGE_MOBILE_LINE_HEIGHT,
      }) + 36;
    const preClampContentPx = 2000;
    const postClampContentPx =
      preClampContentPx - (unclampedRowHeightPx - clampedRowHeightPx);
    const postClampMaxOffsetPx = postClampContentPx - viewportHeightPx;

    const staleTargetPx = resolvePostSendPlacement({
      contentHeightPx: preClampContentPx,
      viewportHeightPx,
      trailingSlackPx,
      rowHeightPx: unclampedRowHeightPx,
    });
    expect(staleTargetPx).toBeGreaterThan(postClampMaxOffsetPx);

    const settledTargetPx = resolvePostSendPlacement({
      contentHeightPx: postClampContentPx,
      viewportHeightPx,
      trailingSlackPx,
      rowHeightPx: clampedRowHeightPx,
    });
    expect(Math.abs(settledTargetPx - postClampMaxOffsetPx) < 1e-5).toBe(true);
  });

  test("anchoring against the keyboard-down inset stays within the settled content", () => {
    const viewportHeightPx = 600;
    const keyboardExtraPx = 280;
    const restingInsetPx = 148;
    const inflatedInsetPx = restingInsetPx + keyboardExtraPx;
    const messagesHeightPx = 1200;
    const rowHeightPx = 80;

    const inflatedSpacerPx = resolveResponseSpacerHeight({
      viewportHeight: viewportHeightPx,
      bottomInsetPx: inflatedInsetPx,
      minimumHeightPx: inflatedInsetPx,
    });
    const restingSpacerPx = resolveResponseSpacerHeight({
      viewportHeight: viewportHeightPx,
      bottomInsetPx: restingInsetPx,
      minimumHeightPx: restingInsetPx,
    });

    const inflatedContentPx = messagesHeightPx + inflatedSpacerPx;
    const restingContentPx = messagesHeightPx + restingSpacerPx;
    const restingMaxOffsetPx = restingContentPx - viewportHeightPx;

    const inflatedTargetPx = resolvePostSendPlacement({
      contentHeightPx: inflatedContentPx,
      viewportHeightPx,
      trailingSlackPx: inflatedSpacerPx,
      rowHeightPx,
    });
    expect(inflatedTargetPx).toBeGreaterThan(restingMaxOffsetPx);

    const restingTargetPx = resolvePostSendPlacement({
      contentHeightPx: restingContentPx,
      viewportHeightPx,
      trailingSlackPx: restingSpacerPx,
      rowHeightPx,
    });
    expect(restingTargetPx).toBe(restingMaxOffsetPx);
  });

  test("does not pull a submit out of scrollback", () => {
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
