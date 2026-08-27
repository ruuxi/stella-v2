import {
  buildCanvasShareUrl,
  canvasSharePathForSlug,
  CANVAS_SHARE_PATH_PREFIX,
  isCanvasShareSlug,
  isCanvasShareUrl,
  parseCanvasShareSlug,
  readCanvasShareBaseUrl,
} from "@stella/contracts/canvas-share";

export {
  buildCanvasShareUrl,
  canvasSharePathForSlug,
  CANVAS_SHARE_PATH_PREFIX,
  isCanvasShareSlug,
  isCanvasShareUrl,
  parseCanvasShareSlug,
  readCanvasShareBaseUrl,
};

export const canvasShareBaseUrl = (): string | null =>
  readCanvasShareBaseUrl(
    import.meta.env.VITE_CANVAS_SHARE_BASE_URL as string | undefined,
  );
