import fs from "fs";
import path from "path";
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
import { redactMemoryText } from "../memory/redaction.js";
import {
  capResidentMemoryDoc,
  MEMORY_MAP_MAX_CHARS,
} from "../memory/dream-storage.js";
import { USER_PROFILE_INJECT_MAX_CHARS } from "../memory/user-profile-store.js";
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

export const readCoreMemory = (stellaDataDir: string): string | undefined => {
  const candidatePaths = [
    path.join(stellaDataDir, "core-memory.md"),
    path.join(stellaDataDir, "CORE_MEMORY.MD"),
  ];
  for (const filePath of candidatePaths) {
    try {
      const content = fs.readFileSync(filePath, "utf-8").trim();
      if (content) {
        return redactMemoryText(content);
      }
    } catch {
      continue;
    }
  }
  return undefined;
};

const readResidentMemoryDoc = (
  filePath: string,
  maxChars?: number,
): string | undefined => {
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    return content
      ? maxChars
      ? capResidentMemoryDoc(redactMemoryText(content), maxChars)
        : redactMemoryText(content)
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Dream's memory map, read synchronously for resident injection.
 */
export const readMemoryMapDoc = (stellaDataDir: string): string | undefined =>
  readResidentMemoryDoc(
    path.join(stellaDataDir, "memories", "memory_map.md"),
    MEMORY_MAP_MAX_CHARS,
  );

/**
 * The durable user-profile facts written by the `Remember` tool, read
 * synchronously for resident injection.
 */
export const readUserProfileDoc = (stellaDataDir: string): string | undefined =>
  readResidentMemoryDoc(
    path.join(stellaDataDir, "memories", "profile.md"),
    // Coupled to the write cap: bound the always-resident block so a
    // hand-edited or over-cap profile.md can never blow the context budget.
    USER_PROFILE_INJECT_MAX_CHARS,
  );

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
  if (event.type === "agent-completed" && event.fileChanges?.length) {
    lines.push("explicit file changes:");
    for (const change of event.fileChanges.slice(0, 20)) {
      const destination =
        change.kind.type === "update" && change.kind.move_path
          ? ` -> ${change.kind.move_path}`
          : "";
      lines.push(`- ${change.kind.type}: ${change.path}${destination}`);
    }
    if (event.fileChanges.length > 20) {
      lines.push(`- ... ${event.fileChanges.length - 20} more`);
    }
  }
  if (event.type === "agent-completed" && event.producedFiles?.length) {
    lines.push("produced files:");
    for (const file of event.producedFiles.slice(0, 20)) {
      const destination =
        file.kind.type === "update" && file.kind.move_path
          ? ` -> ${file.kind.move_path}`
          : "";
      lines.push(`- ${file.kind.type}: ${file.path}${destination}`);
    }
    if (event.producedFiles.length > 20) {
      lines.push(`- ... ${event.producedFiles.length - 20} more`);
    }
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
        "presentation: for a report or dense result, present it as a canvas with the `html` tool (write the complete HTML document yourself) and keep the chat reply short; for a quick answer, reply directly in chat. Be concise and human-friendly — the user delegated this and lacks the context, so say what happened in plain terms rather than implementation detail.",
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
