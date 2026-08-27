import type { AgentMessage } from "../agent-core/types.js";

/** The only JavaScript orchestration tool name advertised to new turns. */
export const CODE_TOOL_NAME = "code" as const;

/**
 * Historical transcripts may still contain this name. It is data-compatibility
 * only: the tool catalog must never advertise it again.
 */
export const LEGACY_NODE_REPL_TOOL_NAME = "node_repl" as const;

export const normalizeCodeToolName = (name: string): string =>
  name === LEGACY_NODE_REPL_TOOL_NAME ? CODE_TOOL_NAME : name;

/**
 * Conservatively decide whether a source-provided approval policy requires an
 * explicit, top-level approval flow. Unknown policy shapes fail closed.
 */
export const toolRequiresExplicitApproval = (approval: unknown): boolean => {
  if (approval === undefined || approval === null || approval === false) {
    return false;
  }
  if (approval === true) return true;
  if (typeof approval === "string") {
    const normalized = approval.trim().toLowerCase();
    return normalized !== "" && normalized !== "none" && normalized !== "never";
  }
  if (typeof approval === "object" && !Array.isArray(approval)) {
    const required = (approval as { required?: unknown }).required;
    return required !== false;
  }
  return true;
};

/**
 * Rewrite legacy completed/in-flight transcript names at the provider edge.
 * Tool-call ids and result pairing are untouched. Durable storage remains
 * append-only and old clients can still render the original rows.
 */
export const normalizeLegacyCodeHistory = (
  messages: AgentMessage[],
): AgentMessage[] => {
  let changed = false;
  const normalized = messages.map((message) => {
    if (message.role === "toolResult") {
      if (message.toolName !== LEGACY_NODE_REPL_TOOL_NAME) return message;
      changed = true;
      return { ...message, toolName: CODE_TOOL_NAME };
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return message;
    }
    let contentChanged = false;
    const content = message.content.map((block) => {
      if (
        block.type !== "toolCall" ||
        block.name !== LEGACY_NODE_REPL_TOOL_NAME
      ) {
        return block;
      }
      contentChanged = true;
      return { ...block, name: CODE_TOOL_NAME };
    });
    if (!contentChanged) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? normalized : messages;
};
