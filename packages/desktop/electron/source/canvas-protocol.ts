import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { app, session } from "electron";
import { injectCanvasBridge } from "./canvas-bridge.js";

/**
 * `stella-canvas://` is where canvases render: model-authored HTML from the
 * `html` tool, cloud canvases, and HTML documents agents produce.
 *
 * As `srcdoc` a canvas inherited the app's CSP, which blocks the inline and
 * CDN scripts a canvas is made of. Served from its own scheme it gets its own
 * policy, the header below. Its `sandbox allow-scripts` (no
 * `allow-same-origin`) gives the document an opaque origin whether or not the
 * iframe is sandboxed too, so a canvas cannot read the app's DOM, storage,
 * cookies or preload API, open popups, or navigate the window.
 *
 * Two hosts:
 * - `dir/<token>/<path>`: a local `.html` file and what sits beside it, read
 *   from disk per request. The token stands for the document's own folder,
 *   so its relative images, styles and scripts load, and nothing outside
 *   that folder does.
 * - `memory/<id>`: HTML the renderer registered (a cloud canvas, or a file
 *   kept on another device), under a random id.
 */
export const CANVAS_SCHEME = "stella-canvas";
const DIRECTORY_HOST = "dir";
const MEMORY_HOST = "memory";

export const CANVAS_SCHEME_PRIVILEGES = {
  scheme: CANVAS_SCHEME,
  privileges: { standard: true, secure: true },
} as const;

export const MAX_CANVAS_HTML_BYTES = 16 * 1024 * 1024;
const MAX_REGISTERED_CANVASES = 32;
const MAX_REGISTERED_BYTES = 64 * 1024 * 1024;
const MAX_DOCUMENT_DIRECTORIES = 256;
const MAX_CANVAS_ASSET_BYTES = 256 * 1024 * 1024;

const ASSET_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
};

/**
 * Where a canvas may load scripts, styles and fonts from, and fetch. Never
 * `stella-media:` (it serves any absolute path to any origin), `stella-app:`,
 * or a wildcard.
 */
const CANVAS_CDN_SOURCES = [
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://cdnjs.cloudflare.com",
  "https://cdn.tailwindcss.com",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
  "https://esm.sh",
].join(" ");

// `unsafe-eval` adds nothing to what inline scripts can already do here, and
// in-browser compilers (Babel standalone, Alpine, Vue's template build) need it.
const CANVAS_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${CANVAS_CDN_SOURCES}`,
  `style-src 'self' 'unsafe-inline' ${CANVAS_CDN_SOURCES}`,
  `font-src 'self' data: ${CANVAS_CDN_SOURCES}`,
  "img-src 'self' https: data: blob:",
  "media-src 'self' https: data: blob:",
  `connect-src ${CANVAS_CDN_SOURCES}`,
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const canvasResponse = (
  status: number,
  body: string | ReadableStream<Uint8Array>,
  contentType = "text/plain; charset=utf-8",
  extraHeaders: Record<string, string> = {},
) =>
  new Response(body, {
    status,
    headers: {
      ...extraHeaders,
      "content-type": contentType,
      "content-security-policy": CANVAS_CSP,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });

export const isCanvasUrl = (url: string): boolean =>
  url.startsWith(`${CANVAS_SCHEME}:`);

// Insertion order is recency: a lookup re-inserts, eviction takes the first.
const registered = new Map<string, { html: string; bytes: number; digest: string }>();
const idByDigest = new Map<string, string>();
let registeredBytes = 0;

const touchRegistered = (id: string) => {
  const entry = registered.get(id);
  if (!entry) return null;
  registered.delete(id);
  registered.set(id, entry);
  return entry;
};

/** Hold `html` in memory and return the `stella-canvas://` URL that serves it. */
export const registerCanvasHtml = (html: string): string => {
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > MAX_CANVAS_HTML_BYTES) {
    throw new Error(
      `Canvas too large to display (${bytes} bytes, limit ${MAX_CANVAS_HTML_BYTES}).`,
    );
  }
  const digest = createHash("sha256").update(html).digest("hex");
  const existing = idByDigest.get(digest);
  if (existing && touchRegistered(existing)) {
    return `${CANVAS_SCHEME}://${MEMORY_HOST}/${existing}`;
  }
  const id = randomBytes(18).toString("base64url");
  registered.set(id, { html, bytes, digest });
  idByDigest.set(digest, id);
  registeredBytes += bytes;
  for (const [oldestId, oldest] of registered) {
    if (
      registered.size <= MAX_REGISTERED_CANVASES &&
      registeredBytes <= MAX_REGISTERED_BYTES
    ) {
      break;
    }
    if (oldestId === id) break;
    registered.delete(oldestId);
    idByDigest.delete(oldest.digest);
    registeredBytes -= oldest.bytes;
  }
  return `${CANVAS_SCHEME}://${MEMORY_HOST}/${id}`;
};

const realpathOrNull = async (target: string) => {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
};

const isHtmlPath = (target: string) => {
  const extension = path.extname(target).toLowerCase();
  return extension === ".html" || extension === ".htm";
};

// Insertion order is recency, as for `registered` above.
const directoryByToken = new Map<string, string>();
const tokenByDirectory = new Map<string, string>();

const tokenForDirectory = (directory: string) => {
  const existing = tokenByDirectory.get(directory);
  if (existing) {
    directoryByToken.delete(existing);
    directoryByToken.set(existing, directory);
    return existing;
  }
  const token = randomBytes(18).toString("base64url");
  directoryByToken.set(token, directory);
  tokenByDirectory.set(directory, token);
  for (const [oldestToken, oldestDirectory] of directoryByToken) {
    if (directoryByToken.size <= MAX_DOCUMENT_DIRECTORIES) break;
    directoryByToken.delete(oldestToken);
    tokenByDirectory.delete(oldestDirectory);
  }
  return token;
};

/**
 * The `stella-canvas://dir/...` URL for an `.html` file on this computer, or
 * null when there is no such file here. Symlinks are resolved first, so the
 * folder its assets load from is the one the file really lives in.
 */
export const canvasUrlForLocalFile = async (
  filePath: string,
): Promise<string | null> => {
  if (!isHtmlPath(filePath)) return null;
  const file = await realpathOrNull(path.resolve(filePath));
  if (!file || !isHtmlPath(file)) return null;
  const stats = await fs.stat(file).catch(() => null);
  if (!stats?.isFile()) return null;
  const token = tokenForDirectory(path.dirname(file));
  return `${CANVAS_SCHEME}://${DIRECTORY_HOST}/${token}/${encodeURIComponent(path.basename(file))}`;
};

type CanvasDocument =
  | { kind: "html"; html: string }
  | { kind: "file"; file: string; size: number };

/**
 * A file inside a registered document folder. Hidden files and folders are
 * never served, and the real path must stay inside the folder, so neither
 * `..` nor a symlink reaches anything beside or above it.
 */
const resolveDirectoryFile = async (
  token: string,
  segments: string[],
): Promise<{ file: string; size: number } | null> => {
  const directory = directoryByToken.get(token);
  if (!directory || segments.length === 0) return null;
  if (
    segments.some(
      (segment) =>
        !segment || segment.startsWith(".") || /[\\/\0]/.test(segment),
    )
  ) {
    return null;
  }
  const root = await realpathOrNull(directory);
  const file = await realpathOrNull(path.join(directory, ...segments));
  if (!root || !file || !file.startsWith(root + path.sep)) return null;
  if (path.relative(root, file).split(path.sep).some((part) => part.startsWith("."))) {
    return null;
  }
  const stats = await fs.stat(file).catch(() => null);
  if (!stats?.isFile()) return null;
  return { file, size: stats.size };
};

const readCanvasDocument = async (url: string): Promise<CanvasDocument | null> => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.host === MEMORY_HOST) {
    const html = touchRegistered(parsed.pathname.slice(1))?.html;
    return html === undefined ? null : { kind: "html", html };
  }
  if (parsed.host !== DIRECTORY_HOST) return null;
  let segments: string[];
  try {
    segments = parsed.pathname.split("/").slice(1).map(decodeURIComponent);
  } catch {
    return null;
  }
  const [token, ...rest] = segments;
  if (!token) return null;
  const resolved = await resolveDirectoryFile(token, rest);
  if (!resolved) return null;
  if (!isHtmlPath(resolved.file)) {
    return resolved.size > MAX_CANVAS_ASSET_BYTES
      ? null
      : { kind: "file", ...resolved };
  }
  if (resolved.size > MAX_CANVAS_HTML_BYTES) return null;
  const html = await fs.readFile(resolved.file, "utf8").catch(() => null);
  return html === null ? null : { kind: "html", html };
};

const assetResponse = (file: string, size: number) => {
  const contentType =
    ASSET_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const stream = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
  return canvasResponse(200, stream, contentType, {
    "content-length": String(size),
  });
};

/** Serve canvases on a session partition (each renderer partition needs it). */
export const serveCanvasProtocol = (partition: string) => {
  const partitionSession = session.fromPartition(partition);
  if (partitionSession.protocol.isProtocolHandled(CANVAS_SCHEME)) return;
  partitionSession.protocol.handle(CANVAS_SCHEME, async (request) => {
    if (request.method !== "GET") return canvasResponse(405, "Method not allowed");
    const document = await readCanvasDocument(request.url);
    if (document === null) return canvasResponse(404, "Not found");
    if (document.kind === "file") return assetResponse(document.file, document.size);
    return canvasResponse(
      200,
      injectCanvasBridge(document.html),
      "text/html; charset=utf-8",
    );
  });
};

/**
 * A canvas frame stays on the document it was given. The sandbox already
 * stops it navigating the window or opening popups; this stops it navigating
 * itself (assigning `location`, a meta refresh) anywhere else, including
 * another canvas. The app embedding it may still point the frame elsewhere.
 * Must run before any window exists.
 */
export const guardCanvasFrames = () => {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-frame-navigate", (details) => {
      const frame = details.frame;
      if (details.isMainFrame || !frame || !isCanvasUrl(frame.url)) return;
      if (details.url === frame.url) return;
      if (details.initiator && !isCanvasUrl(details.initiator.url)) return;
      details.preventDefault();
    });
  });
};
