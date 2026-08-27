import type { ReactNode } from "react";
import type {
  Attachment,
  ChannelEnvelope,
} from "@/features/chat/lib/event-transforms";
import type { DisplayPayload } from "@stella/contracts/desktop/display-payload";
import type { AgentResponseTarget } from "@/features/chat/streaming/streaming-types";
import type { SelfModApplied } from "@/features/chat/self-mod-types";
import type { WebSearchImageHit } from "@/features/chat/lib/derive-turn-web-search";
import type { TaskToolActivity } from "@stella/contracts/agent-runtime";
import type { TurnMapArtifact } from "@/features/chat/lib/derive-turn-map-artifacts";
import type { PastedTextDescriptor } from "@/features/chat/lib/paste-context";
import type { ToolActivityGroup } from "@/features/chat/lib/tool-activity";
import type { AgentCompletionSection } from "@/features/chat/lib/agent-completion";
import type { OfficePreviewRef } from "@stella/contracts/office-preview";
import type { VoiceSessionSummaryMetadata } from "@stella/contracts/local-chat";

export type UserRowViewModel = {
  kind: "user";
  id: string;
  text: string;

  timestampMs?: number;

  justSent?: boolean;
  windowLabel?: string;
  windowPreviewImageUrl?: string;

  appSelectionLabels?: string[];
  activityLabel?: string;

  pastedTexts?: PastedTextDescriptor[];

  quotedText?: string;
  attachments: Attachment[];
  channelEnvelope?: ChannelEnvelope;
};

export type AssistantRowViewModel = {
  kind: "assistant";

  id: string;
  text: string;

  timestampMs?: number;

  cacheKey: string;

  sourceMessageId?: string;
  sourceMessageSequence?: number;
  toolEventSummary?: {
    totalCount: number;
    loadedCount: number;
    truncated: boolean;
    totalCountIsLowerBound?: boolean;
    detailLoaded?: boolean;
    detailCursor?: { timestamp: number; id: string; sequence?: number };
    detailHasMore?: boolean;
    livePinsPending?: boolean;
  };

  justArrived?: boolean;

  isIntraTurn?: boolean;
  responseTarget?: AgentResponseTarget;

  replyToUserMessageId?: string;
  officePreviewRef?: OfficePreviewRef;
  resourcePayload?: DisplayPayload;

  inlineImagePayloads?: DisplayPayload[];

  webSearchResults?: WebSearchImageHit[];

  mapArtifacts?: TurnMapArtifact[];

  sourceDiffPayloads?: DisplayPayload[];
  selfModApplied?: SelfModApplied;

  voiceSession?: VoiceSessionSummaryMetadata;

  toolActivity?: ToolActivityGroup;

  backgroundWork?: {
    threadIds: string[];
    completedThreadIds: string[];
    failedThreadIds?: string[];

    pausedThreadIds?: string[];
    supersededThreadIds?: string[];

    descriptions: Record<string, string>;

    statusTexts?: Record<string, string>;

    progressTexts?: Record<string, string>;

    toolActivities?: Record<string, TaskToolActivity>;

    followUpThreadIds?: string[];

    spawnedAtMs?: Record<string, number>;

    startEventIdsByThread: Record<string, string>;

    attemptGenerationsByThread?: Record<string, number>;
    rootRunIdsByThread: Record<string, string>;
    terminalEventIdsByThread?: Record<string, string>;
    cardId: string;

    completionSections?: AgentCompletionSection[];
  };

  agentCompletion?: {
    sections: AgentCompletionSection[];
  };

  customSlot?: ReactNode;
  customSlotKey?: string;
};

export type EventRowViewModel = UserRowViewModel | AssistantRowViewModel;
