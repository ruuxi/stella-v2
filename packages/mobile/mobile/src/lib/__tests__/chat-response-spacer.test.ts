import { describe, expect, test } from "bun:test";
import {
  consumeResponseSpacerHeight,
  resolvePostSendTarget,
  resolveResponseSpacerHeight,
  shouldPlaceLatestTurn,
} from "../chat-response-spacer";

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
