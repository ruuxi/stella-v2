import { desktopCapturer } from "electron";
import { captureWindowScreenshotByPid } from "./window-capture.js";

export type AppWindowCapture = {
  title: string;
  axTree?: string | null;
  screenshot: {
    dataUrl: string;
    width: number;
    height: number;
  };
};

const MAX_THUMBNAIL_DIM = 1280;

const normalizeName = (value: string): string =>
  value.toLowerCase().replace(/\s+/g, "").trim();

type CaptureOptions = {

  pid?: number | null;

  appName?: string | null;
};

export const captureAppWindow = async (
  options: CaptureOptions,
): Promise<AppWindowCapture | null> => {
  const pid =
    typeof options.pid === "number" && Number.isFinite(options.pid) && options.pid > 0
      ? options.pid
      : null;

  if (
    pid !== null &&
    (process.platform === "darwin" || process.platform === "win32")
  ) {
    try {
      const capture = await captureWindowScreenshotByPid(pid);
      if (capture) {
        return {
          title: capture.windowInfo.title ?? "",
          axTree: capture.axTree ?? capture.windowInfo.axTree ?? null,
          screenshot: capture.screenshot,
        };
      }
    } catch (error) {
      console.warn("[home] captureWindowScreenshotByPid failed", error);
    }
  }

  const appName = (options.appName ?? "").trim();
  if (!appName) return null;
  return await captureAppWindowByName(appName);
};

const captureAppWindowByName = async (
  appName: string,
): Promise<AppWindowCapture | null> => {
  const targetNormalized = normalizeName(appName);

  let sources: Electron.DesktopCapturerSource[];
  try {
    sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: MAX_THUMBNAIL_DIM, height: MAX_THUMBNAIL_DIM },
      fetchWindowIcons: false,
    });
  } catch (error) {
    console.warn("[home] captureAppWindow getSources failed", error);
    return null;
  }

  const candidates = sources
    .map((source) => {
      const sourceName = source.name ?? "";
      const trimmedName = sourceName.trim();
      if (!trimmedName) return null;

      const splitMatch = trimmedName.match(/^(.+?)\s+[\u2013\u2014-]\s+(.*)$/);
      const appPortion = splitMatch ? splitMatch[1] : trimmedName;
      const titlePortion = splitMatch ? splitMatch[2] : "";
      const appPortionNormalized = normalizeName(appPortion);

      let score = 0;
      if (appPortionNormalized === targetNormalized) {
        score = 3;
      } else if (appPortionNormalized.startsWith(targetNormalized)) {
        score = 2;
      } else if (appPortionNormalized.includes(targetNormalized)) {
        score = 1;
      } else {
        return null;
      }

      return { source, score, titlePortion };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> =>
      candidate !== null,
    )
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) return null;

  const best = candidates[0];
  const thumbnail = best.source.thumbnail;
  if (thumbnail.isEmpty()) return null;
  const size = thumbnail.getSize();

  return {
    title: best.titlePortion,
    axTree: null,
    screenshot: {
      dataUrl: thumbnail.toDataURL(),
      width: size.width,
      height: size.height,
    },
  };
};
