/**
 * `Read` for the cloud orchestrator — the device tool's exact model-visible
 * surface (see `defs/read-def.ts`) over the two trees a cloud turn can see:
 *
 *  - `~/.stella/skills/<slug>/...` — the owner's mirrored skills, pinned for
 *    the turn and integrity-checked by the cloud home store;
 *  - `/workspace/world/...` — the owner's world (drive, projects, apps),
 *    read through the world Durable Object exactly as a cloud agent does.
 *
 * An image under the world root is read as pixels, which is what the shared
 * description has always advertised: "inspect a local PNG, JPG, JPEG, GIF, or
 * WEBP image. Image files are attached to the conversation as vision input."
 * Both placements show the model that byte-identical sentence, so returning
 * `Binary files are not supported` here made the tool's own contract false in
 * the cloud. The orchestrator tool protocol already carries image blocks
 * (`toolResultFromOrchestrator` turns them into authorized tool images), so
 * this reads the bytes out of the world instead of handing them to the world's
 * text-only Read.
 *
 * Skills stay text-only: that store hands back text and holds no binaries.
 */

import type { TSchema } from "@sinclair/typebox";
import {
  READ_TOOL_DESCRIPTION,
  READ_TOOL_NAME,
  READ_TOOL_PARAMETERS,
  READ_TOOL_REPLAY,
} from "@stella/runtime/kernel/tools/defs/read-def.js";
import { sanitizeToolVisibleText } from "@stella/runtime/kernel/tools/safety.js";
import {
  detectImageMimeTypeFromBytes,
  imageMimeTypeFromPath,
} from "@stella/runtime/kernel/shared/image-mime.js";
import type { CloudCodeSourceAgentTool } from "./cloud-code-tool.js";
import type {
  CloudHomeStore,
  CloudSkillCatalogSnapshot,
} from "./cloud-home-store.js";
import {
  readCloudSkillFile,
  resolveCloudSkillPath,
} from "./cloud-skills.js";
import { WORLD_ROOT } from "./workspace.js";

const MAX_SKILL_TEXT_CHARS = 120_000;
const DEFAULT_READ_LIMIT = 2000;
const MAX_READ_LINES = 5000;

/**
 * Decoded bytes of one image a cloud Read may inline. The refusal names this
 * number, because the readable size is a property of the session rather than
 * of the placement — a resident world hydrates at most 8MB per file, a
 * container world materializes under its own export budget, and a device has
 * the real filesystem. No prompt can state one limit truthfully, so the error
 * carries it instead.
 */
const MAX_READ_IMAGE_BYTES = 5 * 1024 * 1024;

const base64FromBytes = (bytes: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
};

export type CloudReadToolOptions = Readonly<{
  skills?: { home: CloudHomeStore; snapshot: CloudSkillCatalogSnapshot };
  world?: {
    tool(call: {
      name: "Read";
      arguments: Record<string, unknown>;
    }): Promise<{ ok: boolean; output: string }>;
    /**
     * Bytes for an image path. Absent on a world binding that predates this,
     * in which case an image falls through to the text Read and reports the
     * world's own refusal rather than crashing.
     */
    stat?(path: string): Promise<{ kind: string; size: number } | null>;
    readFile?(
      path: string,
      options?: { offset?: number; length?: number },
    ): Promise<Uint8Array | null>;
  };
}>;

const failure = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  details: null,
  isError: true,
});

/** The device Read's `offset`/`limit` window over a text body. */
const windowLines = (
  text: string,
  offsetValue: unknown,
  limitValue: unknown,
): { body: string; start: number; end: number; total: number; more: boolean } => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const offset = Number(offsetValue ?? 1);
  const limit = Number(limitValue ?? DEFAULT_READ_LIMIT);
  const start = Number.isFinite(offset) ? Math.max(1, Math.trunc(offset)) : 1;
  const count = Math.min(
    MAX_READ_LINES,
    Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : DEFAULT_READ_LIMIT,
  );
  const selected = lines.slice(start - 1, start - 1 + count);
  const end = selected.length === 0 ? start - 1 : start + selected.length - 1;
  return {
    body: selected
      .map((line, index) => `${String(start + index).padStart(6, " ")}#${line}`)
      .join("\n"),
    start,
    end,
    total: lines.length,
    more: end < lines.length,
  };
};

export const createCloudReadTool = (
  options: CloudReadToolOptions,
): CloudCodeSourceAgentTool => ({
  name: READ_TOOL_NAME,
  replay: READ_TOOL_REPLAY,
  label: "Read",
  workingText: "Reading",
  description: READ_TOOL_DESCRIPTION,
  parameters: READ_TOOL_PARAMETERS as unknown as TSchema,
  execute: async (_toolCallId, params) => {
    const args = (params ?? {}) as Record<string, unknown>;
    const filePath =
      typeof args.file_path === "string" ? args.file_path.trim() : "";
    if (!filePath) return failure("file_path is required.");

    if (options.skills) {
      const { ref, skillsPath } = resolveCloudSkillPath(
        options.skills.snapshot,
        filePath,
      );
      if (skillsPath) {
        if (!ref) {
          return failure(
            `File not found: ${filePath}. The <skills> block lists every skill available in this session.`,
          );
        }
        let text: string;
        try {
          text = await readCloudSkillFile(
            options.skills.home,
            options.skills.snapshot,
            ref,
          );
        } catch (error) {
          return failure(
            error instanceof Error && error.message.trim()
              ? `File not found: ${filePath} (${error.message})`
              : `File not found: ${filePath}`,
          );
        }
        if (text.length > MAX_SKILL_TEXT_CHARS) {
          return failure(
            "That skill file is too large for model context. Read a narrower text asset.",
          );
        }
        const window = windowLines(
          sanitizeToolVisibleText(text, { codeFile: true }),
          args.offset,
          args.limit,
        );
        const continuation = window.more
          ? ` More lines remain; continue with offset=${window.end + 1}.`
          : "";
        return {
          content: [
            {
              type: "text",
              text: `File: ${filePath}\nLines ${window.start}-${window.end} of ${window.total}.${continuation}\n\n${window.body}`,
            },
          ],
          details: {
            path: filePath,
            skillId: ref.entry.skillId,
            versionId: ref.entry.versionId,
            skillPath: ref.path,
          },
        };
      }
    }

    if (!options.world) {
      return failure(
        `File not found: ${filePath}. Only ${WORLD_ROOT}/... (the user's cloud drive, projects, and apps) and ~/.stella/skills/... exist in this session.`,
      );
    }
    if (!filePath.startsWith("/")) {
      return failure(
        `File tool paths must be absolute. Received relative path '${filePath}'. The user's cloud files live under ${WORLD_ROOT}/ (drive/, projects/<name>/, apps/<name>/).`,
      );
    }

    // An image is pixels, not lines, so `offset`/`limit` have no meaning and
    // the world's line-windowing Read would only refuse the bytes. Extension
    // first because it costs nothing; the magic numbers then decide, so a
    // mislabeled `.png` is reported as what it actually is rather than sent
    // to a provider that will reject it.
    const world = options.world;
    if (imageMimeTypeFromPath(filePath) && world.stat && world.readFile) {
      const entry = await world.stat(filePath).catch(() => null);
      if (entry && entry.kind === "file") {
        if (entry.size > MAX_READ_IMAGE_BYTES) {
          return failure(
            `That image is ${entry.size} bytes, over this session's ${MAX_READ_IMAGE_BYTES}-byte limit for reading an image into the conversation: ${filePath}`,
          );
        }
        const bytes = await world.readFile(filePath).catch(() => null);
        if (bytes) {
          const mimeType = detectImageMimeTypeFromBytes(bytes);
          if (!mimeType) {
            return failure(
              `That file is named like an image but its bytes are not a complete PNG, JPEG, GIF, or WEBP: ${filePath}`,
            );
          }
          return {
            content: [
              {
                type: "text",
                text: `Image file: ${filePath} (${mimeType}, ${bytes.length} bytes)`,
              },
              { type: "image", data: base64FromBytes(bytes), mimeType },
            ],
            details: { path: filePath, mimeType, sizeBytes: bytes.length },
          };
        }
      }
    }

    const result = await options.world.tool({
      name: "Read",
      arguments: {
        file_path: filePath,
        ...(args.offset !== undefined ? { offset: args.offset } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      },
    });
    return {
      content: [{ type: "text", text: result.output || "(no output)" }],
      details: { path: filePath },
      ...(result.ok ? {} : { isError: true }),
    };
  },
});
