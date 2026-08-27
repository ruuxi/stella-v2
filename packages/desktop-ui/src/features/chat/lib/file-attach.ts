import type { Dispatch, SetStateAction } from "react";
import type { ChatContext, ChatContextFile } from "@/shared/types/electron";

type AttachedScreenshot = {
  dataUrl: string;
  width: number;
  height: number;
  previewUrl?: string;
  filePath?: string;
};

type AttachedFile = ChatContextFile;

type ProcessedAttachments = {
  screenshots: AttachedScreenshot[];
  files: AttachedFile[];
};

const ATTACHMENT_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

const ATTACHMENT_MAX_FILE_SIZE = 20 * 1024 * 1024;

type SetChatContext = Dispatch<SetStateAction<ChatContext | null>>;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () =>
      reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

const PREVIEW_MAX_EDGE_PX = 1024;

function loadImageElement(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function encodePreview(
  source: CanvasImageSource,
  width: number,
  height: number,
): string | undefined {
  const scale = Math.min(1, PREVIEW_MAX_EDGE_PX / Math.max(width, height, 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/webp", 0.8);
}

async function decodeImageAttachment(
  file: File,
  dataUrl: string,
): Promise<{ width: number; height: number; previewUrl?: string }> {
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const previewUrl = encodePreview(bitmap, width, height);
    bitmap.close();
    return { width, height, ...(previewUrl ? { previewUrl } : {}) };
  } catch {
    const img = await loadImageElement(dataUrl);
    if (!img) return { width: 0, height: 0 };
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    const previewUrl = encodePreview(img, width, height);
    return { width, height, ...(previewUrl ? { previewUrl } : {}) };
  }
}

async function processPathBackedImage(
  file: File,
): Promise<AttachedScreenshot | null> {
  const filePath = window.electronAPI?.files?.getPathForFile?.(file);
  if (!filePath) return null;
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const previewUrl = encodePreview(bitmap, width, height);
    bitmap.close();
    if (!previewUrl) return null;
    return { dataUrl: previewUrl, previewUrl, filePath, width, height };
  } catch {
    return null;
  }
}

function isAttachableImage(mimeType: string): boolean {
  return ATTACHMENT_IMAGE_MIME_TYPES.has(mimeType);
}

async function processInputFiles(
  files: readonly File[],
): Promise<ProcessedAttachments> {
  const accepted = files.filter((f) => f.size <= ATTACHMENT_MAX_FILE_SIZE);
  if (accepted.length === 0) {
    return { screenshots: [], files: [] };
  }

  const imageFiles = accepted.filter((f) => isAttachableImage(f.type));
  const otherFiles = accepted.filter((f) => !isAttachableImage(f.type));

  const imageResults = await Promise.allSettled(
    imageFiles.map(async (file): Promise<AttachedScreenshot> => {
      const pathBacked = await processPathBackedImage(file);
      if (pathBacked) return pathBacked;
      const dataUrl = await readFileAsDataUrl(file);
      return { dataUrl, ...(await decodeImageAttachment(file, dataUrl)) };
    }),
  );

  const fileResults = await Promise.allSettled(
    otherFiles.map(async (file): Promise<AttachedFile> => {
      const dataUrl = await readFileAsDataUrl(file);

      const path = window.electronAPI?.files?.getPathForFile?.(file) || undefined;
      return {
        name: file.name,
        size: file.size,
        mimeType: file.type || "application/octet-stream",
        dataUrl,
        ...(path ? { path } : {}),
      };
    }),
  );

  return {
    screenshots: imageResults
      .filter(
        (r): r is PromiseFulfilledResult<AttachedScreenshot> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value),
    files: fileResults
      .filter(
        (r): r is PromiseFulfilledResult<AttachedFile> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value),
  };
}

export function applyProcessedAttachments(
  attachments: ProcessedAttachments,
  setChatContext: SetChatContext,
): boolean {
  const { screenshots, files } = attachments;
  if (screenshots.length === 0 && files.length === 0) return false;

  setChatContext((prev) => {
    const base = prev ?? { window: null };
    return {
      ...base,
      ...(screenshots.length > 0 && {
        regionScreenshots: [
          ...(base.regionScreenshots ?? []),
          ...screenshots,
        ],
      }),
      ...(files.length > 0 && {
        files: [...(base.files ?? []), ...files],
      }),
    };
  });
  return true;
}

export async function attachFilesToContext(
  files: readonly File[],
  setChatContext: SetChatContext,
): Promise<ProcessedAttachments> {
  const processed = await processInputFiles(files);
  applyProcessedAttachments(processed, setChatContext);
  return processed;
}
