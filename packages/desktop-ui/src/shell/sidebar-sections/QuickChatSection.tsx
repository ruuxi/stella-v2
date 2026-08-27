/**
 * Quick chat — an ephemeral, full-featured chat docked in the right sidebar.
 *
 * It reuses the normal sidebar chat UI (`ChatPanelTab`) so it looks and behaves
 * exactly like the main chat, but runs against its OWN throwaway conversation
 * so a quick side question never lands in — or interferes with — the user's
 * main thread. The conversation is minted once when the section first mounts
 * (and re-minted by "New chat"); it is a scratch conversation that is never
 * surfaced in the main conversation tab strip / history, so it stays out of
 * the way. A fresh one is created each app session.
 *
 * `isolated` detaches `ChatPanelTab` from the shared main-chat runtime context
 * so it shows no activity pill and no cross-thread agent state.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChatPanelTab } from "@/shell/ChatSidebar";
import { useConversationMessages } from "@/features/chat/hooks/use-conversation-messages";
import { useConversationDisplayMessages } from "@/features/chat/hooks/use-conversation-display-messages";
import { useStreamingChat } from "@/features/chat/hooks/use-streaming-chat";
import { createNewLocalConversationId } from "@/features/chat/services/local-chat-store";
import { useDisplayPanelExpanded } from "@/features/workspace-display/tab-store";
import type { ChatContext } from "@/shared/types/electron";
import { SquarePen } from "@/ui/icons";
import "./quick-chat-section.css";

const NO_OP = () => {};

function QuickChatConversation({
  conversationId,
  onNewChat,
}: {
  conversationId: string;
  onNewChat: () => void;
}) {
  const panelExpanded = useDisplayPanelExpanded();
  const {
    messages: persistedMessages,
    hasOlderMessages,
    hasNewerMessages,
    isLoadingOlder,
    isLoadingNewer,
    isInitialLoading,
    loadOlder,
    loadNewer,
    loadLatest,
  } = useConversationMessages(conversationId);

  const {
    optimisticEvents,
    streamingAssistants,
    runtimeStatusText,
    activeToolCallId,
    activeToolName,
    isToolActive,
    isStreaming,
    pendingUserMessageId,
    queuedUserMessages,
    removeQueuedUserMessage,
    sendMessage,
    cancelCurrentStream,
  } = useStreamingChat({ conversationId, persistedMessages });

  const displayMessages = useConversationDisplayMessages({
    conversationId,
    persistedMessages,
    optimisticEvents,
    streamingAssistants,
  });

  const handleSend = useCallback(
    (
      text: string,
      chatContext?: ChatContext | null,
      selectedText?: string | null,
    ) => {
      return sendMessage({
        text,
        chatContext: chatContext ?? null,
        selectedText: selectedText ?? null,
        onClear: NO_OP,
      });
    },
    [sendMessage],
  );

  return (
    <div className="quick-chat">
      <div className="quick-chat__bar">
        <span className="quick-chat__title">Quick chat</span>
        <button
          type="button"
          className="quick-chat__new"
          onClick={onNewChat}
          aria-label="New quick chat"
          title="New quick chat"
        >
          <SquarePen size={15} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      <div className="quick-chat__body">
        <ChatPanelTab
          isolated
          wideLayout={panelExpanded}
          messages={displayMessages}
          conversationId={conversationId}
          isStreaming={isStreaming}
          runtimeStatusText={runtimeStatusText}
          activeToolCallId={activeToolCallId}
          activeToolName={activeToolName}
          isToolActive={isToolActive}
          pendingUserMessageId={pendingUserMessageId}
          queuedUserMessages={queuedUserMessages}
          removeQueuedUserMessage={removeQueuedUserMessage}
          hasOlderMessages={hasOlderMessages}
          hasNewerMessages={hasNewerMessages}
          isLoadingOlder={isLoadingOlder}
          isLoadingNewer={isLoadingNewer}
          isInitialLoading={isInitialLoading}
          onLoadOlder={loadOlder}
          onLoadNewer={loadNewer}
          onLoadLatest={loadLatest}
          onSend={handleSend}
          onStop={cancelCurrentStream}
        />
      </div>
    </div>
  );
}

export function QuickChatSection({ active = false }: { active?: boolean }) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  // Bump to force a brand-new throwaway conversation ("New chat").
  const [generation, setGeneration] = useState(0);
  // Mint the throwaway conversation lazily, only once this tab is actually
  // opened — so an unopened Quick chat tab doesn't accrue an orphan conversation.
  const [activated, setActivated] = useState(false);

  useEffect(() => {
    if (active) setActivated(true);
  }, [active]);

  useEffect(() => {
    if (!activated) return;
    let disposed = false;
    setConversationId(null);
    void createNewLocalConversationId()
      .then((id) => {
        if (!disposed) setConversationId(id);
      })
      .catch(() => {
        // Leave the surface empty if the id couldn't be minted; the next
        // "New chat" retries.
      });
    return () => {
      disposed = true;
    };
  }, [activated, generation]);

  const startNewChat = useCallback(() => {
    setGeneration((value) => value + 1);
  }, []);

  // Remount the conversation subtree on id change so every per-conversation
  // hook (messages, streaming, scroll) re-seeds cleanly for the new thread.
  const key = useMemo(() => conversationId ?? "pending", [conversationId]);

  if (!conversationId) {
    return <div className="quick-chat quick-chat--pending" aria-hidden="true" />;
  }

  return (
    <QuickChatConversation
      key={key}
      conversationId={conversationId}
      onNewChat={startNewChat}
    />
  );
}
