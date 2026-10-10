import { type ReactNode } from "react";
import { useFullShellChat } from "@/shell/use-full-shell-chat";
import { ChatRuntimeContext } from "@/context/chat-runtime-context";
import { ChatMessagesContext } from "@/context/chat-messages-context";
import { isTraceDiagnosticsEnabled } from "@/platform/diagnostics/trace-store";

/**
 * Hoists `useFullShellChat`'s output into a single Context so the chat
 * route (`app/chat`) and the floating ChatSidebar / RightSidebar overlays
 * mounted by `__root.tsx` all consume the same conversation state. Running
 * the hook once also keeps backend subscriptions deduplicated.
 *
 * The matching `useChatRuntime` hook lives in
 * `@/context/use-chat-runtime` — they are deliberately split so this file
 * exports *only* the Provider component and stays Fast-Refresh eligible.
 */
type ChatRuntimeProviderProps = {
  activeConversationId: string | null;
  isOnChatRoute: boolean;
  children: ReactNode;
};

export function ChatRuntimeProvider({
  activeConversationId,
  isOnChatRoute,
  children,
}: ChatRuntimeProviderProps) {
  // `runtime` is the stable slice (identity changes only at tool/text
  // boundaries); `messages` is the high-frequency timeline, published on its
  // own context so only the timeline renderers re-render per streamed frame.
  const { runtime, messages } = useFullShellChat({
    activeConversationId,
    isOnChatRoute,
    // Trace diagnostics are an explicit opt-in that defaults OFF, not a
    // build-mode consequence: see isTraceDiagnosticsEnabled.
    traceEnabled: isTraceDiagnosticsEnabled(),
  });

  return (
    <ChatRuntimeContext.Provider value={runtime}>
      <ChatMessagesContext.Provider value={messages}>
        {children}
      </ChatMessagesContext.Provider>
    </ChatRuntimeContext.Provider>
  );
}
