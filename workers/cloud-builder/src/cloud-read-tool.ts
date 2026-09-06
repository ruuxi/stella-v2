/**
 * `Read` for the cloud orchestrator — the device tool's exact model-visible
 * surface (see `defs/read-def.ts`) over the two trees a cloud turn can see:
 *
 *  - `~/.stella/skills/<slug>/...` — the owner's mirrored skills, pinned for
 *    the turn and integrity-checked by the cloud home store;
 *  - `/workspace/world/...` — the owner's world (drive, projects, apps),
 *    read through the world Durable Object exactly as a cloud agent does.
 *
 * Images are the one gap: the world store rejects binaries and the skill
 * store hands back text only, so a photo reaches the model through the
 * attachment path instead.
 */

import type { TSchema } from "@sinclair/typebox";
import {
  READ_TOOL_DESCRIPTION,
  READ_TOOL_NAME,
  READ_TOOL_PARAMETERS,
} from "@stella/runtime/kernel/tools/defs/read-def.js";
import { sanitizeToolVisibleText } from "@stella/runtime/kernel/tools/safety.js";
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

export type CloudReadToolOptions = Readonly<{
  skills?: { home: CloudHomeStore; snapshot: CloudSkillCatalogSnapshot };
  world?: {
    tool(call: {
      name: "Read";
      arguments: Record<string, unknown>;
    }): Promise<{ ok: boolean; output: string }>;
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
