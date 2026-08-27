import { cn } from "@/shared/lib/utils";
import type { MessageRecord } from "@stella/contracts/local-chat";
import type { QueuedUserMessage } from "@/features/chat/hooks/use-streaming-chat";
import type { ChatColumnScroll } from "@/features/chat/chat-column-types";
import { ConversationEvents } from "@/app/chat/ConversationEvents";
import type { InlineWorkingIndicatorMountProps } from "@/app/chat/InlineWorkingIndicator";
import type { AgentModelConfigsByThread } from "@/features/chat/hooks/use-agent-model-configs";
import "@/app/chat/full-shell.chat.css";
import "./compact-conversation.css";

type CompactConversationVariant = "orb" | "sidebar";

type CompactConversationSurfaceProps = {

  className: string;

  contentContainerStyle?: React.CSSProperties;
  variant: CompactConversationVariant;

  scroll: ChatColumnScroll;
  messages: MessageRecord[];
  conversationId?: string | null;
  agentModelConfigByThread?: AgentModelConfigsByThread;
  maxItems?: number;
  isStreaming: boolean;
  runtimeStatusText?: string | null;
  pendingUserMessageId: string | null;
  queuedUserMessages?: QueuedUserMessage[];

  onCancelQueued?: (message: QueuedUserMessage) => void;

  indicator?: InlineWorkingIndicatorMountProps;
  hasOlderMessages?: boolean;
  isLoadingOlder?: boolean;
  isLoadingHistory?: boolean;
  showConversation?: boolean;

  estimatedItemSize?: number;
};

export function CompactConversationSurface({
  className,
  contentContainerStyle,
  variant,
  scroll,
  messages,
  conversationId,
  agentModelConfigByThread,
  maxItems,
  pendingUserMessageId,
  queuedUserMessages,
  onCancelQueued,
  indicator,
  hasOlderMessages,
  isLoadingOlder,
  isLoadingHistory,
  showConversation = true,
  estimatedItemSize = 96,
}: CompactConversationSurfaceProps) {
  return (
    <div
      className={cn(
        "chat-viewport-region",
        `chat-viewport-region--${variant}`,
        showConversation && "has-messages",
      )}
    >
      {showConversation ? (
        <div
          className={cn(
            "chat-conversation-surface",
            `chat-conversation-surface--${variant}`,
          )}
        >
          <ConversationEvents
            messages={messages}
            conversationId={conversationId}
            agentModelConfigByThread={agentModelConfigByThread}
            maxItems={maxItems}
            pendingUserMessageId={pendingUserMessageId}
            queuedUserMessages={queuedUserMessages}
            onCancelQueued={onCancelQueued}
            indicator={indicator}
            hasOlderMessages={hasOlderMessages}
            isLoadingOlder={isLoadingOlder}
            isLoadingHistory={isLoadingHistory}
            listRef={scroll.listRef}
            className={className}
            contentContainerStyle={contentContainerStyle}
            estimatedItemSize={estimatedItemSize}
          />
        </div>
      ) : null}
    </div>
  );
}
