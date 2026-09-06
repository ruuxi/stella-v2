import { describe, expect, test } from "bun:test";
import {
  consumeResponseSpacerHeight,
  resolvePostSendPlacement,
  resolvePostSendTarget,
  resolveReplyOverflow,
  resolveResponseSpacerHeight,
  shouldPlaceLatestTurn,
} from "../chat-response-spacer";
import {
  USER_MESSAGE_MOBILE_FONT_SIZE_PX,
  USER_MESSAGE_MOBILE_LINE_HEIGHT,
  collapsedUserMessageMaxHeight,
} from "../user-message-clamp";

describe("chat response spacer geometry", () => {
  test("short replies do not scroll merely to preserve synthetic blank space", () => {
    expect(resolveReplyOverflow({
      contentHeightPx: 844.67,
      viewportHeightPx: 766,
      responseSpacerHeightPx: 280,
    })).toBe(0);
  });

  test("growing replies consume blank room before scrolling, retaining real insets", () => {
    const viewportHeightPx = 766;
    const responseSpacerHeightPx = 280;
    expect(resolveReplyOverflow({ contentHeightPx: 1046, viewportHeightPx, responseSpacerHeightPx })).toBe(0);
    expect(resolveReplyOverflow({ contentHeightPx: 1096, viewportHeightPx, responseSpacerHeightPx })).toBe(50);
    expect(resolveReplyOverflow({ contentHeightPx: 1096, viewportHeightPx, responseSpacerHeightPx: 0 })).toBe(330);
  });

  test("reserves one half of the readable viewport", () => {
    expect(
      resolveResponseSpacerHeight({
        viewportHeight: 900,
        bottomInsetPx: 120,
        minimumHeightPx: 160,
      }),
    ).toBe(510);
  });

  test("keeps at least 240px for the latest turn", () => {
    expect(
      resolveResponseSpacerHeight({
        viewportHeight: 600,
        bottomInsetPx: 80,
        minimumHeightPx: 120,
      }),
    ).toBe(340);
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
    const viewportHeight = 900;
    const bottomInsetPx = 120;
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

    // A long user message briefly measured tall (pre-clamp), then the
    // four-line clamp collapses the row. Both the row and the list content
    // shrink by the same amount.
    const unclampedRowHeightPx = 600;
    const clampedRowHeightPx =
      collapsedUserMessageMaxHeight({
        fontSizePx: USER_MESSAGE_MOBILE_FONT_SIZE_PX,
        lineHeight: USER_MESSAGE_MOBILE_LINE_HEIGHT,
      }) + 36; // bubble padding + Show-more toggle
    const preClampContentPx = 2000;
    const postClampContentPx =
      preClampContentPx - (unclampedRowHeightPx - clampedRowHeightPx);
    const postClampMaxOffsetPx = postClampContentPx - viewportHeightPx;

    // The stale anchor (computed from the tall paint) is left past the
    // scrollable end once the row collapses — the send-scroll overshoot.
    const staleTargetPx = resolvePostSendPlacement({
      contentHeightPx: preClampContentPx,
      viewportHeightPx,
      trailingSlackPx,
      rowHeightPx: unclampedRowHeightPx,
    });
    expect(staleTargetPx).toBeGreaterThan(postClampMaxOffsetPx);

    // Re-running placement against the settled (clamped) geometry lands the
    // row exactly above the response spacer, within the scrollable range.
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
    // Content = messages + bottom padding (inset) + response spacer beyond it.
    const inflatedContentPx = messagesHeightPx + inflatedSpacerPx;
    const restingContentPx = messagesHeightPx + restingSpacerPx;
    const restingMaxOffsetPx = restingContentPx - viewportHeightPx;

    // Computing against the keyboard-inflated inset leaves the committed
    // target past the content end once the padding collapses.
    const inflatedTargetPx = resolvePostSendPlacement({
      contentHeightPx: inflatedContentPx,
      viewportHeightPx,
      trailingSlackPx: inflatedSpacerPx,
      rowHeightPx,
    });
    expect(inflatedTargetPx).toBeGreaterThan(restingMaxOffsetPx);

    // Computing against the keyboard-down inset lands exactly at the settled
    // content end (short row above the spacer).
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
