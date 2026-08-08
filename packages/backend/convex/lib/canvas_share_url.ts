/**
 * Canvas-share public URL construction.
 *
 * The final domain is TBD (pending purchase), so the base is read from the
 * `CANVAS_SHARE_BASE_URL` env/config. Until it is set the code falls back to a
 * clearly-marked placeholder so misconfiguration is obvious in returned URLs
 * rather than silently pointing at a real domain.
 *
 * Share URL format: `<base>/c/<slug>`.
 */

/** Obvious placeholder used until `CANVAS_SHARE_BASE_URL` is configured. */
export const CANVAS_SHARE_BASE_URL_PLACEHOLDER =
  "https://canvas-share.example.invalid";

/** Resolve the configured share base URL, trimming any trailing slashes. */
export const resolveCanvasShareBaseUrl = (): string => {
  const configured = process.env.CANVAS_SHARE_BASE_URL?.trim();
  const base = configured || CANVAS_SHARE_BASE_URL_PLACEHOLDER;
  return base.replace(/\/+$/, "");
};

/** Build the public URL for a given share slug: `<base>/c/<slug>`. */
export const buildCanvasShareUrl = (slug: string): string =>
  `${resolveCanvasShareBaseUrl()}/c/${slug}`;
