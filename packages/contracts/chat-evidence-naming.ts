import { basename, extname } from "./chat-evidence-paths.js";

export type EvidenceSourceKind =
  | "image"
  | "video"
  | "audio"
  | "page"
  | "pdf"
  | "office"
  | "table"
  | "bundle"
  | "folder"
  | "plain";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".heic",
  ".tiff",
  ".tif",
  ".avif",
]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v", ".avi", ".mkv"]);
const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".oga",
  ".flac",
  ".aiff",
  ".aif",
  ".caf",
  ".opus",
]);
const PAGE_EXTENSIONS = new Set([".html", ".htm", ".svg"]);
const OFFICE_EXTENSIONS = new Set([
  ".docx",
  ".doc",
  ".pages",
  ".xlsx",
  ".xlsm",
  ".numbers",
  ".pptx",
  ".key",
]);
const TABLE_EXTENSIONS = new Set([".csv", ".tsv"]);
const BUNDLE_EXTENSIONS = new Set([".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar"]);

const PLAIN_LABELS: Record<string, string> = {
  ".ttf": "TrueType font",
  ".otf": "OpenType font",
  ".woff": "Web font",
  ".woff2": "Web font",
  ".dmg": "Disk image",
  ".pkg": "Installer package",
  ".bin": "Binary file",
  ".exe": "Windows executable",
  ".so": "Shared library",
  ".dylib": "Shared library",
  ".wasm": "WebAssembly module",
  ".ico": "Icon file",
  ".sqlite": "Database file",
  ".db": "Database file",
};

const PLAYBACK_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".aiff": "audio/aiff",
  ".aif": "audio/aiff",
  ".caf": "audio/x-caf",
};

export const evidenceSourceKind = (
  filePath: string,
  isDirectory: boolean,
): EvidenceSourceKind => {
  if (isDirectory) return "folder";
  const extension = extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (PAGE_EXTENSIONS.has(extension)) return "page";
  if (extension === ".pdf") return "pdf";
  if (OFFICE_EXTENSIONS.has(extension)) return "office";
  if (TABLE_EXTENSIONS.has(extension)) return "table";
  if (BUNDLE_EXTENSIONS.has(extension)) return "bundle";
  return "plain";
};

export const playbackMimeTypeFor = (filePath: string): string | undefined =>
  PLAYBACK_MIME[extname(filePath).toLowerCase()];

export const plainKindLabel = (filePath: string): string => {
  const extension = extname(filePath).toLowerCase();
  const named = PLAIN_LABELS[extension];
  if (named) return named;
  if (!extension) return "File";
  return `${extension.slice(1).toUpperCase()} file`;
};

const NOISE_TOKENS = new Set([
  "screenshot",
  "screen",
  "shot",
  "capture",
  "img",
  "image",
  "final",
  "v1",
  "v2",
  "v3",
  "copy",
  "new",
  "tmp",
  "temp",
  "export",
  "output",
  "out",
  "draft",
]);

const VARIANT_TOKENS: Record<string, "before" | "after"> = {
  before: "before",
  old: "before",
  prev: "before",
  previous: "before",
  was: "before",
  after: "after",
  new: "after",
  now: "after",
  fixed: "after",
  updated: "after",
};

const KIND_NOUN: Record<EvidenceSourceKind, string> = {
  image: "screen",
  video: "recording",
  audio: "recording",
  page: "page",
  pdf: "document",
  office: "document",
  table: "table",
  bundle: "archive",
  folder: "folder",
  plain: "file",
};

const tokenize = (stem: string): string[] =>
  stem
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);

const isTimestampToken = (token: string): boolean =>
  /^\d{2,}$/.test(token) || /^\d{4}-\d{2}-\d{2}$/.test(token);

export type EvidenceNameParts = {
  /** Lowercase tokens with noise, numbering and variant words removed. */
  subject: string[];
  variant: "before" | "after" | null;
  /** The subject with its variant and ordinal stripped, for pairing. */
  pairingKey: string;
};

export const parseEvidenceName = (filePath: string): EvidenceNameParts => {
  const stem = basename(filePath, extname(filePath));
  const tokens = tokenize(stem);
  let variant: "before" | "after" | null = null;
  const subject: string[] = [];
  for (const raw of tokens) {
    const token = raw.toLowerCase();
    const asVariant = VARIANT_TOKENS[token];
    if (asVariant && !variant) {
      variant = asVariant;
      continue;
    }
    if (asVariant) continue;
    if (NOISE_TOKENS.has(token)) continue;
    if (isTimestampToken(token)) continue;
    subject.push(token);
  }
  return {
    subject,
    variant,
    pairingKey: subject.join(" "),
  };
};

const sentenceCase = (words: string[]): string => {
  if (words.length === 0) return "";
  const joined = words.join(" ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
};

export const humanTitleFor = (
  filePath: string,
  kind: EvidenceSourceKind,
): string => {
  const parts = parseEvidenceName(filePath);
  const subject = sentenceCase(parts.subject);
  const noun = KIND_NOUN[kind];
  const base = subject || sentenceCase([`Untitled ${noun}`]);
  if (parts.variant === "before") return `${base}, before`;
  if (parts.variant === "after") return `${base}, after`;
  return base;
};

export const pairTitleFor = (beforePath: string): string => {
  const subject = sentenceCase(parseEvidenceName(beforePath).subject);
  return subject ? `${subject}, before and after` : "Before and after";
};

export const stackTitleFor = (
  filePaths: string[],
  kind: EvidenceSourceKind,
): string => {
  const shared: string[] = [];
  const tokenLists = filePaths.map((filePath) => parseEvidenceName(filePath).subject);
  const first = tokenLists[0] ?? [];
  for (const token of first) {
    if (tokenLists.every((tokens) => tokens.includes(token))) shared.push(token);
  }
  const subject = sentenceCase(shared);
  const plural = kind === "image" ? "screens" : `${KIND_NOUN[kind]}s`;
  return subject ? `${subject} ${plural}` : sentenceCase([plural]);
};

export const describeComposition = (
  extensions: string[],
): { label: string; count: number }[] => {
  const counts = new Map<string, number>();
  for (const extension of extensions) {
    const normalized = extension.toLowerCase().replace(/^\./, "");
    const label = normalized ? normalized.toUpperCase() : "other";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, 4);
};

export const formatByteSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`;
};

export const formatDuration = (milliseconds: number): string => {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};
