import { describe, expect, test } from "bun:test";

import {
  BOTTOM_SHEET_HEIGHT_FRACTION,
  bottomSheetMaxHeight,
} from "../bottom-sheet-metrics";

describe("bottom sheet metrics", () => {
  // Regression pin for the bottom-tab activity hub redesign: the sheet
  // briefly shipped at 0.94 (full phone height), which removed the open
  // scrim band above the sheet — the tap/drag-to-dismiss affordance.
  test("sheet is partial height, matching the top sheets' 0.8 cap", () => {
    expect(BOTTOM_SHEET_HEIGHT_FRACTION).toBe(0.8);
  });

  test("default sizing leaves a dismissable gap above the sheet", () => {
    const windowHeight = 852; // iPhone 15 points
    const sheetHeight = bottomSheetMaxHeight(windowHeight);
    expect(sheetHeight).toBe(682);
    expect(sheetHeight).toBeLessThan(windowHeight);
    // At least ~15% of the screen stays open scrim above the sheet.
    expect(windowHeight - sheetHeight).toBeGreaterThan(windowHeight * 0.15);
  });

  test("explicit fraction override still applies", () => {
    expect(bottomSheetMaxHeight(1000, 0.5)).toBe(500);
  });
});
