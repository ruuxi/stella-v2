export const TOP_SHEET_HEIGHT_FRACTION = 0.8;

export const topSheetMaxHeight = (
  windowHeight: number,
  heightFraction: number = TOP_SHEET_HEIGHT_FRACTION,
): number => Math.round(windowHeight * heightFraction);
