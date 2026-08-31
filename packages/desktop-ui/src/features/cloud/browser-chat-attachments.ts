import { useSyncExternalStore } from "react";
import { convexClient } from "@/platform/convex/convex-client";
import { driveApi } from "./cloud-api";
import { cloudAttachmentsStore } from "./cloud-composer-store";

export const BROWSER_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const BROWSER_ATTACHMENT_MAX_FILES = 10;
const BROWSER_IMAGE_SOURCE_MAX_BYTES = 100 * 1024 * 1024;
const BROWSER_IMAGE_MAX_EDGE = 4096;
const BROWSER_IMAGE_TARGET_BYTES = 18 * 1024 * 1024;

export type BrowserAttachmentUpload = {
  id: string;
  file: File;
  name: string;
  sizeBytes: number;
  path: string | null;
  previewUrl: string | null;
  progress: number;
  status: "pending" | "uploading" | "finalizing" | "ready" | "error";
  error: string | null;
};

let uploads: readonly BrowserAttachmentUpload[] = [];
const listeners = new Set<() => void>();
const activeRequests = new Map<string, XMLHttpRequest>();
const notify = () => listeners.forEach((listener) => listener());
const replace = (id: string, patch: Partial<BrowserAttachmentUpload>) => {
  uploads = uploads.map((entry) =>
    entry.id === id ? { ...entry, ...patch } : entry,
  );
  notify();
};

const revokePreview = (entry: BrowserAttachmentUpload): void => {
  if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
};

const IN_FLIGHT: ReadonlySet<BrowserAttachmentUpload["status"]> = new Set([
  "pending",
  "uploading",
  "finalizing",
]);

const waitForUploadChange = (): Promise<void> =>
  new Promise((resolve) => {
    const listener = () => {
      listeners.delete(listener);
      resolve();
    };
    listeners.add(listener);
  });

export const waitForCloudAttachmentUploads = async (): Promise<void> => {
  while (uploads.some((entry) => IN_FLIGHT.has(entry.status))) {
    await waitForUploadChange();
  }
  const failed = uploads.find((entry) => entry.status === "error");
  if (failed)
    throw new Error(failed.error || `Couldn’t upload ${failed.name}.`);
};

const rejectReason = (file: File): string | null => {
  if (file.size <= 0) return "This file is empty.";
  const isImage = file.type.startsWith("image/");
  if (isImage && file.size > BROWSER_IMAGE_SOURCE_MAX_BYTES) {
    return "This image is too large to resize safely in the browser.";
  }
  if (!isImage && file.size > BROWSER_ATTACHMENT_MAX_BYTES) {
    return "This file is larger than 20 MB.";
  }
  return null;
};

const safeName = (name: string): string => {
  const boundedCharacters = Array.from(name.normalize("NFKC"), (character) => {
    const code = character.charCodeAt(0);
    return character === "/" || character === "\\" || code < 32 || code === 127
      ? "-"
      : character;
  }).join("");
  const cleaned = boundedCharacters
    .replace(/-+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+/g, "")
    .trim();
  return (cleaned || "attachment").slice(0, 180);
};

export const browserAttachmentDrivePath = (
  file: Pick<File, "name">,
  id: string,
  now = new Date(),
): string =>
  `/Chat Attachments/${now.toISOString().slice(0, 10)}/${id.slice(-8)}-${safeName(file.name)}`;

const putWithProgress = (
  upload: BrowserAttachmentUpload,
  url: string,
  contentType: string,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    activeRequests.set(upload.id, request);
    request.open("PUT", url);
    request.setRequestHeader("content-type", contentType);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        replace(upload.id, {
          progress: Math.max(0, Math.min(0.99, event.loaded / event.total)),
        });
      }
    };
    request.onerror = () => reject(new Error("The upload connection failed."));
    request.onabort = () => reject(new Error("Upload canceled."));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error(`Upload failed (${request.status}).`));
    };
    request.onloadend = () => activeRequests.delete(upload.id);
    request.send(upload.file);
  });

const canvasBlob = (
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Couldn’t resize this image.")),
      type,
      quality,
    );
  });

export const resizeOversizedBrowserImage = async (
  file: File,
): Promise<File> => {
  if (file.size <= BROWSER_ATTACHMENT_MAX_BYTES) return file;
  if (!file.type.toLowerCase().startsWith("image/")) {
    throw new Error("This file is larger than 20 MB.");
  }
  if (file.size > BROWSER_IMAGE_SOURCE_MAX_BYTES) {
    throw new Error("This image is too large to resize safely in the browser.");
  }

  const bitmap = await createImageBitmap(file);
  try {
    const edgeScale = Math.min(
      1,
      BROWSER_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height),
    );
    let scale = Math.min(
      edgeScale,
      Math.sqrt(BROWSER_IMAGE_TARGET_BYTES / file.size),
    );
    let quality = 0.86;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Image resizing isn’t available.");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await canvasBlob(canvas, "image/webp", quality);
      if (blob.size <= BROWSER_ATTACHMENT_MAX_BYTES) {
        const stem = file.name.replace(/\.[^.]+$/, "") || "image";
        return new File([blob], `${stem}.webp`, {
          type: "image/webp",
          lastModified: file.lastModified,
        });
      }
      scale *= 0.78;
      quality = Math.max(0.62, quality - 0.08);
    }
    throw new Error("This image couldn’t be reduced below 20 MB.");
  } finally {
    bitmap.close();
  }
};

const uploadOne = async (upload: BrowserAttachmentUpload): Promise<void> => {
  try {
    const file = await resizeOversizedBrowserImage(upload.file);
    const path = browserAttachmentDrivePath(file, upload.id);
    const contentType = file.type || "application/octet-stream";
    const preparedUpload = { ...upload, file };
    replace(upload.id, {
      file,
      name: file.name,
      sizeBytes: file.size,
      status: "uploading",
      progress: 0,
      error: null,
      path,
    });
    const prepared = await convexClient.action(driveApi.prepareDriveUpload, {
      path,
      sizeBytes: file.size,
      contentType,
    });
    await putWithProgress(
      preparedUpload,
      prepared.uploadUrl,
      prepared.contentType,
    );
    replace(upload.id, { status: "finalizing", progress: 0.99 });
    const finalized = await convexClient.action(driveApi.finalizeDriveUpload, {
      path: prepared.path,
      uploadId: prepared.uploadId,
      contentType,
      source: "web-chat",
    });
    cloudAttachmentsStore.add({
      path: finalized.path,
      name: finalized.name,
      sizeBytes: finalized.sizeBytes,
      contentType: finalized.contentType,
    });
    replace(upload.id, {
      status: "ready",
      path: finalized.path,
      progress: 1,
      error: null,
    });
  } catch (error) {
    replace(upload.id, {
      status: "error",
      error: error instanceof Error ? error.message : "Upload failed.",
    });
  }
};

export const browserAttachmentUploads = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => uploads,
  add(files: readonly File[]) {
    const room = Math.max(0, BROWSER_ATTACHMENT_MAX_FILES - uploads.length);
    for (const file of files.slice(0, room)) {
      const id = `upload-${crypto.randomUUID()}`;
      const error = rejectReason(file);
      const entry: BrowserAttachmentUpload = {
        id,
        file,
        name: file.name,
        sizeBytes: file.size,
        path: null,
        previewUrl: file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : null,
        progress: 0,
        status: error ? "error" : "pending",
        error,
      };
      uploads = [...uploads, entry];
      notify();
      if (entry.status === "pending") void uploadOne(entry);
    }
  },
  retry(id: string) {
    const entry = uploads.find((upload) => upload.id === id);
    if (entry?.status === "error") void uploadOne(entry);
  },
  remove(id: string) {
    const entry = uploads.find((upload) => upload.id === id);
    activeRequests.get(id)?.abort();
    if (entry?.path) cloudAttachmentsStore.remove(entry.path);
    if (entry) revokePreview(entry);
    uploads = uploads.filter((upload) => upload.id !== id);
    notify();
  },
  clearReady(paths: ReadonlySet<string>) {
    for (const entry of uploads) {
      if (entry.path && paths.has(entry.path) && entry.status === "ready") {
        revokePreview(entry);
      }
    }
    uploads = uploads.filter(
      (entry) =>
        !(entry.path && paths.has(entry.path) && entry.status === "ready"),
    );
    notify();
  },
};

const EMPTY: readonly BrowserAttachmentUpload[] = [];
export const useBrowserAttachmentUploads = () =>
  useSyncExternalStore(
    browserAttachmentUploads.subscribe,
    browserAttachmentUploads.getSnapshot,
    () => EMPTY,
  );

export const hasPendingCloudAttachmentUploads = (): boolean =>
  uploads.some((entry) => IN_FLIGHT.has(entry.status));
