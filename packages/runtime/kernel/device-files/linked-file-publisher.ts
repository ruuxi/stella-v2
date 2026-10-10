import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { BackendClient } from "@stella/contracts/backend/client";
import type { DeviceFileRecordInput } from "@stella/contracts/backend/drive";
import { isCloudWorkspacePath } from "@stella/contracts/cloud-world-paths";
import {
  DEVICE_FILE_COPY_LIMITS,
  deviceFileCopyDrivePath,
} from "@stella/contracts/device-files";
import { extractLocalFileLinkPaths } from "@stella/contracts/local-file-links";
import {
  EVIDENCE_THUMBNAIL_CONTENT_TYPE,
  evidenceThumbnailDrivePath,
} from "@stella/contracts/chat-evidence-thumbnails";
import { renderEvidenceThumbnail } from "../shared/evidence-thumbnail.js";

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

export const contentTypeFor = (filePath: string): string =>
  CONTENT_TYPES[path.extname(filePath).toLowerCase()] ??
  "application/octet-stream";

const PUBLISHED_MEMORY = 2_000;

export type LinkedFilePublisher = {
  publishText: (markdown: string) => void;
  idle: () => Promise<void>;
};

type CopyResult =
  | { kind: "copied"; drivePath: string; sizeBytes: number }
  | { kind: "oversized"; sizeBytes: number };

const readBounded = async (
  sourcePath: string,
  maxBytes: number,
): Promise<Buffer | null> => {
  const handle = await fs.open(sourcePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset > maxBytes ? null : buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
};

export const createLinkedFilePublisher = (deps: {
  deviceId: string;
  deviceName: string;
  getBackendUrl: () => string | null;
  getAuthToken: () => string | null;
  ownerScopeOf: (token: string) => string | null;
  fetchImpl?: typeof fetch;
  onLog?: (event: string, fields: Record<string, unknown>) => void;
}): LinkedFilePublisher => {
  const published = new Map<string, string>();
  let queue: Promise<void> = Promise.resolve();

  const remember = (key: string, signature: string) => {
    published.delete(key);
    published.set(key, signature);
    while (published.size > PUBLISHED_MEMORY) {
      const oldest = published.keys().next().value;
      if (oldest === undefined) break;
      published.delete(oldest);
    }
  };

  const uploadToDrive = async (
    client: BackendClient,
    drivePath: string,
    bytes: Uint8Array,
    contentType: string,
  ) => {
    const prepared = await client.call("drive.prepareUpload", {
      path: drivePath,
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
    return await client.call("drive.finalizeUpload", {
      path: prepared.path,
      uploadId: prepared.uploadId,
      contentType: prepared.contentType,
      source: "agent",
    });
  };

  const publishThumbnail = async (
    client: BackendClient,
    copyPath: string,
    bytes: Uint8Array,
  ): Promise<void> => {
    const thumbnailPath = evidenceThumbnailDrivePath(copyPath);
    if (!thumbnailPath) return;
    try {
      const thumbnail = await renderEvidenceThumbnail(bytes);
      if (!thumbnail) return;
      await uploadToDrive(
        client,
        thumbnailPath,
        thumbnail,
        EVIDENCE_THUMBNAIL_CONTENT_TYPE,
      );
    } catch (error) {
      deps.onLog?.("device_file_thumbnail_failed", {
        file: path.basename(copyPath),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const copyToDrive = async (
    client: BackendClient,
    sourcePath: string,
    contentType: string,
  ): Promise<CopyResult> => {
    const bytes = await readBounded(
      sourcePath,
      DEVICE_FILE_COPY_LIMITS.maxFileBytes,
    );
    if (!bytes) {
      return {
        kind: "oversized",
        sizeBytes: DEVICE_FILE_COPY_LIMITS.maxFileBytes + 1,
      };
    }
    const record = await uploadToDrive(
      client,
      deviceFileCopyDrivePath({
        deviceName: deps.deviceName,
        sourceDigest: createHash("sha256")
          .update(`${deps.deviceId}\0${sourcePath}`)
          .digest("hex"),
        fileName: path.basename(sourcePath),
      }),
      bytes,
      contentType,
    );
    await publishThumbnail(client, record.path, bytes);
    return { kind: "copied", drivePath: record.path, sizeBytes: record.sizeBytes };
  };

  const copyWithRetry = async (
    client: BackendClient,
    sourcePath: string,
    contentType: string,
  ): Promise<CopyResult | null> => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await copyToDrive(client, sourcePath, contentType);
      } catch (error) {
        deps.onLog?.("device_file_copy_failed", {
          file: path.basename(sourcePath),
          attempt,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return null;
  };

  const publishPaths = async (
    paths: string[],
    job: { baseUrl: string; token: string; ownerScope: string },
  ): Promise<void> => {
    const stillSameOwner = () => {
      const token = deps.getAuthToken();
      return Boolean(token && deps.ownerScopeOf(token) === job.ownerScope);
    };
    if (!stillSameOwner()) return;
    const client = new BackendClient({
      baseUrl: job.baseUrl,
      getToken: async () => {
        const token = deps.getAuthToken()?.trim();
        if (!token || deps.ownerScopeOf(token) !== job.ownerScope) {
          throw new Error("The signed-in account changed before these files were copied.");
        }
        return token;
      },
    });
    try {
      const records: DeviceFileRecordInput[] = [];
      const settled = new Map<string, string>();
      for (const sourcePath of paths) {
        let stat: Awaited<ReturnType<typeof fs.stat>>;
        try {
          stat = await fs.stat(sourcePath);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        const key = `${job.ownerScope}\0${sourcePath}`;
        const signature = `${stat.size}:${stat.mtimeMs}`;
        if (published.get(key) === signature) continue;
        if (!stillSameOwner()) return;
        const contentType = contentTypeFor(sourcePath);
        const copy =
          stat.size > 0 && stat.size <= DEVICE_FILE_COPY_LIMITS.maxFileBytes
            ? await copyWithRetry(client, sourcePath, contentType)
            : ({ kind: "oversized", sizeBytes: stat.size } as const);
        records.push({
          sourcePath,
          ...(copy?.kind === "copied" ? { drivePath: copy.drivePath } : {}),
          sizeBytes: copy?.sizeBytes ?? stat.size,
          contentType,
        });
        if (copy) settled.set(key, signature);
      }
      if (records.length === 0 || !stillSameOwner()) return;
      await client.call("drive.recordDeviceFiles", {
        deviceId: deps.deviceId,
        deviceName: deps.deviceName,
        files: records,
      });
      for (const [key, signature] of settled) {
        remember(key, signature);
      }
      deps.onLog?.("device_files_recorded", {
        files: records.length,
        copied: records.filter((record) => record.drivePath).length,
      });
    } finally {
      client.dispose();
    }
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
      const baseUrl = deps.getBackendUrl()?.trim();
      const token = deps.getAuthToken()?.trim();
      const ownerScope = token ? deps.ownerScopeOf(token) : null;
      if (!baseUrl || !token || !ownerScope) {
        deps.onLog?.("device_files_skipped", {
          files: paths.length,
          reason: !baseUrl ? "no_backend" : !token ? "signed_out" : "no_owner",
        });
        return;
      }
      const job = { baseUrl, token, ownerScope };
      queue = queue
        .then(() => publishPaths(paths, job))
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
