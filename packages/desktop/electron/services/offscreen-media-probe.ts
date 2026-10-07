import { BrowserWindow } from "electron";
import { EVIDENCE_PEAK_COUNT } from "@stella/contracts/chat-evidence";
import {
  MEDIA_PROBE_PARTITION,
  mediaUrlForPath,
  serveMediaProtocol,
} from "../source/media-protocol.js";

const PROBE_TIMEOUT_MS = 25_000;
const IDLE_SHUTDOWN_MS = 30_000;

let probeWindow: BrowserWindow | null = null;
let idleTimer: NodeJS.Timeout | null = null;

const releaseLater = () => {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (probeWindow && !probeWindow.isDestroyed()) probeWindow.destroy();
    probeWindow = null;
    idleTimer = null;
  }, IDLE_SHUTDOWN_MS);
};

const ensureWindow = async (): Promise<BrowserWindow> => {
  if (probeWindow && !probeWindow.isDestroyed()) {
    releaseLater();
    return probeWindow;
  }
  serveMediaProtocol(MEDIA_PROBE_PARTITION);
  const window = new BrowserWindow({
    width: 16,
    height: 16,
    show: false,
    frame: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
      partition: MEDIA_PROBE_PARTITION,
    },
  });
  await window.loadURL(
    `data:text/html,${encodeURIComponent("<!doctype html><title>probe</title>")}`,
  );
  probeWindow = window;
  releaseLater();
  return window;
};

const evaluate = async <T>(script: string): Promise<T | null> => {
  const window = await ensureWindow();
  try {
    return (await Promise.race([
      window.webContents.executeJavaScript(script, true),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), PROBE_TIMEOUT_MS)),
    ])) as T | null;
  } catch {
    return null;
  }
};

export const offscreenVideoPoster = async (
  filePath: string,
  boxWidth: number,
  boxHeight: number,
): Promise<string | null> => {
  const url = mediaUrlForPath(filePath);
  const script = `(async () => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    video.src = ${JSON.stringify(url)};
    const ready = await new Promise((resolve) => {
      const done = (value) => resolve(value);
      video.onloadeddata = () => done(true);
      video.onerror = () => done(false);
      setTimeout(() => done(false), 15000);
    });
    if (!ready) return null;
    const seekTo = Math.min(0.6, (video.duration || 1) / 4);
    await new Promise((resolve) => {
      video.onseeked = () => resolve(null);
      video.onerror = () => resolve(null);
      try { video.currentTime = seekTo; } catch { resolve(null); }
      setTimeout(() => resolve(null), 6000);
    });
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (!sourceWidth || !sourceHeight) return null;
    const canvas = document.createElement("canvas");
    canvas.width = ${boxWidth};
    canvas.height = ${boxHeight};
    const context = canvas.getContext("2d");
    if (!context) return null;
    const scale = Math.max(${boxWidth} / sourceWidth, ${boxHeight} / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    context.drawImage(
      video,
      (${boxWidth} - drawWidth) / 2,
      (${boxHeight} - drawHeight) / 2,
      drawWidth,
      drawHeight,
    );
    const data = canvas.toDataURL("image/jpeg", 0.78);
    video.src = "";
    video.load();
    return data;
  })()`;
  const result = await evaluate<string>(script);
  return result && result.startsWith("data:image/") ? result : null;
};

export const offscreenAudioPeaks = async (
  filePath: string,
): Promise<{ peaks: number[]; durationMs: number | null } | null> => {
  const url = mediaUrlForPath(filePath);
  const script = `(async () => {
    const response = await fetch(${JSON.stringify(url)});
    if (!response.ok) return null;
    const bytes = await response.arrayBuffer();
    const context = new OfflineAudioContext(1, 1, 44100);
    const buffer = await context.decodeAudioData(bytes).catch(() => null);
    if (!buffer) return null;
    const samples = buffer.getChannelData(0);
    const bucketCount = ${EVIDENCE_PEAK_COUNT};
    const perBucket = Math.max(1, Math.floor(samples.length / bucketCount));
    const buckets = [];
    for (let bucket = 0; bucket < bucketCount; bucket += 1) {
      const start = bucket * perBucket;
      if (start >= samples.length) break;
      const end = Math.min(samples.length, start + perBucket);
      let total = 0;
      for (let index = start; index < end; index += 1) {
        const value = samples[index];
        total += value * value;
      }
      buckets.push(Math.sqrt(total / Math.max(1, end - start)));
    }
    const loudest = buckets.reduce((max, value) => Math.max(max, value), 0);
    const peaks = loudest > 0 ? buckets.map((value) => Math.min(1, value / loudest)) : buckets;
    return { peaks, durationMs: Math.round(buffer.duration * 1000) };
  })()`;
  const result = await evaluate<{ peaks: number[]; durationMs: number }>(script);
  if (!result || !Array.isArray(result.peaks) || result.peaks.length === 0) return null;
  return {
    peaks: result.peaks,
    durationMs: result.durationMs > 0 ? result.durationMs : null,
  };
};

export const offscreenMediaDurationMs = async (
  filePath: string,
): Promise<number | null> => {
  const url = mediaUrlForPath(filePath);
  const script = `(async () => {
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.src = ${JSON.stringify(url)};
    const ok = await new Promise((resolve) => {
      probe.onloadedmetadata = () => resolve(true);
      probe.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 10000);
    });
    if (!ok || !isFinite(probe.duration)) return null;
    const value = Math.round(probe.duration * 1000);
    probe.src = "";
    return value;
  })()`;
  const result = await evaluate<number>(script);
  return typeof result === "number" && result > 0 ? result : null;
};
