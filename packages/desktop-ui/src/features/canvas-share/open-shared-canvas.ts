import {
  normalizeDisplayPayload,
  type DisplayTabPayload,
} from "@stella/contracts/desktop/display-payload";
import { openDisplayPayloadTab } from "@/features/workspace-display/open-payload";
import { canvasShareBaseUrl, isCanvasShareUrl } from "@/shared/lib/canvas-share";

export const isRendererCanvasShareUrl = (url: string): boolean =>
  isCanvasShareUrl(url, canvasShareBaseUrl());

export const renderSharedCanvasFromUrl = async (
  url: string,
): Promise<boolean> => {
  if (!isRendererCanvasShareUrl(url)) return false;
  const openSharedCanvas = window.electronAPI?.display?.openSharedCanvas;
  if (typeof openSharedCanvas !== "function") return false;

  let raw: unknown;
  try {
    raw = await openSharedCanvas({ url });
  } catch {
    return false;
  }

  const payload: DisplayTabPayload | null = normalizeDisplayPayload(raw);
  if (!payload || payload.kind !== "canvas-html") return false;
  openDisplayPayloadTab(payload, { activate: true });
  return true;
};

export const maybeHandleCanvasShareUrl = (url: string): boolean => {
  if (!isRendererCanvasShareUrl(url)) return false;
  void renderSharedCanvasFromUrl(url);
  return true;
};
