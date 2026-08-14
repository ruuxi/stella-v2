/**
 * `stella://file/<absolute-path>` — the assistant-facing scheme for
 * referencing a local file inside chat text (mirrors
 * `desktop-ui/src/features/chat/lib/stella-file-links.ts`).
 *
 * Mobile taps on such a link resolve the path into a `ChatArtifact` whose
 * payload matches what the desktop→mobile bridge ships for produced files,
 * so the tap opens the exact same `ArtifactViewer` path as an inline
 * artifact card (bytes fetched over the bridge / synced-file lane).
 */

export const STELLA_FILE_URL_PREFIX = "stella://file";

const isWindowsAbsolutePath = (candidate) => /^[A-Za-z]:[\\/]/.test(candidate);

const isAbsoluteLocalPath = (candidate) =>
  candidate.startsWith("/") || isWindowsAbsolutePath(candidate);

/**
 * Extract the absolute local path from a `stella://file/...` URL, or `null`
 * when the URL isn't a well-formed stella file reference. Accepted spellings
 * (the model won't be perfectly consistent):
 *   - `stella://file/Users/me/report.pdf`   (path appended directly)
 *   - `stella://file//Users/me/report.pdf`  (extra slash before the path)
 *   - percent-encoded paths (`My%20File.pdf`)
 *
 * @param {string} url
 * @returns {string | null}
 */
export const parseStellaFileUrl = (url) => {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed.toLowerCase().startsWith(STELLA_FILE_URL_PREFIX)) return null;
  let rest = trimmed.slice(STELLA_FILE_URL_PREFIX.length);
  if (rest.startsWith("/")) {
    // Collapse `file//Users/...` and `file/Users/...` to one form.
    rest = rest.replace(/^\/+/, "");
  } else if (rest.length > 0) {
    // `stella://filesomething` — a different (or malformed) deep link.
    return null;
  }
  if (!rest) return null;
  let decoded = rest;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    // Keep the raw spelling when percent-decoding fails.
  }
  const path = isWindowsAbsolutePath(decoded) ? decoded : `/${decoded}`;
  if (!isAbsoluteLocalPath(path) || path === "/") return null;
  return path;
};

const basenameOf = (filePath) => {
  const cleaned = filePath.trim().split(/[?#]/)[0] ?? filePath.trim();
  const slash = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return slash === -1 ? cleaned : cleaned.slice(slash + 1);
};

const extensionOf = (filePath) => {
  const tail = basenameOf(filePath);
  const dot = tail.lastIndexOf(".");
  return dot <= 0 || dot === tail.length - 1
    ? null
    : tail.slice(dot + 1).toLowerCase();
};

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "heic",
  "heif",
  "avif",
  "svg",
]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "m4a", "flac"]);
const MODEL3D_EXTS = new Set(["glb", "gltf", "obj", "stl"]);
const OFFICE_DOC_EXTS = new Set(["doc", "docx"]);
const OFFICE_SHEET_EXTS = new Set(["xlsx", "xlsm"]);
const OFFICE_SLIDES_EXTS = new Set(["ppt", "pptx"]);
const DELIMITED_TABLE_EXTS = new Set(["csv", "tsv"]);

/**
 * Map an absolute file path to the display payload the mobile viewer
 * understands. Mirrors the desktop `displayPayloadForStellaFile` special
 * case: HTML the assistant explicitly linked always opens as a canvas.
 * Anything without a richer viewer falls back to the markdown/text preview
 * (the viewer renders unknown bytes as plain text) so a tap never does
 * nothing.
 *
 * @param {string} filePath
 * @param {number} createdAt
 * @returns {import("../types").MobileDisplayPayload}
 */
export const displayPayloadForStellaFile = (filePath, createdAt) => {
  const title = basenameOf(filePath);
  const ext = extensionOf(filePath);
  if (ext === "html" || ext === "htm") {
    return { kind: "canvas-html", filePath, title, createdAt };
  }
  if (ext === "pdf") {
    return { kind: "pdf", filePath, title };
  }
  if (ext && IMAGE_EXTS.has(ext)) {
    return {
      kind: "media",
      asset: { kind: "image", filePaths: [filePath] },
      createdAt,
    };
  }
  if (ext && VIDEO_EXTS.has(ext)) {
    return { kind: "media", asset: { kind: "video", filePath }, createdAt };
  }
  if (ext && AUDIO_EXTS.has(ext)) {
    return { kind: "media", asset: { kind: "audio", filePath }, createdAt };
  }
  if (ext && MODEL3D_EXTS.has(ext)) {
    return { kind: "media", asset: { kind: "model3d", filePath }, createdAt };
  }
  if (ext && OFFICE_DOC_EXTS.has(ext)) {
    return {
      kind: "file-artifact",
      filePath,
      artifactKind: "office-document",
      title,
      createdAt,
    };
  }
  if (ext && OFFICE_SHEET_EXTS.has(ext)) {
    return {
      kind: "file-artifact",
      filePath,
      artifactKind: "office-spreadsheet",
      title,
      createdAt,
    };
  }
  if (ext && OFFICE_SLIDES_EXTS.has(ext)) {
    return {
      kind: "file-artifact",
      filePath,
      artifactKind: "office-slides",
      title,
      createdAt,
    };
  }
  if (ext && DELIMITED_TABLE_EXTS.has(ext)) {
    return {
      kind: "file-artifact",
      filePath,
      artifactKind: "delimited-table",
      title,
      createdAt,
    };
  }
  // Markdown, source files, plain text, and anything unrecognized: the
  // markdown payload's viewer path reads the bytes and renders them as
  // (markdown-formatted) text — a sensible default for any textual file.
  return { kind: "markdown", filePath, title, createdAt };
};

/**
 * Build the tappable `ChatArtifact` for a resolved stella-file path — the
 * same shape inline artifact cards carry, so the caller can feed it to the
 * existing `onOpenArtifact` viewer path unchanged.
 *
 * @param {string} filePath
 * @param {string} conversationId
 * @returns {import("../types").ChatArtifact}
 */
export const stellaFileChatArtifact = (filePath, conversationId) => {
  const payload = displayPayloadForStellaFile(filePath, Date.now());
  return {
    id: `${conversationId}:${payload.kind}:${filePath}`,
    conversationId,
    payload,
  };
};
