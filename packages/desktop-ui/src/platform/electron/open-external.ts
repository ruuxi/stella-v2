import { maybeHandleCanvasShareUrl } from "@/features/canvas-share/open-shared-canvas";

export function openExternalUrl(url: string): void {

  if (maybeHandleCanvasShareUrl(url)) {
    return;
  }
  if (window.electronAPI?.system.openExternal) {
    window.electronAPI.system.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
