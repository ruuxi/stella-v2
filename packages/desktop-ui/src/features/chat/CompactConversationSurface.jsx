import { cn } from "@/shared/lib/utils";
import { useDeferredChatMessages } from "@/features/chat/hooks/use-deferred-chat-messages";
import { ConversationEvents } from "@/app/chat/ConversationEvents";
import "@/app/chat/full-shell.chat.css";
import "./compact-conversation.css";
export function CompactConversationSurface({ className, contentContainerStyle, variant, scroll, messages, conversationId, agentModelConfigByThread, maxItems, pendingUserMessageId, queuedUserMessages, onCancelQueued, indicator, hasOlderMessages, isLoadingOlder, isLoadingHistory, showConversation = true, estimatedItemSize = 96, }) {
    const paintedMessages = useDeferredChatMessages(messages, scroll.isUserScrolling, conversationId);
    return (<div className={cn("chat-viewport-region", `chat-viewport-region--${variant}`, showConversation && "has-messages")}>
      {showConversation ? (<div className={cn("chat-conversation-surface", `chat-conversation-surface--${variant}`)}>
          <ConversationEvents messages={paintedMessages} conversationId={conversationId} agentModelConfigByThread={agentModelConfigByThread} maxItems={maxItems} pendingUserMessageId={pendingUserMessageId} queuedUserMessages={queuedUserMessages} onCancelQueued={onCancelQueued} indicator={indicator} hasOlderMessages={hasOlderMessages} isLoadingOlder={isLoadingOlder} isLoadingHistory={isLoadingHistory} listRef={scroll.listRef} className={className} contentContainerStyle={contentContainerStyle} estimatedItemSize={estimatedItemSize}/>
        </div>) : null}
    </div>);
}
