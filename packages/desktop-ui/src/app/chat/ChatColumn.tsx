/**
 * ChatColumn: virtualized chat viewport (Legend List v3 web entry),
 * custom scrollbar overlay, composer.
 *
 * Layout:
 *   .full-body-main
 *     .chat-viewport-region (relative; hosts the absolute scrollbar +
 *       scroll-to-bottom button overlays)
 *       <ConversationEvents> → <ChatTimeline> → <LegendList />
 *     .composer-wrap
 *
 * The list element itself is the scroll container — there is no
 * column-reverse wrapper anymore. `useChatScrollManagement` drives the
 * thumb / at-bottom state from the list's native scroll node and `getState()`
 * snapshot rather than reading `scrollTop` from a manual div.
 */
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

/**
 * Inline content-container style for Legend List.
 *
 * Important: Legend sums `paddingTop`/`paddingBottom` as numbers when
 * computing `contentLength`. Strings like `"112px"` get string-concat'd
 * (`"25656" + "112px" + "30px"`) and the resulting non-numeric
 * `contentLength` poisons every "is at end" / "scroll target" computation
 * and stops items from rendering. Always pass paddings as numbers (px).
 */
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

  /**
   * The Legend List exposes its scroll element via `getScrollableNode()`.
   * We only need it inside drag handlers, so we resolve lazily rather
   * than caching a ref that could go stale across surface remounts.
   */
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

  // Live timeline. Assistant messages arrive whole, so the list only
  // reconciles on real membership changes — there is no provider cadence to
  // throttle against the scroll frame budget any more.
  const messages = useChatMessages();
  const agentModelConfigByThread = useAgentModelConfigs(conversation.tasks);

  const assistantReplyPeek = useAssistantReplyPeek({
    messages,
    isFollowingLatest,
    isNearBottom,
  });

  /**
   * Delay unmount of home content so the fade-out can play. Synchronous
   * setState here is intentional — the fade-out timer needs immediate
   * state to drive the leave animation; there's no external system to
   * subscribe to.
   */
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHomeContent]);

  useReadAloud(messages);

  // Memoize over the primitive streaming inputs so the indicator mount props
  // keep a stable object identity across unrelated re-renders. A fresh object
  // every render invalidates `ChatTimeline`'s `ListFooter` useMemo and forces
  // the whole working-indicator subtree (WorkingIndicator -> StellaCharacter
  // -> SwapText) to reconcile.
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
  // Drag-and-drop file attach stays live at all times, including while the
  // turn is streaming or agents are busy. Dropped files land in
  // `composer.chatContext` (screenshot/file chips) exactly as when idle;
  // this only governs the *attach* interaction, not submit/queue behavior.
  const { isDragOver, dropHandlers } = useFileDrop({
    setChatContext: composer.setChatContext,
  });

  /**
   * Cancel a still-queued follow-up: drop it from the send queue and hand its
   * text back to the composer so the user can edit or resend it. Restoring
   * only clobbers an empty composer (see `restoreQueuedTextToComposer`); an
   * in-progress draft keeps its place and the recovered text is appended.
   */
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

  /**
   * Two synced instances of the (fully controlled) composer: one pinned at
   * the bottom of the persistently-mounted chat, one centered inside the
   * home overlay. Both read the same lifted state, so their content,
   * context chips, and submittability stay identical — only their on-screen
   * position differs. `focusRequestId` is routed to whichever surface is
   * currently active so focus lands on the visible composer, and the
   * off-surface wrapper is `inert` so it stays out of the tab order and
   * can't capture Enter/clicks while hidden.
   */
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

  // Home content is an overlay ON TOP of the always-mounted chat, not a
  // replacement for it — so navigating home and back never unmounts the
  // LegendList. That preserves the user's scroll position and removes the
  // remount flash. The chat content cross-fades under the overlay via
  // opacity (which keeps the scroll node mounted + measurable, unlike
  // `display:none`), while the overlay's own children run their existing
  // enter/leave fades.
  return (
    <div className="full-body-row">
      {/* The whole chat layer (messages + composer + workspace strip +
          scrollbar) fades as one unit under the home overlay. Hiding the
          layer wholesale — rather than toggling the workspace strip's own
          `forceHidden` — avoids re-running the strip's 460ms width/slide
          animation on every home↔chat switch. */}
      <div
        className={`full-body-chat-layer${showHomeContent ? " full-body-chat-layer--hidden" : ""}`}
        inert={showHomeContent || undefined}
      >
        <div className="full-body-main" {...dropHandlers}>
          {/* Viewport region: list + overlay scroll-to-bottom.
            The custom scrollbar deliberately hangs off the layer (sibling
            below) rather than the viewport region so it pins to the
            right edge of the entire chat surface — past the workspace
            strip — instead of sitting at the inside edge of the
            centered chat column. */}
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

          {/* Inline connect offer (agent-initiated) pinned above the
              composer while the agent's turn waits on the answer. */}
          <ConnectorConnectCard conversationId={conversationId} />

          {/* Composer: normal flow below the scroll viewport */}
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

        {/* Custom scrollbar thumb overlay — pinned to the right edge of
          the layer (past the workspace strip) so it tracks the app side
          rather than the inside edge of the chat column. */}
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
