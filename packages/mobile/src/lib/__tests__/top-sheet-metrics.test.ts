import { describe, expect, test } from "bun:test";

import {
  TOP_SHEET_HEIGHT_FRACTION,
  topSheetMaxHeight,
} from "../top-sheet-metrics";

// The top sheets (artifact viewer, computer device sheet) must stay capped at
// 0.8 of the screen so a dismiss band remains at the BOTTOM of the screen.
describe("top sheet height", () => {
  test("sheet caps at partial height (0.8), never full screen", () => {
    expect(TOP_SHEET_HEIGHT_FRACTION).toBe(0.8);
  });

  test("default sizing leaves a dismissable gap below the sheet", () => {
    const windowHeight = 852; // iPhone 15 points
    const sheetHeight = topSheetMaxHeight(windowHeight);
    expect(sheetHeight).toBe(682);
    expect(sheetHeight).toBeLessThan(windowHeight);
    // At least ~15% of the screen stays open scrim below the sheet.
    expect(windowHeight - sheetHeight).toBeGreaterThan(windowHeight * 0.15);
  });

  test("explicit fraction override still applies", () => {
    expect(topSheetMaxHeight(1000, 0.5)).toBe(500);
  });
});
