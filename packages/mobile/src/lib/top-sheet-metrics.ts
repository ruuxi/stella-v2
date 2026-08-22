/**
 * Sizing for the top-anchored sheets (activity hub, artifact viewer, device
 * sheet).
 *
 * The sheets are deliberately PARTIAL height: they anchor to the TOP of the
 * screen and cap at 0.8 of it, leaving an open scrim band BELOW the sheet.
 * That band is the dismissal affordance — tap it (or drag) to close — so the
 * fraction must stay well below 1; a full-height sheet has no tappable gap
 * and traps the user inside it.
 */
export const TOP_SHEET_HEIGHT_FRACTION = 0.8;

/** Pixel height of (or cap for) the sheet for a given window height. */
export const topSheetMaxHeight = (
  windowHeight: number,
  heightFraction: number = TOP_SHEET_HEIGHT_FRACTION,
): number => Math.round(windowHeight * heightFraction);
