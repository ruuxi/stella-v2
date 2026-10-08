/**
 * `drive` for the cloud orchestrator — the device tool's exact model-visible
 * surface (see `defs/drive-def.ts`) over the same owner drive.
 *
 * `fetch` returns a path, not bytes, which is what lets one description be
 * true in both placements. Here the path is the file's place under the world
 * root, and `Read` on it reads the drive itself (`world-drive-files.ts`), so
 * the agent's next step is `Read` on that path exactly as it would be on a
 * device. Nothing is copied: the drive is never stored in the world.
 *
 * Owner scoping is the owner object's, not this file's. The only thing sent is
 * a drive-relative path; the owner comes from the turn's generation-fenced
 * gate, and `normalizeDrivePath` runs there. So this tool holds no authority
 * that could be widened by what a caller claims.
 */

import type { TSchema } from "@sinclair/typebox";
import {
  DRIVE_TOOL_DESCRIPTION,
  DRIVE_TOOL_NAME,
  DRIVE_TOOL_PARAMETERS,
  DRIVE_TOOL_REPLAY,
} from "@stella/runtime/kernel/tools/defs/drive-def.js";
import type { DriveFile } from "@stella/contracts/backend/drive";
import type { CloudCodeSourceAgentTool } from "./cloud-code-tool.js";
import { WORLD_ROOT } from "./workspace.js";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

const failure = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  details: null,
  isError: true,
});

const describe = (file: DriveFile): string =>
  `${file.path} (${file.contentType}, ${file.sizeBytes} bytes, ${file.source})`;

export type CloudDriveToolOptions = Readonly<{
  ownerInternal: (name: string, args: unknown) => Promise<unknown>;
}>;

export const createCloudDriveTool = (
  options: CloudDriveToolOptions,
): CloudCodeSourceAgentTool => ({
  name: DRIVE_TOOL_NAME,
  replay: DRIVE_TOOL_REPLAY,
  label: "Drive",
  workingText: "Reading the drive",
  description: DRIVE_TOOL_DESCRIPTION,
  parameters: DRIVE_TOOL_PARAMETERS as unknown as TSchema,
  execute: async (_toolCallId, params) => {
    const args = (params ?? {}) as Record<string, unknown>;
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (action !== "list" && action !== "fetch") {
      return failure("drive requires action to be either 'list' or 'fetch'.");
    }
    try {
      if (action === "list") {
        const prefix =
          typeof args.prefix === "string" && args.prefix.trim()
            ? args.prefix.trim()
            : undefined;
        const requested = Number(args.limit);
        const limit = Number.isFinite(requested)
          ? Math.min(Math.max(Math.trunc(requested), 1), MAX_LIST_LIMIT)
          : DEFAULT_LIST_LIMIT;
        const { files } = (await options.ownerInternal("drive.list", {
          ...(prefix ? { prefix } : {}),
          limit,
        })) as { files: DriveFile[] };
        if (files.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: prefix
                  ? `No files in the user's drive under ${prefix}.`
                  : "The user's drive is empty.",
              },
            ],
            details: { files: [] },
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `${files.length} file(s) in the user's drive${prefix ? ` under ${prefix}` : ""}:`,
                ...files.map((file) => `- ${describe(file)}`),
                "Use drive fetch with one of these paths to get a path to Read.",
              ].join("\n"),
            },
          ],
          details: { files },
        };
      }

      const drivePath = typeof args.path === "string" ? args.path.trim() : "";
      if (!drivePath) {
        return failure("drive fetch requires the file's drive path.");
      }
      // `fileUrl` is the existence and authorization check. Its signed URL is
      // deliberately unused: in this session `Read` on the world path reaches
      // the bytes, and a URL in a tool result would only be a credential in
      // the transcript.
      const file = (await options.ownerInternal("drive.fileUrl", {
        path: drivePath,
      })) as { path: string; name: string; sizeBytes: number; contentType: string };
      const worldPath = `${WORLD_ROOT}/drive/${file.path}`;
      return {
        content: [
          {
            type: "text" as const,
            text: `${file.path} is available at ${worldPath} (${file.contentType}, ${file.sizeBytes} bytes). Use Read with that absolute path.`,
          },
        ],
        details: {
          drivePath: file.path,
          path: worldPath,
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
        },
      };
    } catch (error) {
      return failure(
        `The user's drive refused that request: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  },
});
