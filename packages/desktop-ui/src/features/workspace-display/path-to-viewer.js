import { DEVELOPER_EXTS } from "@stella/contracts/desktop/external-openers";

export const localFilePathForPayload = (payload) => {
    switch (payload.kind) {
        case "office":
            return payload.previewRef.sourcePath;
        case "markdown":
        case "source-diff":
        case "file-artifact":
        case "pdf":
            return payload.filePath;
        case "canvas-html":
            return payload.filePath;
        case "media":
            switch (payload.asset.kind) {
                case "image":
                    return payload.asset.filePaths[0] ?? null;
                case "video":
                case "audio":
                case "model3d":
                case "download":
                    return payload.asset.filePath;
                default:
                    return null;
            }
        default:
            return null;
    }
};
const IMAGE_EXTS = new Set([
    "png",
    "jpg",
    "jpeg",
    "webp",
    "avif",
    "gif",
    "bmp",
    "svg",
    "ico",
    "tif",
    "tiff",
]);
const PDF_EXTS = new Set(["pdf"]);
const OFFICE_DOC_EXTS = new Set(["doc", "docx"]);
const OFFICE_SHEET_EXTS = new Set(["xls", "xlsx", "xlsm", "csv", "tsv"]);
const OFFICE_PREVIEW_SHEET_EXTS = new Set(["xlsx", "xlsm"]);
const OFFICE_SLIDES_EXTS = new Set(["ppt", "pptx"]);
const DELIMITED_TABLE_EXTS = new Set(["csv", "tsv"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "m4a", "flac"]);
const MODEL3D_EXTS = new Set(["glb", "gltf", "obj", "stl"]);
const MARKDOWN_EXTS = new Set(["md", "mdx"]);
const DEVELOPER_RESOURCE_EXTS = new Set(DEVELOPER_EXTS);

const PREFERRED_RESOURCE_EXTS = new Set([
    ...OFFICE_DOC_EXTS,
    ...OFFICE_SHEET_EXTS,
    ...OFFICE_SLIDES_EXTS,
    ...PDF_EXTS,
    ...IMAGE_EXTS,
    ...VIDEO_EXTS,
    ...AUDIO_EXTS,
    ...MODEL3D_EXTS,
]);

const FALLBACK_RESOURCE_EXTS = new Set([
    ...PREFERRED_RESOURCE_EXTS,
    ...MARKDOWN_EXTS,
    "txt",
]);

export const extensionOf = (filePath) => {
    const trimmed = filePath.trim();
    if (trimmed.length === 0)
        return null;

    const cleaned = trimmed.split(/[?#]/)[0] ?? trimmed;
    const lastSlash = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
    const tail = lastSlash === -1 ? cleaned : cleaned.slice(lastSlash + 1);
    const dot = tail.lastIndexOf(".");
    if (dot <= 0 || dot === tail.length - 1)
        return null;
    return tail.slice(dot + 1).toLowerCase();
};
export const basenameOf = (filePath) => {
    const trimmed = filePath.trim();
    if (trimmed.length === 0)
        return filePath;
    const cleaned = trimmed.split(/[?#]/)[0] ?? trimmed;
    const lastSlash = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
    return lastSlash === -1 ? cleaned : cleaned.slice(lastSlash + 1);
};

export const kindForExtension = (extension) => {
    if (extension == null)
        return null;
    if (IMAGE_EXTS.has(extension))
        return "image";
    if (PDF_EXTS.has(extension))
        return "pdf";
    if (OFFICE_DOC_EXTS.has(extension))
        return "office-document";
    if (OFFICE_SHEET_EXTS.has(extension))
        return "office-spreadsheet";
    if (OFFICE_SLIDES_EXTS.has(extension))
        return "office-slides";
    if (MARKDOWN_EXTS.has(extension))
        return "markdown";
    if (VIDEO_EXTS.has(extension))
        return "video";
    if (AUDIO_EXTS.has(extension))
        return "audio";
    if (MODEL3D_EXTS.has(extension))
        return "model3d";
    return null;
};
export const kindForPath = (filePath) => kindForExtension(extensionOf(filePath));
const fileArtifactKindForPath = (filePath) => {
    const extension = extensionOf(filePath);
    if (extension == null)
        return null;
    if (OFFICE_DOC_EXTS.has(extension))
        return "office-document";
    if (DELIMITED_TABLE_EXTS.has(extension))
        return "delimited-table";
    if (OFFICE_PREVIEW_SHEET_EXTS.has(extension))
        return "office-spreadsheet";
    if (OFFICE_SLIDES_EXTS.has(extension))
        return "office-slides";
    return null;
};
export const fileArtifactPayloadForPath = (filePath, createdAt) => {
    const artifactKind = fileArtifactKindForPath(filePath);
    return artifactKind
        ? {
            kind: "file-artifact",
            filePath,
            artifactKind,
            title: basenameOf(filePath),
            ...(createdAt !== undefined ? { createdAt } : {}),
        }
        : null;
};
const isMarkdownExtension = (extension) => extension != null && MARKDOWN_EXTS.has(extension);

const DECLARED_OUTPUTS_RE = /(?:^|[\\/])(?:\.stella|state)[\\/]outputs[\\/]/;
export const isDeclaredOutputPath = (filePath) => DECLARED_OUTPUTS_RE.test(filePath);

export const isDeveloperResourceExtension = (extension) => extension != null && DEVELOPER_RESOURCE_EXTS.has(extension);

export const pickPrimaryEditedPath = (candidatePaths, options) => {
    if (candidatePaths.length === 0)
        return null;
    const seen = new Map();
    for (const raw of candidatePaths) {
        const cleaned = raw.trim();
        if (!cleaned)
            continue;
        if (!seen.has(cleaned)) {
            seen.set(cleaned, cleaned);
        }
    }
    const unique = [...seen.values()];
    if (unique.length === 0)
        return null;
    const preferred = unique.find((p) => {
        const ext = extensionOf(p);
        return ext != null && PREFERRED_RESOURCE_EXTS.has(ext);
    });
    if (preferred)
        return preferred;
    const markdown = unique.find((p) => isMarkdownExtension(extensionOf(p)));
    if (markdown)
        return markdown;
    if (unique.length === 1) {
        const only = unique[0];
        const ext = extensionOf(only);
        if (ext != null && FALLBACK_RESOURCE_EXTS.has(ext)) {
            return only;
        }
        if (options?.includeDeveloperResources === true &&
            isDeveloperResourceExtension(ext)) {
            return only;
        }
    }
    return null;
};

export const tabIdForPath = (filePath) => {
    const kind = kindForPath(filePath);
    if (kind === "pdf")
        return `pdf:${filePath}`;
    if (kind === "markdown")
        return `markdown:${filePath}`;
    if (kind === "office-document" ||
        kind === "office-spreadsheet" ||
        kind === "office-slides") {

        return `office:${filePath}`;
    }
    if (kind === "image")
        return `media:image:${filePath}`;
    if (kind === "video")
        return `media:video:${filePath}`;
    if (kind === "audio")
        return `media:audio:${filePath}`;
    if (kind === "model3d")
        return `media:model3d:${filePath}`;
    if (isDeveloperResourceExtension(extensionOf(filePath))) {

        return "source-diff";
    }
    return `file:${filePath}`;
};

export const isPreviewableExtension = (extension) => extension != null && PREFERRED_RESOURCE_EXTS.has(extension);
export const isFallbackPreviewableExtension = (extension) => extension != null && FALLBACK_RESOURCE_EXTS.has(extension);
