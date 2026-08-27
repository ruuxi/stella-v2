import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { ANTHROPIC_DIRECT_MAX_IMAGE_BASE64_BYTES } from "../ai/utils/image-caps.js";
import type { RuntimeAttachmentRef } from "@stella/contracts/protocol";

export const INLINE_IMAGE_ATTACHMENT_BUDGET_BYTES = 10 * 1024 * 1024;

export type SpilledImageAttachment = {
  filePath: string;
  mimeType: string;
  bytes: number;
  attachmentIndex?: number;
};

const DATA_URL_RE = /^data:([^;,]+);base64,(.+)$/i;

const normalizeMimeType = (value: string | null | undefined): string =>
  value?.split(";")[0]?.trim().toLowerCase() ?? "";

const imageExtensionFromMimeType = (mimeType: string): string => {
  switch (mimeType) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return ".png";
  }
};

export const approximateDataUrlBytes = (url: string): number => {
  const match = DATA_URL_RE.exec(url);
  return Math.floor(((match?.[2]?.length ?? 0) * 3) / 4);
};

export const MAX_INLINE_IMAGE_BASE64_BYTES =
  ANTHROPIC_DIRECT_MAX_IMAGE_BASE64_BYTES;

export const dataUrlBase64Length = (url: string): number =>
  DATA_URL_RE.exec(url)?.[2]?.length ?? 0;

export const spillImageAttachmentsToDisk = async (args: {
  stellaDataDirPath: string;
  conversationId: string;
  attachments: RuntimeAttachmentRef[];
}): Promise<SpilledImageAttachment[]> => {
  const dir = path.join(
    args.stellaDataDirPath,
    "cache",
    "chat-attachments",
    args.conversationId.replace(/[^a-zA-Z0-9_-]/g, "-"),
  );
  await fs.mkdir(dir, { recursive: true });
  const stamp = `${Date.now()}-${randomUUID()}`;
  const spilled: SpilledImageAttachment[] = [];
  for (const [index, attachment] of args.attachments.entries()) {
    const match = DATA_URL_RE.exec(attachment.url);
    if (!match) continue;
    const mimeType =
      normalizeMimeType(attachment.mimeType) || normalizeMimeType(match[1]);
    const data = Buffer.from(match[2] ?? "", "base64");
    const filePath = path.join(
      dir,
      `${stamp}-${index + 1}${imageExtensionFromMimeType(mimeType)}`,
    );
    await fs.writeFile(filePath, data);
    spilled.push({
      filePath,
      mimeType,
      bytes: data.length,
      attachmentIndex: index,
    });
  }
  return spilled;
};

export const attachPersistedImagePaths = (
  attachments: RuntimeAttachmentRef[],
  persisted: SpilledImageAttachment[],
): RuntimeAttachmentRef[] => {
  const pathByAttachmentIndex = new Map(
    persisted.map((file, index) => [
      file.attachmentIndex ?? index,
      file.filePath,
    ]),
  );
  return attachments.map((attachment, index) => {
    const sourcePath = pathByAttachmentIndex.get(index);
    return sourcePath ? { ...attachment, sourcePath } : attachment;
  });
};

export const buildSpilledAttachmentNotice = (
  spilled: SpilledImageAttachment[],
): string => {
  const formatMegabytes = (bytes: number) =>
    `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return [
    `The user attached ${spilled.length === 1 ? "an image" : `${spilled.length} images`} with this message. The set was too large to inline into the conversation, so the files were saved to disk instead:`,
    ...spilled.map(
      (file, index) =>
        `${index + 1}. ${file.filePath} (${file.mimeType}, ${formatMegabytes(file.bytes)})`,
    ),
    `Use the Read tool with file_path set to these absolute paths to inspect whichever images the request needs — read a few at a time rather than all at once. When delegating work that depends on them, pass the file paths along in the agent prompt.`,
  ].join("\n");
};
