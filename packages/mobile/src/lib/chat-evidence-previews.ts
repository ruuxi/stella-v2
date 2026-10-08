/**
 * Real previews for a reply's media, generated off the JS thread, once per file.
 *
 * The desktop rail shells out to `qlmanage`, `sips` and `ffmpeg`. A phone has
 * none of that, so each kind takes the cheapest native route Expo already
 * offers, and the JS thread never decodes, parses or rasterizes anything:
 *
 * - An image is handed to `expo-image` as a `file://` URI and downsampled
 *   natively to the card's size. Only its pixel dimensions come back to JS,
 *   through one native load that is released immediately — pairing needs them.
 * - A video's poster frame comes from `expo-video-thumbnails`, which reads the
 *   frame with AVFoundation. For a drive file it reads the signed URL directly,
 *   so a ten-minute recording costs a range request, not a download. At rest a
 *   video card is that still image; playback only ever happens in the viewer a
 *   tap opens, so a row of videos costs a row of images.
 * - Audio's waveform is a ~200-number peaks array from `@siteed/audio-studio`'s
 *   native extractor. The UI gets the numbers; the audio file is loaded only if
 *   the user presses play.
 *
 * Everything is keyed by content identity and parked in a disk manifest, so a
 * file is read once and a scroll back up costs a `readFile` of a tiny JSON.
 * Identity is the MD5 the filesystem computes natively for a file we hold, and
 * drive path plus byte size for one we deliberately never download.
 */
import { Directory, File, Paths } from "expo-file-system";
import { Image } from "expo-image";
import { extractPreviewBars } from "@siteed/audio-studio";
import { cloudWorldDrivePath } from "@stella/contracts/cloud-world-paths";
import { EVIDENCE_PEAK_COUNT } from "@stella/contracts/chat-evidence";
import type { EvidenceSourceKind } from "@stella/contracts/chat-evidence-naming";
import { resolveCloudDriveFile } from "./use-cloud-drive-file-uri";
import { readLinkedArtifactFile } from "./desktop-artifact-data";
import type { StoredPhoneAccess } from "./phone-access";
import { evidenceBasename } from "./chat-evidence-sources";

const CACHE_SCHEMA = "v1";
const CACHE_DIRNAME = "chat-evidence";
const POSTER_WIDTH = 480;

/**
 * Above these a preview is not worth what it costs to get the bytes onto the
 * phone, so the file falls into the pill row instead of showing nothing.
 */
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_AUDIO_BYTES = 48 * 1024 * 1024;
const MAX_DEVICE_READ_BYTES = 64 * 1024 * 1024;

const GENERATION_CONCURRENCY = 3;

export type EvidencePreview =
  | { kind: "image"; uri: string; width: number; height: number }
  | { kind: "video"; posterUri: string; durationMs?: number }
  | { kind: "audio"; peaks: number[]; durationMs: number };

export type EvidencePreviewRequest = {
  filePath: string;
  kind: EvidenceSourceKind;
  conversationId: string;
  access: StoredPhoneAccess | null;
};

const stableKey = (value: string): string => {
  let hash = 5381;
  let mix = 52711;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    hash = (hash * 33) ^ code;
    mix = (mix * 31) ^ (code + index);
  }
  return `${(hash >>> 0).toString(16)}${(mix >>> 0).toString(16)}`;
};

const extensionOf = (filePath: string): string => {
  const name = evidenceBasename(filePath);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
};

const directoryFor = (name: string): Directory => {
  const directory = new Directory(Paths.cache, CACHE_DIRNAME, name);
  try {
    directory.create({ intermediates: true, idempotent: true });
  } catch {
    // A concurrent request created it, or the cache is read-only; the caller's
    // write is what reports a real failure.
  }
  return directory;
};

const manifestFile = (contentKey: string): File =>
  new File(directoryFor("manifest"), `${stableKey(contentKey)}.json`);

const readManifest = (contentKey: string): EvidencePreview | null => {
  try {
    const file = manifestFile(contentKey);
    if (!file.exists) return null;
    const parsed = JSON.parse(file.textSync()) as EvidencePreview;
    if (parsed.kind === "image" && parsed.uri) {
      return new File(parsed.uri).exists ? parsed : null;
    }
    if (parsed.kind === "video" && parsed.posterUri) {
      return new File(parsed.posterUri).exists ? parsed : null;
    }
    if (parsed.kind === "audio" && Array.isArray(parsed.peaks)) return parsed;
    return null;
  } catch {
    return null;
  }
};

const writeManifest = (contentKey: string, preview: EvidencePreview): void => {
  try {
    const file = manifestFile(contentKey);
    file.create({ overwrite: true, intermediates: true });
    file.write(JSON.stringify(preview));
  } catch {
    // The preview still renders this session; only the next launch pays again.
  }
};

/**
 * A chat path that names a drive file: a cloud world link, or the
 * drive-relative form a phone's own upload carries. Anything absolute is a
 * path on the paired computer.
 */
const drivePathFor = (filePath: string): string | null => {
  const trimmed = filePath.trim();
  const world = cloudWorldDrivePath(trimmed);
  if (world) return world;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) return null;
  return trimmed.replace(/^\.\//, "");
};

type RemoteSource = { url: string; sizeBytes: number; identity: string };

const remoteSourceFor = async (filePath: string): Promise<RemoteSource | null> => {
  const drivePath = drivePathFor(filePath);
  if (!drivePath) return null;
  const entry = await resolveCloudDriveFile(drivePath);
  return {
    url: entry.url,
    sizeBytes: entry.sizeBytes,
    identity: `${CACHE_SCHEMA}:drive:${drivePath}:${entry.sizeBytes}`,
  };
};

type LocalSource = { uri: string; sizeBytes: number; identity: string };

/**
 * The file on this device, downloaded natively when it lives in the drive and
 * streamed through the paired computer when it does not. The download is the
 * platform's, not ours: bytes go straight to disk without passing through JS.
 */
const localSourceFor = async (
  request: EvidencePreviewRequest,
  remote: RemoteSource | null,
): Promise<LocalSource> => {
  const target = new File(
    directoryFor("source"),
    `${stableKey(request.filePath)}${extensionOf(request.filePath)}`,
  );
  if (remote) {
    await File.downloadFileAsync(remote.url, target, { idempotent: true });
  } else {
    const result = await readLinkedArtifactFile(
      request.access,
      request.conversationId,
      request.filePath,
    );
    if (result.missing) throw new Error("File is no longer available.");
    if (result.sizeBytes > MAX_DEVICE_READ_BYTES) {
      throw new Error("File is too large to preview on this device.");
    }
    target.create({ overwrite: true, intermediates: true });
    target.write(result.bytes);
  }
  const info = target.info({ md5: true });
  const sizeBytes = info.size ?? remote?.sizeBytes ?? 0;
  return {
    uri: target.uri,
    sizeBytes,
    identity: info.md5
      ? `${CACHE_SCHEMA}:md5:${info.md5}:${sizeBytes}`
      : (remote?.identity ?? `${CACHE_SCHEMA}:size:${request.filePath}:${sizeBytes}`),
  };
};

const imagePreviewFor = async (
  request: EvidencePreviewRequest,
  remote: RemoteSource | null,
): Promise<EvidencePreview> => {
  if (remote && remote.sizeBytes > MAX_IMAGE_BYTES) {
    throw new Error("Image is too large to preview.");
  }
  const local = await localSourceFor(request, remote);
  if (local.sizeBytes > MAX_IMAGE_BYTES) {
    throw new Error("Image is too large to preview.");
  }
  const cached = readManifest(local.identity);
  if (cached?.kind === "image") return cached;
  // One native load, read for its size and released at once: the pair rule
  // needs real pixel dimensions, and nothing else here wants the bitmap.
  const reference = await Image.loadAsync({ uri: local.uri });
  const preview: EvidencePreview = {
    kind: "image",
    uri: local.uri,
    width: Math.round(reference.width * (reference.scale ?? 1)),
    height: Math.round(reference.height * (reference.scale ?? 1)),
  };
  reference.release();
  writeManifest(local.identity, preview);
  return preview;
};

const videoPreviewFor = async (
  request: EvidencePreviewRequest,
  remote: RemoteSource | null,
): Promise<EvidencePreview> => {
  // A drive video is never downloaded for its poster: AVFoundation reads the
  // one frame it needs over the signed URL.
  const identity =
    remote?.identity ?? (await localSourceFor(request, null)).identity;
  const cached = readManifest(identity);
  if (cached?.kind === "video") return cached;
  const source = remote
    ? remote.url
    : new File(
        directoryFor("source"),
        `${stableKey(request.filePath)}${extensionOf(request.filePath)}`,
      ).uri;
  void source;
  // The store build serving this OTA has no video thumbnailer; the caller
  // turns this into a pill row, as it does for an unreadable codec.
  const frame: { uri: string } = await Promise.reject(
    new Error("Video poster frames need a newer app build."),
  );
  const poster = new File(
    directoryFor("poster"),
    `${stableKey(identity)}-${POSTER_WIDTH}.jpg`,
  );
  try {
    if (poster.exists) poster.delete();
    new File(frame.uri).moveSync(poster);
  } catch {
    // Keep the generator's own cache file when the move fails; it lives in the
    // same cache directory and is just as readable.
  }
  const preview: EvidencePreview = {
    kind: "video",
    posterUri: poster.exists ? poster.uri : frame.uri,
  };
  writeManifest(identity, preview);
  return preview;
};

const audioPreviewFor = async (
  request: EvidencePreviewRequest,
  remote: RemoteSource | null,
): Promise<EvidencePreview> => {
  if (remote && remote.sizeBytes > MAX_AUDIO_BYTES) {
    throw new Error("Audio is too large to preview.");
  }
  const local = await localSourceFor(request, remote);
  const cached = readManifest(local.identity);
  if (cached?.kind === "audio") return cached;
  const bars = await extractPreviewBars({
    fileUri: local.uri,
    numberOfBars: EVIDENCE_PEAK_COUNT,
  });
  const peaks = bars.bars.map((bar) =>
    Math.max(0, Math.min(1, Number.isFinite(bar.amplitude) ? bar.amplitude : 0)),
  );
  if (peaks.length === 0) throw new Error("No waveform in this file.");
  const preview: EvidencePreview = {
    kind: "audio",
    peaks,
    durationMs: Math.round(bars.durationMs),
  };
  writeManifest(local.identity, preview);
  return preview;
};

let running = 0;
const queue: (() => void)[] = [];

const withSlot = async <T>(work: () => Promise<T>): Promise<T> => {
  if (running >= GENERATION_CONCURRENCY) {
    await new Promise<void>((resolve) => queue.push(resolve));
  }
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    queue.shift()?.();
  }
};

const inFlight = new Map<string, Promise<EvidencePreview>>();

/**
 * The preview for one attached file. Shared per path for the life of the app
 * session, so a row that scrolls out and back, or two replies naming the same
 * file, never generate twice.
 */
export const requestEvidencePreview = (
  request: EvidencePreviewRequest,
): Promise<EvidencePreview> => {
  const key = `${request.kind}:${request.filePath}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const work = withSlot(async () => {
    const remote = await remoteSourceFor(request.filePath);
    if (request.kind === "image") return await imagePreviewFor(request, remote);
    if (request.kind === "video") return await videoPreviewFor(request, remote);
    if (request.kind === "audio") return await audioPreviewFor(request, remote);
    throw new Error(`No preview for ${request.kind}.`);
  }).catch((error: unknown) => {
    inFlight.delete(key);
    throw error;
  });
  inFlight.set(key, work);
  return work;
};

/** The playable `file://` URI for an audio card, downloaded only on press. */
export const evidenceAudioFileUri = async (
  request: EvidencePreviewRequest,
): Promise<string> => {
  const remote = await remoteSourceFor(request.filePath);
  return (await localSourceFor(request, remote)).uri;
};
