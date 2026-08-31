import { parseLocalFileLinkTarget } from "@stella/contracts/local-file-links";

export const parseStellaFileUrl = parseLocalFileLinkTarget;

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

  return { kind: "markdown", filePath, title, createdAt };
};

export const stellaFileChatArtifact = (filePath, conversationId) => {
  const payload = displayPayloadForStellaFile(filePath, Date.now());
  return {
    id: `${conversationId}:${payload.kind}:${filePath}`,
    conversationId,
    payload,
  };
};
