/**
 * The durable continuation seam of a cloud browser handoff, shared by the
 * container executor and the resident Durable Object loop. Dependency-light
 * on purpose: the Worker bundle imports it.
 */
import {
  isCloudBrowserResumeReceipt,
  type CloudBrowserResumeReceipt,
} from "@stella/contracts/cloud-browser";
import type {
  AgentMessage,
  AgentToolCall,
} from "@stella/runtime/kernel/agent-core/types.js";

const CLOUD_BROWSER_RESUME_KEYS = [
  "schemaVersion",
  "interactionId",
  "interactionRevision",
  "profileId",
  "profileEpoch",
  "toolCallId",
  "requestDigest",
  "result",
  "safeMessage",
] as const;

/**
 * Rebuild the one provider-visible result at the durable continuation seam.
 * Extra input keys are rejected so a malformed dispatch cannot piggyback
 * browser state into the transcript.
 */
export const createCloudBrowserResumeToolResult = (
  history: readonly AgentMessage[],
  receipt: CloudBrowserResumeReceipt,
  timestamp = Date.now(),
): AgentMessage => {
  if (
    !isCloudBrowserResumeReceipt(receipt) ||
    Object.keys(receipt).sort().join(",") !==
      [...CLOUD_BROWSER_RESUME_KEYS].sort().join(",")
  ) {
    throw new Error("Cloud browser resume receipt is invalid.");
  }
  if (
    history.some(
      (message) =>
        message.role === "toolResult" &&
        message.toolCallId === receipt.toolCallId,
    )
  ) {
    throw new Error("Cloud browser resume was already appended.");
  }

  let toolName: string | undefined;
  let assistantIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role !== "assistant") continue;
    const matches = message.content.filter(
      (part): part is AgentToolCall =>
        part.type === "toolCall" && part.id === receipt.toolCallId,
    );
    if (matches.length === 1) {
      toolName = matches[0]!.name;
      assistantIndex = index;
      break;
    }
  }
  if (toolName !== "code" || assistantIndex < 0) {
    throw new Error(
      "Cloud browser resume does not match the canonical assistant tool call.",
    );
  }
  if (
    history
      .slice(assistantIndex + 1)
      .some((message) => message.role !== "toolResult")
  ) {
    throw new Error("Cloud browser resume history is not continuable.");
  }
  return {
    role: "toolResult",
    toolCallId: receipt.toolCallId,
    toolName,
    content: [{ type: "text", text: receipt.safeMessage }],
    details: {
      browserResume: {
        schemaVersion: 1,
        interactionId: receipt.interactionId,
        interactionRevision: receipt.interactionRevision,
        profileId: receipt.profileId,
        profileEpoch: receipt.profileEpoch,
        requestDigest: receipt.requestDigest,
        result: receipt.result,
      },
    },
    isError: receipt.result !== "approved",
    timestamp,
  };
};
