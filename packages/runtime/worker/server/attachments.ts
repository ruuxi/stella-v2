import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
// Photon itself is lazy-loaded inside resizeImage, so this import adds no
// WASM parse cost to the worker-ready path.
import { resizeImage } from "../../kernel/shared/image-resize.js";
import {
  resolveImageCaps,
  type ImageCapTarget,
  type ImageCaps,
} from "../../ai/utils/image-caps.js";
import {
  detectImageMimeTypeFromBytes,
  imageMimeTypeFromPath,
} from "../../kernel/shared/image-mime.js";
import type { RuntimeAttachmentRef } from "@stella/contracts/protocol";
import { createRuntimeLogger } from "../../kernel/debug.js";

const logger = createRuntimeLogger("worker.server");

export const asTrimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const DATA_URL_RE = /^data:([^;,]+);base64,(.+)$/i;
const HTTP_URL_RE = /^https?:\/\//i;

export type MaterializedImageAttachment = {
  index: number;
  attachment: RuntimeAttachmentRef;
};

const normalizeAttachmentMimeType = (
  value: string | null | undefined,
): string => value?.split(";")[0]?.trim().toLowerCase() ?? "";

const isImageMimeType = (mimeType: string): boolean =>
  mimeType.startsWith("image/");

const encodeImageDataUrl = (mimeType: string, data: ArrayBuffer): string =>
  `data:${mimeType};base64,${Buffer.from(data).toString("base64")}`;

/**
 * Pi-style attachment sizing: resize each composer image to fit the
 * per-image vision budget before it ever reaches the prompt. With every
 * image ≤4.5MB base64 (typically a few hundred KB), whole batches inline
 * directly and the spill-to-disk + Read fallback only triggers for
 * genuinely huge sets. Falls back to the original bytes when Photon
 * can't decode the format.
 */
const resizeImageDataUrl = async (
  dataUrl: string,
  mimeType: string,
  caps?: ImageCaps,
): Promise<string> => {
  const match = DATA_URL_RE.exec(dataUrl);
  if (!match) return dataUrl;
  try {
    const resized = await resizeImage(
      Buffer.from(match[2] ?? "", "base64"),
      mimeType,
      caps,
    );
    if (!resized?.wasResized) return dataUrl;
    return `data:${resized.mimeType};base64,${resized.data}`;
  } catch {
    return dataUrl;
  }
};

const FILE_URL_RE = /^file:\/\//i;

const isLocalFileAttachmentUrl = (url: string): boolean =>
  FILE_URL_RE.test(url) || path.isAbsolute(url);

const materializeLocalFileImage = async (
  url: string,
  caps?: ImageCaps,
): Promise<RuntimeAttachmentRef | null> => {
  const filePath = FILE_URL_RE.test(url) ? fileURLToPath(url) : url;
  const data = await fsPromises.readFile(filePath);
  const mimeType =
    detectImageMimeTypeFromBytes(data) ?? imageMimeTypeFromPath(filePath);
  if (!mimeType) {
    return null;
  }
  const resized = await resizeImage(data, mimeType, caps);
  if (resized) {
    return {
      url: `data:${resized.mimeType};base64,${resized.data}`,
      mimeType: resized.mimeType,
    };
  }
  return {
    url: `data:${mimeType};base64,${data.toString("base64")}`,
    mimeType,
  };
};

export const materializeImageAttachments = async (
  attachments: RuntimeAttachmentRef[] | undefined,
  target?: ImageCapTarget,
): Promise<MaterializedImageAttachment[]> => {
  const materialized: MaterializedImageAttachment[] = [];
  // Resize composer attachments to the resolved target provider's limits
  // (e.g. Anthropic's 2576px high-res tier) rather than a blunt global cap.
  // Falls back to the safe conservative profile when the target is unknown.
  const caps = resolveImageCaps({
    ...(target ?? {}),
    imageCount: (attachments ?? []).length,
  });

  for (const [index, attachment] of (attachments ?? []).entries()) {
    const url = asTrimmedString(attachment.url);
    if (!url) {
      continue;
    }

    const declaredMimeType = normalizeAttachmentMimeType(attachment.mimeType);
    if ((declaredMimeType && !isImageMimeType(declaredMimeType)) || (attachment.kind === "file" && !declaredMimeType)) {
      continue;
    }

    // Path-backed composer attachments: the renderer keeps only the
    // path + preview; the original bytes are read and resized here.
    if (isLocalFileAttachmentUrl(url)) {
      try {
        const localImage = await materializeLocalFileImage(url, caps);
        if (localImage) {
          materialized.push({ index, attachment: localImage });
        }
      } catch (error) {
        logger.warn("startChat.attachment-materialize-failed", {
          url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }

    const hintedMimeType = normalizeAttachmentMimeType(attachment.mimeType);
    const dataUrlMatch = DATA_URL_RE.exec(url);
    if (dataUrlMatch) {
      const mimeType =
        hintedMimeType || normalizeAttachmentMimeType(dataUrlMatch[1]);
      if (!isImageMimeType(mimeType)) {
        continue;
      }
      const resizedUrl = await resizeImageDataUrl(url, mimeType, caps);
      materialized.push({
        index,
        attachment: {
          url: resizedUrl,
          mimeType:
            DATA_URL_RE.exec(resizedUrl)?.[1]?.toLowerCase() ?? mimeType,
        },
      });
      continue;
    }

    if (!HTTP_URL_RE.test(url)) {
      continue;
    }
    if (hintedMimeType && !isImageMimeType(hintedMimeType)) {
      continue;
    }

    try {
      const response = await fetch(url);
      if (!response.ok) {
        logger.warn("startChat.attachment-materialize-failed", {
          url,
          status: response.status,
          statusText: response.statusText,
        });
        continue;
      }

      const responseMimeType = normalizeAttachmentMimeType(
        response.headers.get("content-type"),
      );
      const mimeType = responseMimeType || hintedMimeType;
      if (!isImageMimeType(mimeType)) {
        continue;
      }

      const fetchedUrl = encodeImageDataUrl(
        mimeType,
        await response.arrayBuffer(),
      );
      const resizedUrl = await resizeImageDataUrl(fetchedUrl, mimeType, caps);
      materialized.push({
        index,
        attachment: {
          url: resizedUrl,
          mimeType:
            DATA_URL_RE.exec(resizedUrl)?.[1]?.toLowerCase() ?? mimeType,
        },
      });
    } catch (error) {
      logger.warn("startChat.attachment-materialize-failed", {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return materialized;
};

/** Documents are downloaded by the worker, never decoded in the renderer.
 * Hosted URLs are owner-authorized signed URLs resolved by the placement host.
 * Keep the resulting files under this profile's conversation attachment cache.
 */
export const MAX_FILE_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const materializeFileAttachments = async (args: {
  attachments?: RuntimeAttachmentRef[];
  stellaDataDirPath: string;
  conversationId: string;
}): Promise<RuntimeAttachmentRef[]> => {
  const files: RuntimeAttachmentRef[] = [];
  for (const attachment of args.attachments ?? []) {
    const url = asTrimmedString(attachment.url);
    const mimeType = normalizeAttachmentMimeType(attachment.mimeType);
    if (!url || mimeType.startsWith("image/") || attachment.kind === "image") continue;
    if (attachment.kind !== "file" && !mimeType) continue;
    const name = attachment.name || "attachment";
    try {
      let sourcePath: string;
      let size: number;
      if (isLocalFileAttachmentUrl(url)) {
        sourcePath = FILE_URL_RE.test(url) ? fileURLToPath(url) : url;
        const stat = await fsPromises.stat(sourcePath);
        if (!stat.isFile()) throw new Error("Attachment is not a regular file");
        size = stat.size;
        if (size > MAX_FILE_ATTACHMENT_BYTES) throw new Error("Attachment exceeds 50 MiB");
      } else {
        let data: Buffer;
        const match = DATA_URL_RE.exec(url);
        if (match) {
          if (match[2].length > Math.ceil(MAX_FILE_ATTACHMENT_BYTES / 3) * 4) throw new Error("Attachment exceeds 50 MiB");
          data = Buffer.from(match[2], "base64");
        } else if (HTTP_URL_RE.test(url)) {
          const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
          if (!response.ok || !response.body) throw new Error(`Attachment download failed (${response.status})`);
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > MAX_FILE_ATTACHMENT_BYTES) throw new Error("Attachment exceeds 50 MiB");
              chunks.push(value);
            }
          } catch (error) {
            await reader.cancel().catch(() => {});
            throw error;
          } finally {
            reader.releaseLock();
          }
          data = Buffer.concat(chunks);
        } else {
          throw new Error("Unsupported attachment location");
        }
        size = data.byteLength;
        if (size > MAX_FILE_ATTACHMENT_BYTES) throw new Error("Attachment exceeds 50 MiB");
        const dir = path.join(args.stellaDataDirPath, "cache", "chat-attachments", args.conversationId.replace(/[^a-zA-Z0-9_-]/g, "-"));
        await fsPromises.mkdir(dir, { recursive: true, mode: 0o700 });
        const safeName = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "-").slice(-120) || "attachment";
        sourcePath = path.join(dir, `${randomUUID()}-${safeName}`);
        await fsPromises.writeFile(sourcePath, data, { flag: "wx", mode: 0o600 });
      }
      files.push({ ...attachment, url: sourcePath, sourcePath, size, kind: "file" });
    } catch (error) {
      // Fail explicitly rather than silently claiming an inaccessible document
      // was supplied. Never log a signed download URL.
      throw new Error(`Unable to prepare attachment ${JSON.stringify(name)}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  return files;
};
