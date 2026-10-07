import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import { BackendClient } from "@stella/contracts/backend/client";
import { contentTypeFor } from "../../device-files/linked-file-publisher.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.js";

export type DriveTransferToolOptions = {
  getCloudBackendAuth?: () => { baseUrl: string; authToken: string } | null;
};

const MAX_TRANSFER_BYTES = 500 * 1024 * 1024;

const DRIVE_TRANSFER_AGENT_TYPES = [
  AGENT_IDS.ORCHESTRATOR,
  AGENT_IDS.GENERAL,
] as const;

const DRIVE_TRANSFER_SEARCH_TERMS = [
  "drive",
  "stella drive",
  "upload",
  "download",
  "transfer",
  "send file",
  "move file",
  "copy file",
  "share file",
  "other device",
  "another computer",
  "mac",
  "laptop",
  "cross-device",
  "sha256",
] as const;

const failure = (message: string): ToolResult => ({ error: message });

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const expandHome = (value: string): string =>
  value === "~" || value.startsWith("~/")
    ? path.join(homedir(), value.slice(1))
    : value;

const resolveLocalPath = (
  value: string,
  context: ToolContext,
): string => {
  const expanded = expandHome(value.trim());
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(context.workingDirectory ?? homedir(), expanded);
};

const transferDate = (): string => new Date().toISOString().slice(0, 10);

const defaultDrivePath = (fileName: string): string =>
  `transfers/${transferDate()}/${fileName.replace(/[\u0000-\u001f\u007f/\\]/g, "-")}`;

const exists = async (target: string): Promise<boolean> =>
  fs.stat(target).then(
    () => true,
    () => false,
  );

const withClient = async (
  options: DriveTransferToolOptions,
  run: (client: BackendClient) => Promise<ToolResult>,
): Promise<ToolResult> => {
  const auth = options.getCloudBackendAuth?.();
  if (!auth) {
    return failure(
      "The user's Stella Drive is unavailable: this device is not signed in to Stella Cloud.",
    );
  }
  const client = new BackendClient({
    baseUrl: auth.baseUrl,
    getToken: async () =>
      options.getCloudBackendAuth?.()?.authToken ?? auth.authToken,
  });
  try {
    return await run(client);
  } catch (error) {
    return failure(
      `The user's drive refused that request: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    client.dispose();
  }
};

export const createDriveTransferTools = (
  options: DriveTransferToolOptions,
): ToolDefinition[] => [
  {
    name: "drive_upload",
    replay: "safe",
    agentTypes: DRIVE_TRANSFER_AGENT_TYPES,
    demoted: { searchTerms: DRIVE_TRANSFER_SEARCH_TERMS },
    description:
      "Upload a file from this computer into the user's own Stella Drive, which every device signed in to their account can read. Use it to move a file to another of the user's devices: upload here, then on the other device call drive_download with the returned drivePath and sha256. Returns drivePath, sizeBytes and sha256. Overwrites a drive file at the same drivePath.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Local file to upload. Absolute, or relative to the working directory; `~` expands.",
        },
        drivePath: {
          type: "string",
          description:
            "Where to put it in the drive, relative to the drive root (`transfers/report.pdf`). Defaults to `transfers/<date>/<file name>`.",
        },
      },
      required: ["path"],
    },
    execute: async (args, context) => {
      const input = (args ?? {}) as { path?: unknown; drivePath?: unknown };
      if (typeof input.path !== "string" || !input.path.trim()) {
        return failure("drive_upload requires the local file's path.");
      }
      const localPath = resolveLocalPath(input.path, context);
      const stat = await fs.stat(localPath).catch(() => null);
      if (!stat?.isFile()) {
        return failure(`${localPath} is not a file on this computer.`);
      }
      if (stat.size > MAX_TRANSFER_BYTES) {
        return failure(
          `${localPath} is ${stat.size} bytes, over the ${MAX_TRANSFER_BYTES}-byte limit for one drive transfer.`,
        );
      }
      const drivePath =
        typeof input.drivePath === "string" && input.drivePath.trim()
          ? input.drivePath.trim().replace(/^\/+/, "")
          : defaultDrivePath(path.basename(localPath));
      const bytes = await fs.readFile(localPath);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const contentType = contentTypeFor(localPath);
      return withClient(options, async (client) => {
        const prepared = await client.call("drive.prepareUpload", {
          path: drivePath,
          sizeBytes: bytes.byteLength,
          contentType,
        });
        const response = await fetch(prepared.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": prepared.contentType },
          body: bytes,
          signal: AbortSignal.timeout(10 * 60_000),
        });
        if (!response.ok) {
          return failure(`Uploading ${drivePath} failed (${response.status}).`);
        }
        const record = await client.call("drive.finalizeUpload", {
          path: prepared.path,
          uploadId: prepared.uploadId,
          contentType: prepared.contentType,
          source: "agent",
        });
        if (record.sizeBytes !== bytes.byteLength) {
          return failure(
            `The drive recorded ${record.sizeBytes} bytes for ${record.path}, but ${bytes.byteLength} were sent.`,
          );
        }
        const details = {
          drivePath: record.path,
          name: record.name,
          sourcePath: localPath,
          sizeBytes: record.sizeBytes,
          sha256,
          contentType: record.contentType,
        };
        return {
          result: `Uploaded ${localPath} to the user's drive at ${record.path} (${record.sizeBytes} bytes, sha256 ${sha256}). On the other device, call drive_download with drivePath "${record.path}" and sha256 "${sha256}".`,
          details,
        };
      });
    },
  },
  {
    name: "drive_download",
    replay: "safe",
    agentTypes: DRIVE_TRANSFER_AGENT_TYPES,
    demoted: { searchTerms: DRIVE_TRANSFER_SEARCH_TERMS },
    description:
      "Download a file from the user's own Stella Drive to a path on this computer, for example one uploaded with drive_upload on another of their devices. Checks the size against the drive's record and, when sha256 is given, the hash; a mismatch leaves nothing behind. Returns the local path, sizeBytes and sha256.",
    parameters: {
      type: "object",
      properties: {
        drivePath: {
          type: "string",
          description: "The file's drive path, as drive_upload returned it.",
        },
        path: {
          type: "string",
          description:
            "Local destination: a file path, or an existing directory to put it in. Defaults to ~/Downloads/<file name>.",
        },
        sha256: {
          type: "string",
          description: "Expected sha256 (hex) from drive_upload. Strongly recommended.",
        },
        overwrite: {
          type: "boolean",
          description: "Replace an existing local file. Default false.",
        },
      },
      required: ["drivePath"],
    },
    execute: async (args, context) => {
      const input = (args ?? {}) as {
        drivePath?: unknown;
        path?: unknown;
        sha256?: unknown;
        overwrite?: unknown;
      };
      const drivePath =
        typeof input.drivePath === "string"
          ? input.drivePath.trim().replace(/^\/+/, "")
          : "";
      if (!drivePath) {
        return failure("drive_download requires the file's drivePath.");
      }
      const expected =
        typeof input.sha256 === "string" && input.sha256.trim()
          ? input.sha256.trim().toLowerCase()
          : null;
      if (expected && !SHA256_PATTERN.test(expected)) {
        return failure("sha256 must be 64 hex characters.");
      }
      const overwrite = input.overwrite === true;
      return withClient(options, async (client) => {
        const file = await client.call("drive.fileUrl", { path: drivePath });
        if (file.sizeBytes > MAX_TRANSFER_BYTES) {
          return failure(
            `${file.path} is ${file.sizeBytes} bytes, over the ${MAX_TRANSFER_BYTES}-byte limit for one drive transfer.`,
          );
        }
        const requested =
          typeof input.path === "string" && input.path.trim()
            ? resolveLocalPath(input.path, context)
            : path.join(homedir(), "Downloads");
        const requestedStat = await fs.stat(requested).catch(() => null);
        const destination = requestedStat?.isDirectory()
          ? path.join(requested, path.basename(file.name) || "download")
          : requested;
        if (!overwrite && (await exists(destination))) {
          return failure(
            `${destination} already exists. Pass overwrite: true to replace it, or choose another path.`,
          );
        }
        await fs.mkdir(path.dirname(destination), { recursive: true });
        const response = await fetch(file.url, {
          signal: AbortSignal.timeout(10 * 60_000),
        });
        if (!response.ok || !response.body) {
          return failure(
            `Downloading ${file.path} from the drive failed (${response.status}).`,
          );
        }
        const hash = createHash("sha256");
        let sizeBytes = 0;
        const temporary = path.join(
          path.dirname(destination),
          `.${path.basename(destination)}.${randomUUID()}.part`,
        );
        try {
          await pipeline(
            Readable.fromWeb(response.body as unknown as WebReadableStream),
            new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                sizeBytes += chunk.byteLength;
                if (sizeBytes > MAX_TRANSFER_BYTES) {
                  callback(new Error("download exceeded the transfer limit"));
                  return;
                }
                hash.update(chunk);
                callback(null, chunk);
              },
            }),
            createWriteStream(temporary, { flags: "wx" }),
          );
          const sha256 = hash.digest("hex");
          if (sizeBytes !== file.sizeBytes) {
            throw new Error(
              `received ${sizeBytes} bytes but the drive records ${file.sizeBytes}`,
            );
          }
          if (expected && sha256 !== expected) {
            throw new Error(
              `sha256 mismatch: expected ${expected}, received ${sha256}`,
            );
          }
          await fs.rename(temporary, destination);
          return {
            result: `Downloaded ${file.path} from the user's drive to ${destination} (${sizeBytes} bytes, sha256 ${sha256}${expected ? ", matches the expected hash" : ""}).`,
            details: {
              drivePath: file.path,
              path: destination,
              sizeBytes,
              sha256,
              contentType: file.contentType,
              verified: Boolean(expected),
            },
          };
        } catch (error) {
          await fs.rm(temporary, { force: true });
          return failure(
            `Downloading ${file.path} failed: ${
              error instanceof Error ? error.message : String(error)
            }. Nothing was written to ${destination}.`,
          );
        }
      });
    },
  },
];
