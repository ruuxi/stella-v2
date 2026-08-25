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
        ? redactMemoryText(content).slice(0, maxChars)
        : redactMemoryText(content)
      : undefined;
  } catch {
    return undefined;
  }
};

export const readUserProfileDoc = (stellaDataDir: string): string | undefined =>
  readResidentMemoryDoc(
    path.join(stellaDataDir, "memories", "profile.md"),

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

export const resolveLiveChatMessageDelivery = (args: {
  role: string;
  engine: "native" | "external";
}): "steer" | "followUp" => {
  void args;
  return "steer";
};

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
