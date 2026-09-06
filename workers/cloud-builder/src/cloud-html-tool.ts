/**
 * `html` for the cloud orchestrator — the device tool's exact model-visible
 * surface (see `defs/html-def.ts`). The device writes the canvas to
 * `~/.stella/outputs/html/<slug>.html`; the cloud writes the same document
 * into the owner's drive at `outputs/html/<slug>.html` and publishes a
 * `files` card, which both clients open as a canvas.
 */

import type { TSchema } from "@sinclair/typebox";
import {
  HTML_TOOL_DESCRIPTION,
  HTML_TOOL_NAME,
  HTML_TOOL_PARAMETERS,
  htmlCanvasSlug,
} from "@stella/runtime/kernel/tools/defs/html-def.js";
import type { CloudCodeSourceAgentTool } from "./cloud-code-tool.js";

/** Drive folder every cloud canvas lands in; mirrors the device layout. */
export const CLOUD_HTML_DRIVE_DIR = "outputs/html";
export const CLOUD_HTML_CONTENT_TYPE = "text/html; charset=utf-8";
/** Below the drive's inline upload cap with room for the JSON envelope. */
const MAX_HTML_BYTES = 6 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export type CloudHtmlToolContext = Readonly<{
  turnId: string;
  convexFetch: (
    path: string,
    init: {
      method: "POST";
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    },
  ) => Promise<Response>;
  publishFiles: (
    writerKey: string,
    files: Array<{
      path: string;
      name: string;
      sizeBytes: number;
      contentType: string;
    }>,
  ) => void;
}>;

const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
};

const failure = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  details: null,
  isError: true,
});

export const cloudHtmlDrivePath = (slug: string): string =>
  `${CLOUD_HTML_DRIVE_DIR}/${slug}.html`;

export const createCloudHtmlTool = (
  context: CloudHtmlToolContext,
): CloudCodeSourceAgentTool => ({
  name: HTML_TOOL_NAME,
  label: "Canvas",
  workingText: "Writing canvas",
  description: HTML_TOOL_DESCRIPTION,
  parameters: HTML_TOOL_PARAMETERS as unknown as TSchema,
  execute: async (toolCallId, params, signal) => {
    const args = (params ?? {}) as Record<string, unknown>;
    const rawSlug = typeof args.slug === "string" ? args.slug.trim() : "";
    const title = typeof args.title === "string" ? args.title.trim() : "";
    const html = typeof args.html === "string" ? args.html : "";
    if (!title) return failure("title is required.");
    if (html.length === 0) return failure("html is required.");

    const slug = htmlCanvasSlug(rawSlug, title);
    const bytes = new TextEncoder().encode(html);
    if (bytes.byteLength > MAX_HTML_BYTES) {
      return failure(
        `The canvas is ${bytes.byteLength} bytes; keep it under ${MAX_HTML_BYTES}.`,
      );
    }
    const path = cloudHtmlDrivePath(slug);
    const name = `${slug}.html`;
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await context.convexFetch("/api/cloud/drive/files", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          turnId: context.turnId,
          source: "html",
          batchKey: toolCallId,
          files: [
            {
              path,
              name,
              sizeBytes: bytes.byteLength,
              contentType: CLOUD_HTML_CONTENT_TYPE,
              contentBase64: encodeBase64(bytes),
            },
          ],
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      return failure(
        `Canvas could not be saved: ${error instanceof Error ? error.message : "the drive did not respond."}`,
      );
    }
    const payload = (await response.json().catch(() => null)) as {
      error?: unknown;
      files?: Array<{ path?: unknown; stored?: unknown }>;
    } | null;
    if (!response.ok) {
      return failure(
        `Canvas could not be saved: ${
          typeof payload?.error === "string"
            ? payload.error
            : `drive write failed (${response.status}).`
        }`,
      );
    }
    const stored = (payload?.files ?? []).some(
      (file) => file.path === path && file.stored !== false,
    );
    if (!stored) {
      return failure("Canvas could not be saved: the drive did not store it.");
    }
    const createdAt = Date.now();
    context.publishFiles(`html:${toolCallId}`, [
      { path, name, sizeBytes: bytes.byteLength, contentType: CLOUD_HTML_CONTENT_TYPE },
    ]);
    return {
      content: [
        {
          type: "text",
          text: `Canvas "${title}" saved to your drive at ${path} and opened in the panel.`,
        },
      ],
      details: {
        filePath: path,
        slug,
        title,
        createdAt,
        bytes: bytes.byteLength,
        driveBacked: true,
      },
    };
  },
});
