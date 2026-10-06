import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { BackendClient } from "@stella/contracts/backend/client";
import type { DeviceFileRecordInput } from "@stella/contracts/backend/drive";
import { isCloudWorkspacePath } from "@stella/contracts/cloud-world-paths";
import {
  DEVICE_FILE_COPY_LIMITS,
  deviceFileCopyDrivePath,
} from "@stella/contracts/device-files";
import { extractLocalFileLinkPaths } from "@stella/contracts/local-file-links";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".mdx": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".py": "text/x-python",
  ".sh": "text/x-shellscript",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".zip": "application/zip",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const contentTypeFor = (filePath: string): string =>
  CONTENT_TYPES[path.extname(filePath).toLowerCase()] ??
  "application/octet-stream";

const PUBLISHED_MEMORY = 2_000;

export type LinkedFilePublisher = {
  publishText: (markdown: string) => void;
  idle: () => Promise<void>;
};

export const createLinkedFilePublisher = (deps: {
  deviceId: string;
  deviceName: string;
  getClient: () => BackendClient | null;
  isSignedIn: () => boolean;
  fetchImpl?: typeof fetch;
  onLog?: (event: string, fields: Record<string, unknown>) => void;
}): LinkedFilePublisher => {
  const published = new Map<string, string>();
  let queue: Promise<void> = Promise.resolve();

  const remember = (sourcePath: string, signature: string) => {
    published.delete(sourcePath);
    published.set(sourcePath, signature);
    while (published.size > PUBLISHED_MEMORY) {
      const oldest = published.keys().next().value;
      if (oldest === undefined) break;
      published.delete(oldest);
    }
  };

  const copyToDrive = async (
    client: BackendClient,
    sourcePath: string,
    contentType: string,
  ): Promise<{ drivePath: string; sizeBytes: number }> => {
    const bytes = await fs.readFile(sourcePath);
    const prepared = await client.call("drive.prepareUpload", {
      path: deviceFileCopyDrivePath({
        deviceName: deps.deviceName,
        sourceDigest: createHash("sha256")
          .update(`${deps.deviceId}\0${sourcePath}`)
          .digest("hex"),
        fileName: path.basename(sourcePath),
      }),
      sizeBytes: bytes.byteLength,
      contentType,
    });
    const response = await (deps.fetchImpl ?? fetch)(prepared.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": prepared.contentType },
      body: bytes,
    });
    if (!response.ok) {
      throw new Error(`Drive upload failed (${response.status}).`);
    }
    const record = await client.call("drive.finalizeUpload", {
      path: prepared.path,
      uploadId: prepared.uploadId,
      contentType: prepared.contentType,
      source: "agent",
    });
    return { drivePath: record.path, sizeBytes: record.sizeBytes };
  };

  const publishPaths = async (paths: string[]): Promise<void> => {
    const client = deps.getClient();
    if (!client || !deps.isSignedIn()) return;
    const records: DeviceFileRecordInput[] = [];
    const signatures = new Map<string, string>();
    for (const sourcePath of paths) {
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(sourcePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const signature = `${stat.size}:${stat.mtimeMs}`;
      if (published.get(sourcePath) === signature) continue;
      const contentType = contentTypeFor(sourcePath);
      let copy: { drivePath: string; sizeBytes: number } | null = null;
      if (stat.size > 0 && stat.size <= DEVICE_FILE_COPY_LIMITS.maxFileBytes) {
        copy = await copyToDrive(client, sourcePath, contentType).catch(
          (error: unknown) => {
            deps.onLog?.("device_file_copy_failed", {
              file: path.basename(sourcePath),
              message: error instanceof Error ? error.message : String(error),
            });
            return null;
          },
        );
      }
      records.push({
        sourcePath,
        ...(copy ? { drivePath: copy.drivePath } : {}),
        sizeBytes: copy?.sizeBytes ?? stat.size,
        contentType,
      });
      signatures.set(sourcePath, signature);
    }
    if (records.length === 0) return;
    await client.call("drive.recordDeviceFiles", {
      deviceId: deps.deviceId,
      deviceName: deps.deviceName,
      files: records,
    });
    for (const [sourcePath, signature] of signatures) {
      remember(sourcePath, signature);
    }
    deps.onLog?.("device_files_recorded", {
      files: records.length,
      copied: records.filter((record) => record.drivePath).length,
    });
  };

  return {
    publishText: (markdown) => {
      let paths: string[];
      try {
        paths = extractLocalFileLinkPaths(markdown)
          .filter((filePath) => !isCloudWorkspacePath(filePath))
          .slice(0, DEVICE_FILE_COPY_LIMITS.maxFilesPerMessage);
      } catch {
        return;
      }
      if (paths.length === 0) return;
      queue = queue
        .then(() => publishPaths(paths))
        .catch((error: unknown) => {
          deps.onLog?.("device_files_record_failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        });
    },
    idle: () => queue,
  };
};

export const assistantPayloadText = (payloadJson: string): string => {
  try {
    const message = JSON.parse(payloadJson) as { content?: unknown };
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) return "";
    return message.content
      .flatMap((block) =>
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
          ? [(block as { text: string }).text]
          : [],
      )
      .join("\n\n");
  } catch {
    return "";
  }
};
