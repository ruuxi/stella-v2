import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TOP_SHEET_HEIGHT_FRACTION,
  topSheetMaxHeight,
} from "../top-sheet-metrics";

// Regression pins for the bottom-tab activity hub redesign, which briefly
// shipped the hub as a BOTTOM-anchored, 0.94-height sheet: essentially full
// phone height, with no open band left to tap or drag for dismissal. The hub
// must stay a TOP-anchored sheet capped at 0.8, leaving the dismiss gap at
// the BOTTOM of the screen.
describe("activity sheet anchor + height", () => {
  const activityHubSource = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../components/ActivityHubSheet.tsx",
    ),
    "utf8",
  );

  test("activity hub renders inside the top-anchored TopSheet", () => {
    expect(activityHubSource).toContain('from "./TopSheet"');
    expect(activityHubSource).toContain("<TopSheet");
  });

  test("activity hub does not use a bottom-anchored sheet container", () => {
    expect(activityHubSource.includes("BottomSheet")).toBe(false);
  });

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
