import {
  AGENT_PAUSE_CANCEL_REASON,
  AGENT_SHUTDOWN_CANCEL_REASON,
  type AgentLifecycleEvent,
} from "../agents/local-agent-manager.js";
import { LOCAL_CONTEXT_EVENT_TYPES } from "../storage/shared.js";
import {
  readConfiguredConvexUrl as sanitizeConvexDeploymentUrl,
  readConfiguredStellaBaseUrl as sanitizeStellaBase,
} from "@stella/contracts/convex-urls";
import { isOrchestratorAgentType } from "@stella/contracts/agent-runtime";
import { formatAgentTerminalStateSystemReminder } from "@stella/contracts/system-reminders";
import { readRuntimePrompt } from "../prompts/home-prompts.js";
import { boundParentAgentReport } from "./agent-report-bounds.js";

export const DEFAULT_MAX_AGENT_DEPTH = 8;
export const LOCAL_HISTORY_RESERVE_TOKENS = 16_384;
export const MIN_LOCAL_HISTORY_TOKENS = 8_000;
export {
  LOCAL_CONTEXT_EVENT_TYPES,
  sanitizeConvexDeploymentUrl,
  sanitizeStellaBase,
};

export const defaultPromptForAgentType = (
  agentType: string,
  _stellaDataDir?: string,
): string =>
  readRuntimePrompt(
    isOrchestratorAgentType(agentType)
      ? "fallback-orchestrator"
      : "fallback-subagent",
  ) ?? "";

// Kept as runner/shared re-exports for existing context builders. The
// dependency-light module is also used by thread-runtime at compaction
// boundaries without creating a runner/session import cycle.
export { readCoreMemory, readUserProfileDoc } from "../memory/resident-docs.js";

const MAX_AGENT_EVENT_FIELD_CHARS = 30_000;

const truncateAgentEventField = (value: string): string =>
  value.length <= MAX_AGENT_EVENT_FIELD_CHARS
    ? value
    : `${value.slice(0, MAX_AGENT_EVENT_FIELD_CHARS)}\n[truncated ${value.length - MAX_AGENT_EVENT_FIELD_CHARS} chars]`;

export const buildAgentEventPrompt = (
  event: AgentLifecycleEvent,
  options?: { recipient?: "orchestrator" | "parent_agent" },
): string | null => {
  if (
    event.type !== "agent-completed" &&
    event.type !== "agent-failed" &&
    event.type !== "agent-canceled"
  ) {
    return null;
  }

  const lines: string[] = [];
  const toParentAgent = options?.recipient === "parent_agent";
  const isPausedChild =
    event.type === "agent-canceled" &&
    event.error === AGENT_PAUSE_CANCEL_REASON &&
    toParentAgent;
  if (event.type === "agent-completed") {
    lines.push("[Agent completed]");
    if (event.description) {
      lines.push(`description: ${event.description}`);
    }
  } else if (event.type === "agent-canceled") {
    lines.push(isPausedChild ? "[Subagent paused]" : "[Task canceled]");
  } else {
    lines.push("[Task failed]");
  }

  if (event.agentId) lines.push(`thread_id: ${event.agentId}`);
  if (event.agentType) lines.push(`agent_type: ${event.agentType}`);
  if (event.type !== "agent-completed" && event.description) {
    lines.push(`description: ${event.description}`);
  }
  if (
    event.type === "agent-canceled" &&
    (event.error === AGENT_SHUTDOWN_CANCEL_REASON ||
      (event.error === AGENT_PAUSE_CANCEL_REASON && !toParentAgent))
  ) {
    return null;
  }
  if (event.type === "agent-completed" && event.result) {
    lines.push(
      `result: ${boundParentAgentReport(event.result, event.agentId)}`,
    );
  }
  if (
    (event.type === "agent-failed" || event.type === "agent-canceled") &&
    event.error
  ) {
    lines.push(`error: ${truncateAgentEventField(event.error)}`);
  }
  if (event.type === "agent-completed") {
    lines.push(
      "agent_state: paused; use send_input on the same thread if follow-up work is needed.",
    );
    if (toParentAgent) {
      lines.push(
        "routing: your subagent's report has returned. It reaches only you, not the user; continue your own task with it.",
      );
    } else {
      lines.push(
        "presentation: for a report or dense result, present it as a canvas with the `html` tool (write the complete HTML document yourself) and keep the chat reply short; for a quick answer, reply directly in chat. Be concise and human-friendly — the user delegated this and lacks the context, so say what happened in plain terms rather than implementation detail. End the reply with a `refs` block citing this thread_id (see Replies in your instructions) so the update attaches to the work it reports on.",
      );
    }
  }

  if (toParentAgent) {
    return [
      "<system-reminder>",
      "A subagent you started reached a terminal state. This report is for you only; continue your own task.",
      "</system-reminder>",
      "",
      ...lines,
    ].join("\n");
  }
  return formatAgentTerminalStateSystemReminder(lines);
};

/**
 * Delivery mode for a chat message injected into a live orchestrator run.
 *
 * Every live message is steering, regardless of sender or engine. The user
 * always talks to the Orchestrator, and runtime messages (including descendant
 * lifecycle reports) are equally time-sensitive context for its active turn.
 * Codex appends it to the active turn with `turn/steer`; Claude Code uses its
 * native interrupt control and writes the message to the same streaming
 * session. Descendant agents continue independently.
 */
export const resolveLiveChatMessageDelivery = (args: {
  role: string;
  engine: "native" | "external";
}): "steer" | "followUp" => {
  void args;
  return "steer";
};

/**
 * Mirror an injected live-run user message for abnormal-termination recovery.
 * If the run dies before the message is delivered, `flushPendingFollowUpReplies`
 * answers it in a fresh turn. Entries are keyed by `userMessageId` so
 * `prunePendingFollowUpReplies` can drop them once the message is actually
 * delivered to the model.
 */
export const recordPendingFollowUpReplyEntry = (
  replies: Map<string, import("./types.js").PendingFollowUpReply[]>,
  conversationId: string,
  entry: import("./types.js").PendingFollowUpReply,
): void => {
  const trimmed = entry.text.trim();
  if (!trimmed) {
    return;
  }
  const next = { ...entry, text: trimmed };
  const existing = replies.get(conversationId);
  if (existing) {
    existing.push(next);
  } else {
    replies.set(conversationId, [next]);
  }
};

/**
 * Drop recovery mirrors for a queued user message once it has been delivered
 * into the model context (the queued-user-message `message_start`). Without
 * this, a steered message answered mid-run would still be flushed — and
 * re-answered — if the run later ended abnormally. The remaining window (run
 * dies after delivery but before the answer completes) is a single turn, far
 * smaller than flushing every already-answered message.
 */
export const prunePendingFollowUpReplies = (
  replies: Map<string, import("./types.js").PendingFollowUpReply[]>,
  conversationId: string,
  userMessageId: string,
): void => {
  const existing = replies.get(conversationId);
  if (!existing) {
    return;
  }
  const remaining = existing.filter(
    (entry) => entry.userMessageId !== userMessageId,
  );
  if (remaining.length === 0) {
    replies.delete(conversationId);
  } else if (remaining.length !== existing.length) {
    replies.set(conversationId, remaining);
  }
};
