import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { ChevronDown } from "@/ui/icons";
import { ConnectorConnectCard } from "./ConnectorConnectCard";
import { ConversationEvents } from "./ConversationEvents";
import { useChatMessages } from "@/context/use-chat-messages";
import { Composer } from "./Composer";
import { HomeContent } from "@/app/home/HomeContent";
import { buildInlineWorkingIndicatorProps } from "@/features/chat/working-indicator-state";
import { useFileDrop } from "@/features/chat/hooks/use-file-drop";
import { useReadAloud } from "@/features/voice/services/read-aloud/use-read-aloud";
import type { ChatColumnProps } from "@/features/chat/chat-column-types";
import { useAssistantReplyPeek } from "@/features/chat/hooks/use-assistant-reply-peek";
import { useAgentModelConfigs } from "@/features/chat/hooks/use-agent-model-configs";
import {
  restoreQueuedTextToComposer,
  type QueuedUserMessage,
} from "@/features/chat/hooks/queued-user-messages";
import { useT } from "@/shared/i18n";
import "./full-shell.chat.css";

const FULL_CHAT_CONTENT_STYLE = {
  maxWidth: "min(50rem, 100%)",
  marginLeft: "auto",
  marginRight: "auto",
  paddingLeft: 24,
  paddingRight: 24,
  paddingTop: 112,
  paddingBottom: 30,
} as const;

export const ChatColumn = memo(function ChatColumn({
  conversation,
  composer,
  scroll,
  composerEntering,
  conversationId,
  showHomeContent,
}: ChatColumnProps) {
  const t = useT();
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ y: number; scrollTop: number } | null>(null);
  const { noteManualScroll } = scroll;

  const getScrollNode = useCallback((): HTMLElement | null => {
    const list = scroll.listRef.current;
    if (!list) return null;
    return list.getScrollableNode();
  }, [scroll.listRef]);

  const handleThumbDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = getScrollNode();
      if (!el) return;
      noteManualScroll();
      isDraggingRef.current = true;
      dragStartRef.current = { y: e.clientY, scrollTop: el.scrollTop };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [getScrollNode, noteManualScroll],
  );

  const handleThumbMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDraggingRef.current || !dragStartRef.current) return;
      const el = getScrollNode();
      if (!el) return;
      noteManualScroll();
      const trackHeight = el.clientHeight;
      const scrollRange = Math.max(1, el.scrollHeight - el.clientHeight);
      const dy = e.clientY - dragStartRef.current.y;
      const scrollDelta = (dy / trackHeight) * scrollRange;
      const next = Math.max(
        0,
        Math.min(scrollRange, dragStartRef.current.scrollTop + scrollDelta),
      );
      const list = scroll.listRef.current;
      if (list) {
        void list.scrollToOffset({ offset: next, animated: false });
      } else {
        el.scrollTop = next;
      }
    },
    [getScrollNode, noteManualScroll, scroll.listRef],
  );

  const handleThumbUp = useCallback(() => {
    isDraggingRef.current = false;
    dragStartRef.current = null;
  }, []);

  const {
    showScrollButton,
    scrollToBottom,
    thumbRef,
    listRef,
    isFollowingLatest,
    isNearBottom,
  } = scroll;

  const messages = useChatMessages();
  const agentModelConfigByThread = useAgentModelConfigs(conversation.tasks);

  const assistantReplyPeek = useAssistantReplyPeek({
    messages,
    isFollowingLatest,
    isNearBottom,
  });

  const [homeVisible, setHomeVisible] = useState(Boolean(showHomeContent));
  const [homeLeaving, setHomeLeaving] = useState(false);

  useEffect(() => {
    if (showHomeContent) {
      setHomeLeaving(false);
      setHomeVisible(true);
    } else if (homeVisible) {
      setHomeLeaving(true);
      const timer = setTimeout(() => {
        setHomeVisible(false);
        setHomeLeaving(false);
      }, 280);
      return () => clearTimeout(timer);
    }
    return undefined;

  }, [showHomeContent]);

  useReadAloud(messages);

  const indicatorProps = useMemo(
    () =>
      buildInlineWorkingIndicatorProps({
        isStreaming: Boolean(conversation.streaming.isStreaming),
        isToolActive: Boolean(conversation.streaming.isToolActive),
        activeToolName: conversation.streaming.activeToolName,
        activeToolCallId: conversation.streaming.activeToolCallId,
        runtimeStatusText: conversation.streaming.runtimeStatusText,
      }),
    [
      conversation.streaming.isStreaming,
      conversation.streaming.isToolActive,
      conversation.streaming.activeToolName,
      conversation.streaming.activeToolCallId,
      conversation.streaming.runtimeStatusText,
    ],
  );

  const { isDragOver, dropHandlers } = useFileDrop({
    setChatContext: composer.setChatContext,
  });

  const { removeQueuedUserMessage } = conversation.streaming;
  const { setMessage: setComposerMessage, requestFocus: requestComposerFocus } =
    composer;
  const handleCancelQueued = useCallback(
    (message: QueuedUserMessage) => {
      removeQueuedUserMessage(message.id);
      setComposerMessage((current) =>
        restoreQueuedTextToComposer(current, message.text),
      );
      requestComposerFocus?.();
    },
    [removeQueuedUserMessage, setComposerMessage, requestComposerFocus],
  );

  const renderComposer = (
    surface: "chat" | "home",
    replyPeek: ComponentProps<typeof Composer>["replyPeek"],
  ) => {
    const isActiveSurface =
      surface === "home" ? showHomeContent : !showHomeContent;
    return (
      <Composer
        message={composer.message}
        setMessage={composer.setMessage}
        chatContext={composer.chatContext}
        setChatContext={composer.setChatContext}
        selectedText={composer.selectedText}
        setSelectedText={composer.setSelectedText}
        isStreaming={conversation.streaming.isStreaming}
        canSubmit={composer.canSubmit}
        focusRequestId={isActiveSurface ? composer.focusRequestId : undefined}
        conversationId={conversationId}
        onSend={composer.onSend}
        onStop={composer.onStop}
        isDragOver={isDragOver}
        replyPeek={replyPeek}
        suggestionsActive={isActiveSurface}
      />
    );
  };

  const chatReplyPeek = assistantReplyPeek.visible
    ? {
        text: assistantReplyPeek.previewText,
        onJumpToBottom: () => scrollToBottom("smooth"),
        onDismiss: assistantReplyPeek.dismiss,
      }
    : null;

  return (
    <div className="full-body-row">
      {

}
      <div
        className={`full-body-chat-layer${showHomeContent ? " full-body-chat-layer--hidden" : ""}`}
        inert={showHomeContent || undefined}
      >
        <div className="full-body-main" {...dropHandlers}>
          {

}
          <div className="chat-viewport-region">
            <ConversationEvents
              messages={messages}
              conversationId={conversationId}
              agentModelConfigByThread={agentModelConfigByThread}
              pendingUserMessageId={conversation.streaming.pendingUserMessageId}
              queuedUserMessages={conversation.streaming.queuedUserMessages}
              onCancelQueued={handleCancelQueued}
              indicator={indicatorProps}
              hasOlderMessages={conversation.history.hasOlderMessages}
              isLoadingOlder={conversation.history.isLoadingOlder}
              isLoadingHistory={conversation.history.isInitialLoading}
              listRef={listRef}
              className="session-content"
              contentContainerStyle={FULL_CHAT_CONTENT_STYLE}
              estimatedItemSize={140}
            />

            {showScrollButton && !assistantReplyPeek.visible && (
              <button
                className="scroll-to-bottom"
                onClick={() => scrollToBottom("smooth")}
                aria-label={t("app.chat.column.scrollToBottom")}
              >
                <ChevronDown size={16} strokeWidth={2.5} />
              </button>
            )}
          </div>

          {
}
          <ConnectorConnectCard conversationId={conversationId} />

          {}
          <div
            className={
              composerEntering
                ? "composer-wrap composer-wrap--entering"
                : "composer-wrap"
            }
          >
            {renderComposer("chat", chatReplyPeek)}
          </div>
        </div>

        {

}
        <div className="chat-scrollbar">
          <div
            ref={thumbRef}
            className="chat-scrollbar__thumb"
            onPointerDown={handleThumbDown}
            onPointerMove={handleThumbMove}
            onPointerUp={handleThumbUp}
            onPointerCancel={handleThumbUp}
          />
        </div>
      </div>

      {homeVisible && (
        <div
          className={`full-body-home-overlay full-body-main--home${homeLeaving ? " full-body-main--home-leaving" : ""}`}
          {...dropHandlers}
        >
          <HomeContent>
            <div
              className="composer-wrap"
              inert={showHomeContent ? undefined : true}
            >
              {renderComposer("home", null)}
            </div>
          </HomeContent>
        </div>
      )}
    </div>
  );
});
