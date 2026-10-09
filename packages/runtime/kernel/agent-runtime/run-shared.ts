/**
 * Transcript helpers shared by the desktop runtime and the cloud
 * orchestrator DO (workerd). This module must stay importable from workerd —
 * no node builtins, no filesystem, no desktop stores — so that cloud hosts
 * reuse these behaviors instead of forking them. `shared.ts` and
 * `thread-memory.ts` re-export everything here for their existing callers.
 */

import type { AgentMessage } from "../agent-core/types.js";

export const BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE = "bootstrap.startup_doc";

// Retention budget for tool-result images in model history, newest first.
// The old policy kept exactly ONE image-bearing message, which made
// multi-image work impossible: viewing 5 reference images left 4 as
// "re-run the tool" placeholders on the very next LLM call, and every
// re-view evicted the previous image. Budgets are accounted per image
// block (a batched view counts each image), sized so screenshot loops
// stay cheap while a set of downscaled reference images survives across
// turns without busting the managed relay's ~20MiB request cap.
const MAX_IMAGES_IN_HISTORY = 8;
const IMAGE_HISTORY_BASE64_BUDGET = 12 * 1024 * 1024;

export const stripStaleImageBlocks = <T extends { role: string }>(
  messages: T[],
): T[] => {
  let imagesKept = 0;
  let imageBytesKept = 0;
  let rewroteAny = false;
  const out: T[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "toolResult") {
      out.push(message);
      continue;
    }
    const toolResult = message as unknown as {
      content: Array<{ type: string; data?: string; mimeType?: string }>;
    };
    const hasImage = toolResult.content.some((block) => block.type === "image");
    if (!hasImage) {
      out.push(message);
      continue;
    }
    let rewroteThisMessage = false;
    // Within a message, newest-last ordering doesn't matter much; account
    // blocks in reverse so the budget favors the same blocks the loop
    // direction favors across messages.
    const compactContent = [...toolResult.content]
      .reverse()
      .map((block) => {
        if (block.type !== "image") {
          return block;
        }
        const base64Bytes = block.data?.length ?? 0;
        if (
          imagesKept < MAX_IMAGES_IN_HISTORY &&
          imageBytesKept + base64Bytes <= IMAGE_HISTORY_BASE64_BUDGET
        ) {
          imagesKept += 1;
          imageBytesKept += base64Bytes;
          return block;
        }
        rewroteThisMessage = true;
        const sizeKb = Math.round((base64Bytes * 0.75) / 1024);
        return {
          type: "text",
          text: `[Older ${block.mimeType ?? "image/png"} screenshot omitted from history (~${sizeKb}KB). Re-run the tool to see it again.]`,
        };
      })
      .reverse();
    if (!rewroteThisMessage) {
      out.push(message);
      continue;
    }
    rewroteAny = true;
    out.push({
      ...(message as object),
      content: compactContent,
    } as unknown as T);
  }
  return rewroteAny ? out.reverse() : messages;
};

export const extractAssistantText = (
  message: AgentMessage | undefined,
): string => {
  if (!message || message.role !== "assistant") return "";
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks
    .filter(
      (block): block is { type: "text"; text: string } => block.type === "text",
    )
    .map((block) => block.text)
    .join("");
};

/**
 * True when an assistant message carries at least one tool call. Such a
 * message is *interim* — the agent loop runs the tools and then produces a
 * further message — so any visible preamble text it contains is not the
 * final answer. The working indicator uses this to avoid handing off (and
 * disappearing) between a preamble and the tool call it precedes.
 */
export const assistantMessageHasToolCall = (
  message: AgentMessage | undefined,
): boolean => {
  if (!message || message.role !== "assistant") return false;
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks.some((block) => block.type === "toolCall");
};

/**
 * True when an assistant message carries something the conversation can use:
 * a tool call, or text with non-whitespace in it. A message that fails this
 * is not an answer — it is a burnt provider call (an empty completion, or a
 * thinking-only reply that hit the output cap while reasoning).
 *
 * A host that persists messages as a run produces them applies this before
 * writing, so the durable transcript never rebuilds a history with two
 * consecutive assistant messages, one of them empty.
 */
export const assistantMessageHasUsableOutput = (
  message: AgentMessage,
): boolean => {
  if (message.role !== "assistant") return true;
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks.some(
    (block) =>
      block.type === "toolCall" ||
      (block.type === "text" && block.text.trim().length > 0),
  );
};
