/**
 * Renderer entry point for opening a shared canvas URL as a native canvas.
 *
 * When a `<CANVAS_SHARE_BASE_URL>/c/<slug>` link is opened inside Stella
 * (pasted, clicked, or routed from a deep link), we ask the main process to
 * fetch the remote HTML and materialize it into the same
 * `~/.stella/outputs/html/` store local canvases use, then render it through
 * the identical sandboxed canvas path — no extra privileges. The network +
 * filesystem work runs in main (privileged, and free of renderer CORS), and
 * the renderer only routes the resulting file-backed payload.
 *
 * A private link opens only for its owner, so the renderer first asks the
 * backend for the owner's view URL (`shares.viewLink`, which carries a short
 * grant); someone else's link, or a signed-out app, keeps the URL as given.
 * When the canvas can't be rendered here (a private link that isn't ours, the
 * share domain unreachable), the link opens in the system browser instead,
 * so a click is never swallowed.
 */
import {
  normalizeDisplayPayload,
  type DisplayTabPayload,
} from "@stella/contracts/desktop/display-payload";
import { openDisplayPayloadTab } from "@/features/workspace-display/open-payload";
import { backendClient } from "@/platform/backend/backend-client";
import {
  canvasShareBaseUrl,
  isCanvasShareUrl,
  parseCanvasShareSlug,
} from "@/shared/lib/canvas-share";

/** Whether `url` matches the configured canvas-share pattern. */
export const isRendererCanvasShareUrl = (url: string): boolean =>
  isCanvasShareUrl(url, canvasShareBaseUrl());

/** The owner's view URL for one of their own links, else the URL as given. */
const ownerViewUrl = async (url: string): Promise<string> => {
  const slug = parseCanvasShareSlug(url, canvasShareBaseUrl());
  if (!slug) return url;
  try {
    return (await backendClient.call("shares.viewLink", { slug })).url;
  } catch {
    return url;
  }
};

const openInSystemBrowser = (url: string): void => {
  if (window.electronAPI?.system.openExternal) {
    window.electronAPI.system.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
};

/** Render natively; the URL that was tried comes back for a browser fallback. */
const renderShared = async (
  url: string,
): Promise<{ handled: boolean; viewUrl: string }> => {
  const openSharedCanvas = window.electronAPI?.display?.openSharedCanvas;
  if (!isRendererCanvasShareUrl(url) || typeof openSharedCanvas !== "function") {
    return { handled: false, viewUrl: url };
  }
  const viewUrl = await ownerViewUrl(url);
  let raw: unknown;
  try {
    raw = await openSharedCanvas({ url: viewUrl });
  } catch {
    return { handled: false, viewUrl };
  }
  const payload: DisplayTabPayload | null = normalizeDisplayPayload(raw);
  if (!payload || payload.kind !== "canvas-html") return { handled: false, viewUrl };
  openDisplayPayloadTab(payload, { activate: true });
  return { handled: true, viewUrl };
};

/**
 * Fetch + render a shared canvas natively. Returns `true` when the URL was a
 * recognized canvas-share link that was handled (so the caller should NOT
 * fall back to opening it in the system browser), `false` otherwise.
 */
export const renderSharedCanvasFromUrl = async (
  url: string,
): Promise<boolean> => (await renderShared(url)).handled;

/**
 * Fire-and-forget guard for synchronous callers (e.g. the external-link
 * helper). Returns `true` immediately when the URL is a canvas-share link
 * (kicking off the async native render), so the caller can skip the browser.
 */
export const maybeHandleCanvasShareUrl = (url: string): boolean => {
  if (!isRendererCanvasShareUrl(url)) return false;
  void renderShared(url).then(({ handled, viewUrl }) => {
    if (!handled) openInSystemBrowser(viewUrl);
  });
  return true;
};
