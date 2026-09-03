/**
 * Thin re-exports over `@stella/theme`'s color math. Mobile used to carry its
 * own OKLCH port here; the shared package is now the only implementation so
 * both clients derive identical colors.
 */
import { hexToOklch, withAlpha } from "@stella/theme";

export { hexToOklch };
export type { OklchColor } from "@stella/theme";

/** `color` at `opacity` (multiplied into any alpha it already has). Accepts
 *  hex or rgb()/rgba() input. */
export function fadeHex(color: string, opacity: number): string {
  return withAlpha(color, opacity);
}
