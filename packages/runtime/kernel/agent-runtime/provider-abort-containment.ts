import type { AgentMessage } from "../agent-core/types.js";

/**
 * Quarantined thread content.
 *
 * The agent loop that ran Stella's own turns here quarantined a tool result
 * whose quoted content made the provider abort every request that replayed
 * it, and persisted a record of it in the thread. Those threads stay healed:
 * request assembly still replaces a quarantined result with the placeholder.
 */

/** Placeholder that replaces quarantined content in the request assembly. */
export const QUARANTINE_PLACEHOLDER =
  "[content quarantined: triggered provider abort]";

type QuarantineRecord = {
  key: string;
  toolName: string;
  timestamp: number;
};

/** Thread custom-message type of a persisted quarantine record. */
export const QUARANTINE_CUSTOM_TYPE = "containment.quarantine";

/**
 * Parse a persisted quarantine record from custom-message content (string
 * or text-block form). Returns null for anything malformed.
 */
export const parseQuarantineRecord = (
  content: unknown,
): QuarantineRecord | null => {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block) =>
              block &&
              typeof block === "object" &&
              (block as { type?: string }).type === "text"
                ? String((block as { text?: unknown }).text ?? "")
                : "",
            )
            .join("")
        : "";
  try {
    const parsed = JSON.parse(text) as {
      key?: unknown;
      toolName?: unknown;
      timestamp?: unknown;
    };
    if (!parsed || typeof parsed.key !== "string" || !parsed.key) return null;
    return {
      key: parsed.key,
      toolName: typeof parsed.toolName === "string" ? parsed.toolName : "",
      timestamp:
        typeof parsed.timestamp === "number" && Number.isFinite(parsed.timestamp)
          ? parsed.timestamp
          : 0,
    };
  } catch {
    return null;
  }
};

export const toolResultQuarantineKey = (
  message: Extract<AgentMessage, { role: "toolResult" }>,
): string => `${message.timestamp}:${message.toolCallId}`;
