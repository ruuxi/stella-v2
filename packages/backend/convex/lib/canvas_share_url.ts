export const CANVAS_SHARE_BASE_URL_PLACEHOLDER =
  "https://canvas-share.example.invalid";

export const resolveCanvasShareBaseUrl = (): string => {
  const configured = process.env.CANVAS_SHARE_BASE_URL?.trim();
  const base = configured || CANVAS_SHARE_BASE_URL_PLACEHOLDER;
  return base.replace(/\/+$/, "");
};

export const buildCanvasShareUrl = (slug: string): string =>
  `${resolveCanvasShareBaseUrl()}/c/${slug}`;
