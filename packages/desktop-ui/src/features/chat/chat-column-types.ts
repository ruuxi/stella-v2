import type { Dispatch, RefObject, SetStateAction } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import type { QueuedUserMessage } from "@/features/chat/hooks/use-streaming-chat";
import type {
  EventRecord,
  TaskItem,
} from "@/features/chat/lib/event-transforms";

export type { EventRecord };
import type { ChatContext } from "@/shared/types/electron";

export type ChatColumnConversation = {

  tasks: TaskItem[];

  activity: {
    activities: EventRecord[];
    hasOlder: boolean;
    isLoadingOlder: boolean;
    loadOlder: () => void;
  };

  files: {
    files: EventRecord[];
    hasOlder: boolean;
    isLoadingOlder: boolean;
    loadOlder: () => void;
  };
  streaming: {
    reasoningText: string;
    isStreaming: boolean;
    runtimeStatusText?: string | null;
    activeToolCallId?: string | null;
    activeToolName?: string | null;
    latestCompletedTool?: {
      toolName: string;
      toolCallId: string;
      exitCode?: number;
    } | null;
    hasToolActivity?: boolean;
    isToolActive?: boolean;
    pendingUserMessageId: string | null;
    queuedUserMessages: QueuedUserMessage[];

    removeQueuedUserMessage: (messageId: string) => void;
  };
  history: {
    hasOlderMessages: boolean;
    hasNewerMessages: boolean;
    isLoadingOlder: boolean;
    isLoadingNewer: boolean;
    isInitialLoading: boolean;
  };
};

export type ChatColumnComposer = {
  message: string;
  setMessage: Dispatch<SetStateAction<string>>;
  chatContext: ChatContext | null;
  setChatContext: Dispatch<SetStateAction<ChatContext | null>>;
  selectedText: string | null;
  setSelectedText: Dispatch<SetStateAction<string | null>>;
  canSubmit: boolean;
  focusRequestId?: number;
  requestFocus?: () => void;
  onSend: () => void;
  onStop: () => void;
};

export type ChatColumnScroll = {
  listRef: RefObject<LegendListRef | null>;
  showScrollButton: boolean;

  isAtBottom: boolean;

  isNearBottom: boolean;

  isFollowingLatest: boolean;

  isUserScrolling: boolean;

  noteManualScroll: () => void;
  getIsFollowing: () => boolean;
  scrollToBottom: (behavior?: "instant" | "smooth") => void;

  thumbRef: (el: HTMLDivElement | null) => void;
};

export type ChatColumnProps = {
  conversation: ChatColumnConversation;
  composer: ChatColumnComposer;
  scroll: ChatColumnScroll;
  composerEntering?: boolean;
  conversationId: string | null;
  showHomeContent?: boolean;
};
