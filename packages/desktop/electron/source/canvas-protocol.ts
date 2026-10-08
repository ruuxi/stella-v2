import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
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
 * - `outputs/<path>`: an `.html` file under the data dir's `outputs/`, read
 *   from disk per request.
 * - `memory/<id>`: HTML the renderer registered (a cloud canvas, or a file
 *   from elsewhere), under a random id.
 */
export const CANVAS_SCHEME = "stella-canvas";
const OUTPUTS_HOST = "outputs";
const MEMORY_HOST = "memory";

export const CANVAS_SCHEME_PRIVILEGES = {
  scheme: CANVAS_SCHEME,
  privileges: { standard: true, secure: true },
} as const;

export const MAX_CANVAS_HTML_BYTES = 16 * 1024 * 1024;
const MAX_REGISTERED_CANVASES = 32;
const MAX_REGISTERED_BYTES = 64 * 1024 * 1024;

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
  "media-src https: data: blob:",
  `connect-src ${CANVAS_CDN_SOURCES}`,
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const canvasResponse = (
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
) =>
  new Response(body, {
    status,
    headers: {
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

/**
 * The real path of an existing `.html` file inside `outputs/`, or null.
 * Symlinks are resolved before the containment check, so a link planted in
 * `outputs/` cannot serve a file from outside it.
 */
const resolveOutputsHtml = async (stellaDataDir: string, candidate: string) => {
  if (path.extname(candidate).toLowerCase() !== ".html") return null;
  const root = await realpathOrNull(path.join(stellaDataDir, "outputs"));
  const file = await realpathOrNull(candidate);
  if (!root || !file || !file.startsWith(root + path.sep)) return null;
  if (path.extname(file).toLowerCase() !== ".html") return null;
  const stats = await fs.stat(file).catch(() => null);
  if (!stats?.isFile()) return null;
  return { root, file, size: stats.size };
};

/**
 * The `stella-canvas://outputs/...` URL for a local file, or null when it is
 * not an existing `.html` file under the data dir's `outputs/`.
 */
export const canvasUrlForOutputsFile = async (
  stellaDataDir: string,
  filePath: string,
): Promise<string | null> => {
  const resolved = await resolveOutputsHtml(stellaDataDir, path.resolve(filePath));
  if (!resolved) return null;
  const segments = path
    .relative(resolved.root, resolved.file)
    .split(path.sep)
    .map(encodeURIComponent);
  return `${CANVAS_SCHEME}://${OUTPUTS_HOST}/${segments.join("/")}`;
};

const readCanvasDocument = async (
  url: string,
  stellaDataDir: string,
): Promise<string | null> => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.host === MEMORY_HOST) {
    return touchRegistered(parsed.pathname.slice(1))?.html ?? null;
  }
  if (parsed.host !== OUTPUTS_HOST) return null;
  let segments: string[];
  try {
    segments = parsed.pathname.split("/").slice(1).map(decodeURIComponent);
  } catch {
    return null;
  }
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !segment || segment === "." || segment === ".." || /[\\/\0]/.test(segment),
    )
  ) {
    return null;
  }
  const resolved = await resolveOutputsHtml(
    stellaDataDir,
    path.join(stellaDataDir, "outputs", ...segments),
  );
  if (!resolved || resolved.size > MAX_CANVAS_HTML_BYTES) return null;
  return await fs.readFile(resolved.file, "utf8").catch(() => null);
};

/** Serve canvases on a session partition (each renderer partition needs it). */
export const serveCanvasProtocol = (partition: string, stellaDataDir: string) => {
  const partitionSession = session.fromPartition(partition);
  if (partitionSession.protocol.isProtocolHandled(CANVAS_SCHEME)) return;
  partitionSession.protocol.handle(CANVAS_SCHEME, async (request) => {
    if (request.method !== "GET") return canvasResponse(405, "Method not allowed");
    const html = await readCanvasDocument(request.url, stellaDataDir);
    if (html === null) return canvasResponse(404, "Not found");
    return canvasResponse(200, injectCanvasBridge(html), "text/html; charset=utf-8");
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
