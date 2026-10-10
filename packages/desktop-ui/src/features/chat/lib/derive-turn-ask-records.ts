import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import {
  parseAskUserToolResult,
  type UserAskRecord,
} from "@stella/contracts/user-ask-deck";
import type { EventRecord } from "@/features/chat/lib/event-transforms";

export const deriveTurnAskRecords = (
  events: readonly EventRecord[],
): UserAskRecord[] => {
  const records: UserAskRecord[] = [];
  for (const event of events) {
    if (!event || event.type !== "tool_result") continue;
    const payload = event.payload as
      | {
          toolName?: unknown;
          agentType?: unknown;
          result?: unknown;
          resultPreview?: unknown;
          requestId?: unknown;
          error?: unknown;
        }
      | undefined;
    if (!payload || payload.toolName !== "ask_user") continue;
    if (typeof payload.error === "string" && payload.error) continue;
    if (
      typeof payload.agentType === "string" &&
      payload.agentType !== AGENT_IDS.ORCHESTRATOR
    ) {
      continue;
    }
    const parsed =
      parseAskUserToolResult(payload.result) ??
      parseAskUserToolResult(payload.resultPreview);
    if (!parsed) continue;
    records.push({
      id: event._id,
      ...(typeof payload.requestId === "string"
        ? { toolCallId: payload.requestId }
        : {}),
      createdAt: event.timestamp,
      defaulted: parsed.defaulted,
      answers: parsed.answers,
    });
  }
  return records;
};
