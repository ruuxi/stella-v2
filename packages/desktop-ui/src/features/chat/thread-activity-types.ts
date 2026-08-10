import type { AgentModelConfigSnapshot } from "@stella/contracts/agent-engine";
import type {
  EventRecord,
  ThreadActivityRecord,
  ThreadActivityUpdatedPayload,
} from "@stella/contracts/local-chat";

export type DesktopThreadActivityRecord = ThreadActivityRecord & {
  source: "stella" | "claude-native";
  attemptGeneration?: number;
  modelConfigSnapshot?: AgentModelConfigSnapshot;
  readOnly?: boolean;
  assistantMessages?: string[];
  assistantMessagesUpdatedAt?: number;
  assistantMessagesUpdatedSequence?: number;
};

export type ThreadActivityAssistantUpdate = {
  threadId: string;
  assistantMessages: string[];
  reasoningSummaries: string[];
  latestMessage: string;
  atMs: number;
  atSequence?: number;
  attemptGeneration: number;
  rootRunId?: string;
};

export type ThreadTranscriptUpdate = {
  source?: "stella" | "claude-native";
  threadId: string;
  entryId: string;
  atMs: number;
};

export type AgentThreadMessageRecord = {
  entryId?: string;
  sequence?: number;
  source?: string;
  timestamp: number;
  role:
    | "user"
    | "assistant"
    | "reasoning"
    | "tool"
    | "checkpoint"
    | "lifecycle";
  content: string;
  toolActivity?: {
    toolCallId: string;
    toolName: string;
    status: "running" | "completed" | "error";
    input?: string;
    output?: string;
    completedAt?: number;
  };
  lifecycleEvent?: EventRecord;
};

export type DesktopThreadActivityUpdatedPayload =
  ThreadActivityUpdatedPayload & {
    assistantUpdate?: ThreadActivityAssistantUpdate;
    transcriptUpdate?: ThreadTranscriptUpdate;
  };
