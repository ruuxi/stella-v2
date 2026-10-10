/**
 * `html` tool — write a self-contained HTML document under
 * `~/.stella/outputs/html/<slug>.html` and surface it inline in the chat as a
 * canvas artifact. The completed file is opened in the workspace panel's
 * Canvas tab. You should not describe the canvas contents in chat, because
 * the user can view the artifact directly.
 *
 * The file is always written: it is what the canvas renders from. The same
 * document is then saved to the canvas's link (`shares.save`), private until
 * the user makes it public, and the tool returns that URL. Signed out, with
 * no share domain configured, or when the save fails or is slow, the tool
 * returns the local file as it always did.
 *
 * Orchestrator-only. The orchestrator authors the full HTML document itself
 * and passes it in; this tool just writes and renders it. The general agent
 * builds real apps via Vite/HMR; this tool exists so the orchestrator can
 * answer with a richer-than-markdown artifact (planning, comparisons,
 * diagrams, dashboards, mockups, structured reports) without spawning an
 * agent.
 */

import path from "node:path";
import fs from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import { BackendClient } from "@stella/contracts/backend/client";
import {
  SHARE_MAX_HTML_BYTES,
  type SavedCanvasShare,
} from "@stella/contracts/backend/shares";
import { runToolEffect } from "../effect-runtime.js";
import type { ToolDefinition } from "../types.js";
import {
  HTML_TOOL_DESCRIPTION,
  HTML_TOOL_NAME,
  HTML_TOOL_PARAMETERS,
  HTML_TOOL_PROMPT_SNIPPET,
  htmlCanvasSlug,
} from "./html-def.js";

export type HtmlToolOptions = {
  stellaDataDir: string;
  getCloudBackendAuth?: () => { baseUrl: string; authToken: string } | null;
};

/** The canvas is on screen already; the link is not worth a longer wait. */
const SAVE_LINK_TIMEOUT_MS = 10_000;

const asTrimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/** The canvas's private link, or null when it cannot be made right now. */
const saveCanvasLink = async (
  options: HtmlToolOptions,
  args: { canvas: string; html: string; title: string },
): Promise<SavedCanvasShare | null> => {
  const auth = options.getCloudBackendAuth?.();
  if (!auth) return null;
  if (Buffer.byteLength(args.html, "utf8") > SHARE_MAX_HTML_BYTES) return null;
  const client = new BackendClient({
    baseUrl: auth.baseUrl,
    getToken: async () => auth.authToken,
  });
  // The timeout is a sleeping fiber interrupted as soon as the save settles
  // (no dangling timer); timing out or failing both fall back to no link.
  return runToolEffect(
    Effect.tryPromise(() => client.call("shares.save", args)).pipe(
      Effect.timeoutOption(SAVE_LINK_TIMEOUT_MS),
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    ),
  );
};

export const createHtmlTool = (options: HtmlToolOptions): ToolDefinition => {
  const { stellaDataDir } = options;
  return {
    name: HTML_TOOL_NAME,
    // The canvas file and its open event may already exist; the desktop has
    // no per-call receipt to prove which.
    replay: "unsafe",
    agentTypes: [AGENT_IDS.ORCHESTRATOR],
    description: HTML_TOOL_DESCRIPTION,
    promptSnippet: HTML_TOOL_PROMPT_SNIPPET,
    parameters: HTML_TOOL_PARAMETERS,
    execute: async (args) => {
      const rawSlug = asTrimmedString(args.slug);
      const title = asTrimmedString(args.title);
      const html = typeof args.html === "string" ? args.html : "";

      if (!title) return { error: "title is required." };
      if (html.length === 0) return { error: "html is required." };

      const slug = htmlCanvasSlug(rawSlug, title);
      const dir = path.join(stellaDataDir, "outputs", "html");
      const filePath = path.join(dir, `${slug}.html`);

      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, html, "utf8");

      const createdAt = Date.now();
      const link = await saveCanvasLink(options, { canvas: slug, html, title });

      return {
        result: link
          ? `Canvas "${title}" opened in the panel. Its link is ${link.url} (${
              link.visibility === "public"
                ? "public: anyone with it can view"
                : "private: only the user can open it until they make it public from the canvas's Share menu"
            }).`
          : `Canvas "${title}" saved to ${filePath} and opened in the panel.`,
        details: {
          filePath,
          slug,
          title,
          createdAt,
          bytes: Buffer.byteLength(html, "utf8"),
          ...(link
            ? { shareUrl: link.url, shareVisibility: link.visibility }
            : {}),
        },
      };
    },
  };
};
