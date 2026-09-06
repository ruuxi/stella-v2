/**
 * `html` tool — write a self-contained HTML document under
 * `~/.stella/outputs/html/<slug>.html` and surface it inline in the chat as a
 * canvas artifact. The completed file is opened in the workspace panel's
 * Canvas tab. You should not describe the canvas contents in chat, because
 * the user can view the artifact directly.
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
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
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
};

const asTrimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

export const createHtmlTool = (options: HtmlToolOptions): ToolDefinition => {
  const { stellaDataDir } = options;
  return {
    name: HTML_TOOL_NAME,
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

      return {
        result: `Canvas "${title}" saved to ${filePath} and opened in the panel.`,
        details: {
          filePath,
          slug,
          title,
          createdAt,
          bytes: Buffer.byteLength(html, "utf8"),
        },
      };
    },
  };
};
