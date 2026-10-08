/**
 * Surfaces a canvas the moment the orchestrator's `html` tool finishes writing
 * it: the panel opens, the Files section points at the new document, and the
 * canvas viewer takes focus — which is what the tool's own result sentence
 * promises the user.
 *
 * This runs off the live tool-end stream event rather than the chat row, so it
 * fires once per write (including a rewrite of an existing slug, which the tab
 * store refreshes in place) and never re-fires when old turns are re-projected
 * on launch.
 */

import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import { canvasHtmlPayloadFromToolDetails } from "./canvas-tool-result";
import { openDisplayPayloadTab } from "./open-payload";

export const HTML_CANVAS_TOOL_NAME = "html";

type CanvasToolEndEvent = {
  toolName?: string;
  toolCallId?: string;
  agentType?: string;
  isError?: boolean;
  details?: unknown;
};

/**
 * Tool-call ids already surfaced. A reconnect can replay the tail of a stream,
 * and re-opening would yank the panel back to a canvas the user has since
 * navigated away from.
 */
const openedToolCallIds = new Set<string>();

export const openCanvasFromToolEnd = (event: CanvasToolEndEvent): boolean => {
  if (event.toolName !== HTML_CANVAS_TOOL_NAME) return false;
  if (event.isError === true) return false;
  if (event.agentType && event.agentType !== AGENT_IDS.ORCHESTRATOR) {
    return false;
  }
  const payload = canvasHtmlPayloadFromToolDetails(event.details, Date.now());
  if (!payload) return false;
  const dedupeKey = event.toolCallId ?? `${payload.filePath}:${payload.createdAt}`;
  if (openedToolCallIds.has(dedupeKey)) return false;
  openedToolCallIds.add(dedupeKey);
  openDisplayPayloadTab(payload, { activate: true });
  return true;
};
