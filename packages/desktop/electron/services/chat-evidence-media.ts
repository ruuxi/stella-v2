import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { nativeImage, type NativeImage } from "electron";
import { EVIDENCE_PEAK_COUNT } from "@stella/contracts/chat-evidence";

const PROBE_TIMEOUT_MS = 20_000;
const CSV_READ_CAP_BYTES = 512 * 1024;
const CSV_ROW_COUNT_CAP_BYTES = 32 * 1024 * 1024;
const CSV_PREVIEW_ROWS = 4;
const CSV_PREVIEW_COLUMNS = 6;
const PEAK_SAMPLE_RATE = 8000;

type RunResult = { code: number; stdout: string; stderr: string };

const run = (
  command: string,
  args: string[],
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          code: error ? 1 : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });

let ffmpegPathPromise: Promise<string | null> | null = null;

const resolveFfmpeg = (): Promise<string | null> => {
  ffmpegPathPromise ??= (async () => {
    const candidates = [
      "/opt/homebrew/bin/ffmpeg",
      "/usr/local/bin/ffmpeg",
      "/usr/bin/ffmpeg",
    ];
    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    const which = await run("/usr/bin/which", ["ffmpeg"], 4000);
    const found = which.stdout.trim();
    return which.code === 0 && found ? found : null;
  })();
  return ffmpegPathPromise;
};

const scratchDir = async (): Promise<string> => {
  const dir = path.join(os.tmpdir(), `stella-evidence-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

const discard = (dir: string) => {
  void fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
};

export const coverCropToDataUrl = (
  image: NativeImage,
  boxWidth: number,
  boxHeight: number,
): string | null => {
  if (image.isEmpty()) return null;
  const size = image.getSize();
  if (size.width <= 0 || size.height <= 0) return null;
  const scale = Math.max(boxWidth / size.width, boxHeight / size.height);
  const scaledWidth = Math.max(boxWidth, Math.ceil(size.width * scale));
  const scaledHeight = Math.max(boxHeight, Math.ceil(size.height * scale));
  const scaled = image.resize({
    width: scaledWidth,
    height: scaledHeight,
    quality: "good",
  });
  const cropped = scaled.crop({
    x: Math.max(0, Math.floor((scaledWidth - boxWidth) / 2)),
    y: Math.max(0, Math.floor((scaledHeight - boxHeight) / 2)),
    width: Math.min(boxWidth, scaledWidth),
    height: Math.min(boxHeight, scaledHeight),
  });
  const jpeg = cropped.toJPEG(78);
  if (jpeg.byteLength === 0) return null;
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
};

export const imageDimensions = async (
  filePath: string,
): Promise<{ width: number; height: number } | null> => {
  const image = nativeImage.createFromPath(filePath);
  if (!image.isEmpty()) {
    const size = image.getSize();
    if (size.width > 0 && size.height > 0) return size;
  }
  const probed = await run("/usr/bin/sips", [
    "-g",
    "pixelWidth",
    "-g",
    "pixelHeight",
    filePath,
  ]);
  const width = Number(/pixelWidth:\s*(\d+)/.exec(probed.stdout)?.[1] ?? "");
  const height = Number(/pixelHeight:\s*(\d+)/.exec(probed.stdout)?.[1] ?? "");
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width, height };
  }
  return null;
};

export const rasterizeImageFile = async (
  filePath: string,
  boxWidth: number,
  boxHeight: number,
): Promise<string | null> => {
  const direct = nativeImage.createFromPath(filePath);
  if (!direct.isEmpty()) return coverCropToDataUrl(direct, boxWidth, boxHeight);
  const dir = await scratchDir();
  try {
    const converted = path.join(dir, "converted.png");
    const result = await run("/usr/bin/sips", [
      "-s",
      "format",
      "png",
      filePath,
      "--out",
      converted,
    ]);
    if (result.code !== 0) return null;
    const image = nativeImage.createFromPath(converted);
    return coverCropToDataUrl(image, boxWidth, boxHeight);
  } finally {
    discard(dir);
  }
};

export const quickLookRaster = async (
  filePath: string,
  boxWidth: number,
  boxHeight: number,
): Promise<string | null> => {
  const dir = await scratchDir();
  try {
    const requested = Math.max(boxWidth, boxHeight) * 2;
    const result = await run(
      "/usr/bin/qlmanage",
      ["-t", "-s", String(requested), "-o", dir, filePath],
      PROBE_TIMEOUT_MS,
    );
    if (result.code !== 0 && !result.stdout.includes("produced")) return null;
    const entries = await fs.readdir(dir);
    const produced = entries.find((entry) => entry.toLowerCase().endsWith(".png"));
    if (!produced) return null;
    const image = nativeImage.createFromPath(path.join(dir, produced));
    return coverCropToDataUrl(image, boxWidth, boxHeight);
  } catch {
    return null;
  } finally {
    discard(dir);
  }
};

export const videoPosterRaster = async (
  filePath: string,
  boxWidth: number,
  boxHeight: number,
): Promise<string | null> => {
  const ffmpeg = await resolveFfmpeg();
  if (ffmpeg) {
    const dir = await scratchDir();
    try {
      const frame = path.join(dir, "poster.png");
      const result = await run(
        ffmpeg,
        ["-y", "-ss", "0.6", "-i", filePath, "-frames:v", "1", "-f", "image2", frame],
        PROBE_TIMEOUT_MS,
      );
      if (result.code === 0) {
        const image = nativeImage.createFromPath(frame);
        const raster = coverCropToDataUrl(image, boxWidth, boxHeight);
        if (raster) return raster;
      }
    } finally {
      discard(dir);
    }
  }
  return await quickLookRaster(filePath, boxWidth, boxHeight);
};

export const probeDurationMs = async (filePath: string): Promise<number | null> => {
  const ffmpeg = await resolveFfmpeg();
  if (ffmpeg) {
    const probe = await run(ffmpeg, ["-i", filePath], PROBE_TIMEOUT_MS);
    const matched = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(probe.stderr);
    if (matched) {
      const hours = Number(matched[1]);
      const minutes = Number(matched[2]);
      const seconds = Number(matched[3]);
      return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
    }
  }
  const metadata = await run("/usr/bin/mdls", [
    "-raw",
    "-name",
    "kMDItemDurationSeconds",
    filePath,
  ]);
  const seconds = Number(metadata.stdout.trim());
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
};

export const probePageCount = async (filePath: string): Promise<number | null> => {
  const metadata = await run("/usr/bin/mdls", [
    "-raw",
    "-name",
    "kMDItemNumberOfPages",
    filePath,
  ]);
  const pages = Number(metadata.stdout.trim());
  if (Number.isFinite(pages) && pages > 0) return Math.round(pages);
  if (path.extname(filePath).toLowerCase() !== ".pdf") return null;
  try {
    const bytes = await fs.readFile(filePath);
    const matches = bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g);
    return matches && matches.length > 0 ? matches.length : null;
  } catch {
    return null;
  }
};

const findWaveDataChunk = (
  buffer: Buffer,
): { offset: number; length: number } | null => {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  let cursor = 12;
  while (cursor + 8 <= buffer.length) {
    const id = buffer.toString("ascii", cursor, cursor + 4);
    const size = buffer.readUInt32LE(cursor + 4);
    if (id === "data") {
      return {
        offset: cursor + 8,
        length: Math.min(size, buffer.length - cursor - 8),
      };
    }
    cursor += 8 + size + (size % 2);
  }
  return null;
};

const peaksFromPcm = (
  buffer: Buffer,
  offset: number,
  length: number,
  bucketCount: number,
): number[] => {
  const sampleCount = Math.floor(length / 2);
  if (sampleCount <= 0) return [];
  const buckets: number[] = [];
  const perBucket = Math.max(1, Math.floor(sampleCount / bucketCount));
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = bucket * perBucket;
    if (start >= sampleCount) break;
    const end = Math.min(sampleCount, start + perBucket);
    let total = 0;
    for (let index = start; index < end; index += 1) {
      const sample = buffer.readInt16LE(offset + index * 2) / 32768;
      total += sample * sample;
    }
    buckets.push(Math.sqrt(total / Math.max(1, end - start)));
  }
  const loudest = buckets.reduce((max, value) => Math.max(max, value), 0);
  if (loudest <= 0) return buckets.map(() => 0);
  return buckets.map((value) => Math.min(1, value / loudest));
};

export const extractAudioPeaks = async (
  filePath: string,
): Promise<{ peaks: number[]; durationMs: number | null } | null> => {
  const dir = await scratchDir();
  try {
    const wav = path.join(dir, "mono.wav");
    const ffmpeg = await resolveFfmpeg();
    let decoded = false;
    if (ffmpeg) {
      const result = await run(
        ffmpeg,
        [
          "-y",
          "-i",
          filePath,
          "-ac",
          "1",
          "-ar",
          String(PEAK_SAMPLE_RATE),
          "-c:a",
          "pcm_s16le",
          "-f",
          "wav",
          wav,
        ],
        PROBE_TIMEOUT_MS,
      );
      decoded = result.code === 0;
    }
    if (!decoded) {
      const result = await run(
        "/usr/bin/afconvert",
        [
          "-f",
          "WAVE",
          "-d",
          `LEI16@${PEAK_SAMPLE_RATE}`,
          "-c",
          "1",
          filePath,
          wav,
        ],
        PROBE_TIMEOUT_MS,
      );
      decoded = result.code === 0;
    }
    if (!decoded) return null;
    const buffer = await fs.readFile(wav);
    const chunk = findWaveDataChunk(buffer);
    if (!chunk) return null;
    const peaks = peaksFromPcm(buffer, chunk.offset, chunk.length, EVIDENCE_PEAK_COUNT);
    if (peaks.length === 0) return null;
    const durationMs = Math.round(
      (chunk.length / 2 / PEAK_SAMPLE_RATE) * 1000,
    );
    return { peaks, durationMs: durationMs > 0 ? durationMs : null };
  } catch {
    return null;
  } finally {
    discard(dir);
  }
};

const splitCsvLine = (line: string, separator: string): string[] => {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === separator) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  return cells;
};

const countDataRows = async (filePath: string): Promise<number> =>
  await new Promise<number>((resolve) => {
    let newlines = 0;
    let read = 0;
    let lastByte = 0;
    const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    stream.on("data", (chunk: string | Buffer) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      for (let index = 0; index < buffer.length; index += 1) {
        if (buffer[index] === 0x0a) newlines += 1;
      }
      if (buffer.length > 0) lastByte = buffer[buffer.length - 1] ?? 0;
      read += buffer.length;
      if (read >= CSV_ROW_COUNT_CAP_BYTES) stream.destroy();
    });
    stream.on("close", () => {
      const trailing = lastByte === 0x0a ? 0 : 1;
      resolve(Math.max(0, newlines + trailing - 1));
    });
    stream.on("error", () => resolve(0));
  });

export const readTablePreview = async (
  filePath: string,
): Promise<{
  columns: string[];
  rows: string[][];
  totalRows: number;
  totalColumns: number;
} | null> => {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(CSV_READ_CAP_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, CSV_READ_CAP_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf-8");
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) return null;
    const separator = path.extname(filePath).toLowerCase() === ".tsv" ? "\t" : ",";
    const header = splitCsvLine(lines[0] ?? "", separator);
    const rows = lines
      .slice(1, 1 + CSV_PREVIEW_ROWS)
      .map((line) => splitCsvLine(line, separator));
    const totalColumns = header.length;
    const totalRows = await countDataRows(filePath);
    return {
      columns: header.slice(0, CSV_PREVIEW_COLUMNS),
      rows: rows.map((row) => row.slice(0, CSV_PREVIEW_COLUMNS)),
      totalRows: Math.max(totalRows, rows.length),
      totalColumns,
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

export const archiveEntryExtensions = async (
  filePath: string,
): Promise<string[] | null> => {
  if (path.extname(filePath).toLowerCase() !== ".zip") return null;
  const listing = await run("/usr/bin/unzip", ["-Z", "-1", filePath]);
  if (listing.code !== 0) return null;
  return listing.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith("/"))
    .map((line) => path.extname(line));
};

export const folderEntryExtensions = async (
  dirPath: string,
): Promise<string[]> => {
  const extensions: string[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 3 || extensions.length > 2000) return;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), depth + 1);
      } else {
        extensions.push(path.extname(entry.name));
      }
    }
  };
  try {
    await walk(dirPath, 0);
  } catch {
    return extensions;
  }
  return extensions;
};
