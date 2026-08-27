import { type ReactNode } from "react";
import { useFullShellChat } from "@/shell/use-full-shell-chat";
import { ChatRuntimeContext } from "@/context/chat-runtime-context";
import { ChatMessagesContext } from "@/context/chat-messages-context";
import { UserMessageActionsBusyContext, UserMessageActionsContext, } from "@/app/chat/user-message-actions-context";
import { usePetStatusBroadcast } from "@/shell/pet/use-pet-status-broadcast";
import { useTaskDecorationPublisher } from "@/features/chat/streaming/use-task-decoration-publisher";
import { isTraceDiagnosticsEnabled } from "@/platform/diagnostics/trace-store";

type ChatRuntimeProviderProps = {
  activeConversationId: string | null;
  isOnChatRoute: boolean;

  navigateToConversation?: (conversationId: string, title?: string) => void;
  children: ReactNode;
};

export function ChatRuntimeProvider({
  activeConversationId,
  isOnChatRoute,
  navigateToConversation,
  children,
}: ChatRuntimeProviderProps) {

  const { runtime, messages } = useFullShellChat({
    activeConversationId,
    isOnChatRoute,
    navigateToConversation,

    traceEnabled: isTraceDiagnosticsEnabled(),
  });

  usePetStatusBroadcast({
    messages,
    tasks: runtime.conversation.tasks,
    runtimeStatusText: runtime.conversation.streaming.runtimeStatusText ?? "",
    isStreaming: runtime.conversation.isStreaming,
    pendingUserMessageId: runtime.conversation.pendingUserMessageId ?? null,
  });

  useTaskDecorationPublisher();

  return (
    <ChatRuntimeContext.Provider value={runtime}>
      <ChatMessagesContext.Provider value={messages}>
        <UserMessageActionsContext.Provider value={runtime.messageActions}>
          <UserMessageActionsBusyContext.Provider
            value={runtime.conversation.isStreaming}
          >
            {children}
          </UserMessageActionsBusyContext.Provider>
        </UserMessageActionsContext.Provider>
      </ChatMessagesContext.Provider>
    </ChatRuntimeContext.Provider>
  );
}
