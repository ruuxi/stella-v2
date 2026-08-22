/**
 * Sizing for the bottom-anchored activity hub sheet.
 *
 * The sheet is deliberately PARTIAL height: it caps at the same fraction of
 * the screen as the top sheets (0.8), leaving an open scrim band above it.
 * That band is the dismissal affordance — tap it (or drag) to close — so the
 * fraction must stay well below 1; a full-height sheet has no tappable gap
 * and traps the user inside it.
 */
export const BOTTOM_SHEET_HEIGHT_FRACTION = 0.8;

/** Pixel height of the sheet for a given window height. */
export const bottomSheetMaxHeight = (
  windowHeight: number,
  heightFraction: number = BOTTOM_SHEET_HEIGHT_FRACTION,
): number => Math.round(windowHeight * heightFraction);
