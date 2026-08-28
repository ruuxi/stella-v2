import {
  useState,
  useRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
} from "react";
import { CompactConversationSurface } from "@/features/chat/CompactConversationSurface";
import type { ChatColumnScroll } from "@/features/chat/chat-column-types";
import { useChatScrollManagement } from "@/shell/use-chat-scroll-management";
import {
  ComposerContextRow,
  useComposerContextSuggestions,
} from "@/app/chat/ComposerContextRow";
import { ComposerLeadRow } from "@/app/chat/ComposerLeadRow";
import { ConnectorConnectCard } from "@/app/chat/ConnectorConnectCard";
import { ComposerAddMenu } from "@/app/chat/ComposerAddMenu";
import {
  ComposerMicButton,
  ComposerSubmitButton,
  ComposerStopButton,
  ComposerTextarea,
} from "@/features/chat/ComposerPrimitives";
import { useDictation } from "@/features/dictation/hooks/use-dictation";
import { DictationRecordingBar } from "@/features/dictation/components/DictationRecordingBar";
import {
  deriveComposerState,
  hasAttachedComposerChips,
} from "@/features/chat/composer-context";
import { buildInlineWorkingIndicatorProps } from "@/features/chat/working-indicator-state";
import { useFileDrop } from "@/features/chat/hooks/use-file-drop";
import { useComposerMessageState } from "@/features/chat/hooks/use-composer-message-state";
import { useOptimisticStop } from "@/features/chat/hooks/use-optimistic-stop";
import { handleComposerPaste } from "@/features/chat/lib/paste-context";
import { useReadAloud } from "@/features/voice/services/read-aloud/use-read-aloud";
import {
  useScreenshotPreview,
  ScreenshotPreviewOverlay,
} from "@/app/chat/ScreenshotPreview";
import type { ChatContext } from "@/shared/types/electron";
import type { MessageRecord } from "@stella/contracts/local-chat";
import type { QueuedUserMessage } from "@/features/chat/hooks/use-streaming-chat";
import { restoreQueuedTextToComposer } from "@/features/chat/hooks/queued-user-messages";
import { useCapturedChatContext } from "./use-captured-chat-context";
import {
  updateComposerTextareaExpansion,
  useAnimatedComposerShell,
} from "@/shared/hooks/use-animated-composer-shell";
import { useAssistantReplyPeek } from "@/features/chat/hooks/use-assistant-reply-peek";
import { useAgentModelConfigs } from "@/features/chat/hooks/use-agent-model-configs";
import { ChatRuntimeContext } from "@/context/chat-runtime-context";
import { useT } from "@/shared/i18n";
import "./chat-sidebar.css";

const SIDEBAR_CONTENT_STYLE = {
  paddingLeft: 10,
  paddingRight: 10,
  paddingTop: 8,
  paddingBottom: 4,
} as const;

const WIDE_PANEL_CONTENT_STYLE = {
  maxWidth: "min(50rem, 100%)",
  marginLeft: "auto",
  marginRight: "auto",
  paddingLeft: 24,
  paddingRight: 24,
  paddingTop: 16,
  paddingBottom: 4,
} as const;

interface ChatSidebarOpenOptions {

  chatContext?: ChatContext | null;

  prefillText?: string;
}

export type ChatPanelOpenRequest = ChatSidebarOpenOptions & {
  id: number;
};

interface ChatPanelTabProps {
  openRequest?: ChatPanelOpenRequest | null;
  messages: MessageRecord[];
  conversationId?: string | null;
  isStreaming: boolean;
  runtimeStatusText?: string | null;
  activeToolCallId?: string | null;
  activeToolName?: string | null;
  isToolActive?: boolean;
  answerLanded?: boolean;
  pendingUserMessageId: string | null;
  queuedUserMessages?: QueuedUserMessage[];

  removeQueuedUserMessage?: (messageId: string) => void;
  hasOlderMessages: boolean;
  hasNewerMessages: boolean;
  isLoadingOlder: boolean;
  isLoadingNewer: boolean;
  isInitialLoading: boolean;
  onLoadOlder: () => boolean | void | Promise<boolean>;
  onLoadNewer: () => boolean | void | Promise<boolean>;
  onLoadLatest: () => boolean | void | Promise<boolean>;
  onSend: (
    text: string,
    chatContext?: ChatContext | null,
    selectedText?: string | null,
  ) => boolean | Promise<boolean>;
  onStop?: () => void;

  wideLayout?: boolean;

  isolated?: boolean;
}

export function ChatPanelTab({
  openRequest,
  wideLayout = false,
  messages,
  conversationId,
  isStreaming,
  runtimeStatusText,
  activeToolCallId,
  activeToolName,
  isToolActive,
  answerLanded,
  pendingUserMessageId,
  queuedUserMessages,
  removeQueuedUserMessage,
  hasOlderMessages,
  hasNewerMessages,
  isLoadingOlder,
  isLoadingNewer,
  isInitialLoading,
  onLoadOlder,
  onLoadNewer,
  onLoadLatest,
  onSend,
  onStop,
  isolated = false,
}: ChatPanelTabProps) {
  const t = useT();

  const {
    message: inputText,
    setMessage: setInputText,
    messageRef: inputTextRef,
  } = useComposerMessageState();
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const { showStop, requestStop } = useOptimisticStop(isStreaming, onStop);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const restoredConversationScrollRef = useRef<string | null>(null);

  const [surfaceActive, setSurfaceActive] = useState(
    () =>
      typeof document === "undefined" ||
      (!document.hidden && document.hasFocus()),
  );
  useEffect(() => {
    const sync = () =>
      setSurfaceActive(!document.hidden && document.hasFocus());
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
    };
  }, []);
  const mainChatRuntime = useContext(ChatRuntimeContext);

  const chatRuntime = isolated ? null : mainChatRuntime;
  const agentModelConfigByThread = useAgentModelConfigs(
    chatRuntime?.conversation.tasks ?? [],
  );
  const showActivityPill = Boolean(chatRuntime);

  const sidebarScroll = useChatScrollManagement({
    hasOlderEvents: hasOlderMessages,
    isLoadingOlder,
    onLoadOlder,
    hasNewerEvents: hasNewerMessages,
    isLoadingNewer,
    onLoadNewer,
    onLoadLatest,
    paginationKey: conversationId,
    surface: "compact",
  });
  const { scrollToBottom: scrollSidebarToBottom } = sidebarScroll;

  useEffect(() => {
    if (
      !conversationId ||
      isInitialLoading ||
      messages.length === 0 ||
      restoredConversationScrollRef.current === conversationId
    ) {
      return;
    }
    const restoredConversationId = conversationId;
    const frame = window.requestAnimationFrame(() => {
      scrollSidebarToBottom("instant");
      restoredConversationScrollRef.current = restoredConversationId;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    conversationId,
    isInitialLoading,
    messages.length,
    scrollSidebarToBottom,
  ]);

  const assistantReplyPeek = useAssistantReplyPeek({
    messages,
    isFollowingLatest: sidebarScroll.isFollowingLatest,
    isNearBottom: sidebarScroll.isNearBottom,
  });

  const sidebarScrollApi = useMemo<ChatColumnScroll>(
    () => ({
      listRef: sidebarScroll.listRef,
      showScrollButton: sidebarScroll.showScrollButton,
      isAtBottom: sidebarScroll.isAtBottom,
      isNearBottom: sidebarScroll.isNearBottom,
      isFollowingLatest: sidebarScroll.isFollowingLatest,
      isUserScrolling: sidebarScroll.isUserScrolling,
      noteManualScroll: sidebarScroll.noteManualScroll,
      getIsFollowing: sidebarScroll.getIsFollowing,
      scrollToBottom: sidebarScroll.scrollToBottom,
      thumbRef: sidebarScroll.thumbRef,
    }),
    [
      sidebarScroll.listRef,
      sidebarScroll.showScrollButton,
      sidebarScroll.isAtBottom,
      sidebarScroll.isNearBottom,
      sidebarScroll.isFollowingLatest,
      sidebarScroll.isUserScrolling,
      sidebarScroll.noteManualScroll,
      sidebarScroll.getIsFollowing,
      sidebarScroll.scrollToBottom,
      sidebarScroll.thumbRef,
    ],
  );

  useReadAloud(messages);
  const indicatorProps = buildInlineWorkingIndicatorProps({
    isStreaming: Boolean(isStreaming),
    isToolActive: Boolean(isToolActive),
    answerLanded: Boolean(answerLanded),
    activeToolName,
    activeToolCallId,
    runtimeStatusText,
  });

  const { chatContext, setChatContext, selectedText, setSelectedText } =
    useCapturedChatContext();
  const contextSuggestions = useComposerContextSuggestions(
    surfaceActive,
    chatContext,
    setChatContext,
  );
  const {
    screenshot: previewScreenshot,
    previewIndex: previewScreenshotIndex,
    setPreviewIndex: setPreviewScreenshotIndex,
  } = useScreenshotPreview(chatContext);

  const formRef = useRef<HTMLFormElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const shellContentRef = useRef<HTMLDivElement | null>(null);

  const { isDragOver, dropHandlers } = useFileDrop({
    setChatContext,
  });

  const submitFromDictationRef = useRef<() => void>(() => {});

  const handleCancelQueued = useCallback(
    (message: QueuedUserMessage) => {
      removeQueuedUserMessage?.(message.id);
      setInputText((current) =>
        restoreQueuedTextToComposer(current, message.text),
      );
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [removeQueuedUserMessage, setInputText],
  );

  const dictation = useDictation({
    message: inputText,
    setMessage: setInputText,

    onTranscriptCommitted: () => {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    },
    onCommit: () => {
      submitFromDictationRef.current();
    },
  });

  useEffect(() => {
    if (!openRequest) return;
    if (openRequest.chatContext !== undefined) {
      setChatContext(openRequest.chatContext);
    }
    if (typeof openRequest.prefillText === "string") {
      setInputText(openRequest.prefillText);
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [openRequest, setChatContext, setInputText]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;

      if (event.defaultPrevented) return;
      if (
        event.target !== inputRef.current &&
        document.activeElement !== inputRef.current
      ) {
        return;
      }
      setInputText("");
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [setInputText]);

  useAnimatedComposerShell({
    active: true,
    shellRef,
    contentRef: shellContentRef,
    formRef,
    syncOnNextFrame: true,
  });

  const sendCurrentMessage = useCallback(async () => {
    const { canSubmit, trimmedMessage } = deriveComposerState({
      message: inputTextRef.current,
      chatContext,
      selectedText,
    });
    if (!canSubmit) return;

    const shouldNudgeAfterSend = sidebarScroll.getShouldPlaceLatestTurn();
    const accepted = await onSend(trimmedMessage, chatContext, selectedText);
    if (!accepted) return;
    setInputText("");
    setChatContext(null);
    setSelectedText(null);
    setSidebarExpanded(false);
    if (isStreaming) {

      if (shouldNudgeAfterSend) {
        sidebarScroll.nudgeQueuedMessagesIntoView();
      }
    } else if (shouldNudgeAfterSend) {

      sidebarScroll.nudgeAfterSend();
    } else {
      sidebarScroll.releaseFollow();
    }
  }, [
    chatContext,
    inputTextRef,
    isStreaming,
    onSend,
    selectedText,
    setChatContext,
    setInputText,
    setSelectedText,
    sidebarScroll,
  ]);

  const submitFromDictation = useCallback(() => {
    sendCurrentMessage();
  }, [sendCurrentMessage]);

  const submitComposer = useCallback(() => {
    if (dictation.isRecording || dictation.isTranscribing) {
      dictation.commitAndSend();
      return;
    }
    sendCurrentMessage();
  }, [dictation, sendCurrentMessage]);

  useEffect(() => {
    submitFromDictationRef.current = submitFromDictation;
  }, [submitFromDictation]);

  const composerState = deriveComposerState({
    message: inputText,
    chatContext,
    selectedText,
  });

  const dictationInFlight = dictation.isRecording || dictation.isTranscribing;
  const canSubmitWithDictation = composerState.canSubmit || dictationInFlight;
  const hasText = inputText.trim().length > 0;
  const dictationBelow = dictation.isRecordingVisible && hasText;
  const dictationInline = dictation.isRecordingVisible && !hasText;
  const formExpanded = sidebarExpanded || dictationBelow;

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      updateComposerTextareaExpansion(inputRef.current, setSidebarExpanded);
    });
    return () => cancelAnimationFrame(raf);
  }, [inputText]);

  return (
    <div
      className={`chat-panel-tab chat-panel-tab--sidebar${wideLayout ? " chat-panel-tab--wide" : ""}`}
      {...dropHandlers}
    >
      <div
        className={
          wideLayout
            ? "full-body-row chat-panel-tab__row"
            : "chat-panel-tab__body"
        }
      >
        <div className="chat-sidebar-inner">
          <div className="chat-sidebar-main">
            <CompactConversationSurface
              className="chat-sidebar-messages"
              variant="sidebar"
              scroll={sidebarScrollApi}
              messages={messages}
              conversationId={conversationId}
              agentModelConfigByThread={agentModelConfigByThread}
              isStreaming={isStreaming}
              runtimeStatusText={runtimeStatusText}
              pendingUserMessageId={pendingUserMessageId}
              queuedUserMessages={queuedUserMessages}
              onCancelQueued={
                removeQueuedUserMessage ? handleCancelQueued : undefined
              }
              indicator={indicatorProps}
              hasOlderMessages={hasOlderMessages}
              isLoadingOlder={isLoadingOlder}
              isLoadingHistory={isInitialLoading}
              contentContainerStyle={
                wideLayout ? WIDE_PANEL_CONTENT_STYLE : SIDEBAR_CONTENT_STYLE
              }
              estimatedItemSize={wideLayout ? 140 : undefined}
            />

            <div className="chat-sidebar-composer">
              <ConnectorConnectCard compact conversationId={conversationId} />
              <ComposerLeadRow
                replyPeek={
                  assistantReplyPeek.visible
                    ? {
                        text: assistantReplyPeek.previewText,
                        onJumpToBottom: () =>
                          sidebarScroll.scrollToBottom("smooth"),
                        onDismiss: assistantReplyPeek.dismiss,
                      }
                    : null
                }
                showActivityPill={showActivityPill}
              />

              <div
                ref={shellRef}
                className={`chat-sidebar-shell${isDragOver ? " chat-sidebar-shell--drag-over" : ""}`}
              >
                <div
                  ref={shellContentRef}
                  className="chat-sidebar-shell-content"
                >
                  {hasAttachedComposerChips(chatContext, selectedText) && (
                    <div className="composer-attached-strip composer-attached-strip--compact">
                      <ComposerContextRow
                        variant="compact"
                        chatContext={chatContext}
                        selectedText={selectedText}
                        setChatContext={setChatContext}
                        setSelectedText={setSelectedText}
                        onPreviewScreenshot={setPreviewScreenshotIndex}
                      />
                    </div>
                  )}
                  <form
                    ref={formRef}
                    data-composer-context-menu="native"
                    className={`chat-sidebar-form${formExpanded ? " expanded" : ""}`}
                    onSubmit={(event) => {
                      event.preventDefault();
                      submitComposer();
                    }}
                  >
                    <ComposerAddMenu
                      className="composer-add-button"
                      title={t("shell.chatSidebar.add")}
                      setChatContext={setChatContext}
                      contextSuggestions={contextSuggestions.suggestions}
                      onSelectContextSuggestion={
                        contextSuggestions.selectSuggestion
                      }
                    />

                    {dictationInline ? (
                      <DictationRecordingBar
                        levels={dictation.levels}
                        elapsedMs={dictation.elapsedMs}
                        onCancel={dictation.cancel}
                        onConfirm={dictation.toggle}
                        onSend={dictation.commitAndSend}
                        showControls={dictation.showControls}
                      />
                    ) : (
                      <>
                        <ComposerTextarea
                          ref={inputRef}
                          className="chat-sidebar-input"
                          tone="default"
                          value={inputText}
                          rows={1}
                          onChange={(event) => {
                            setInputText(event.target.value);
                            requestAnimationFrame(() => {
                              updateComposerTextareaExpansion(
                                inputRef.current,
                                setSidebarExpanded,
                              );
                            });
                          }}
                          onKeyDown={(event) => {
                            if (
                              event.nativeEvent.isComposing ||
                              event.nativeEvent.keyCode === 229
                            ) {
                              return;
                            }
                            if (event.key === "Enter" && !event.shiftKey) {
                              event.preventDefault();
                              submitComposer();
                            }
                          }}
                          onPaste={(event) => {
                            handleComposerPaste(event, setChatContext);
                          }}
                          placeholder={composerState.placeholder}
                        />

                        <div className="composer-toolbar">
                          <div className="composer-toolbar-left">
                            <ComposerAddMenu
                              className="composer-add-button composer-add-button--toolbar"
                              title={t("shell.chatSidebar.add")}
                              setChatContext={setChatContext}
                              contextSuggestions={
                                contextSuggestions.suggestions
                              }
                              onSelectContextSuggestion={
                                contextSuggestions.selectSuggestion
                              }
                            />
                          </div>

                          <div className="composer-toolbar-right">
                            <ComposerMicButton
                              className="composer-mic"
                              isTranscribing={dictation.isTranscribing}
                              disabled={dictation.isTranscribing}
                              onClick={dictation.toggle}
                              title={
                                dictation.error
                                  ? t("shell.chatSidebar.dictationError", {
                                      error: dictation.error,
                                    })
                                  : undefined
                              }
                            />
                            {showStop && (
                              <ComposerStopButton
                                className="composer-stop"
                                onClick={requestStop}
                                title={t("shell.chatSidebar.stop")}
                                aria-label={t("shell.chatSidebar.stop")}
                              />
                            )}
                            <ComposerSubmitButton
                              className="composer-submit"
                              disabled={!canSubmitWithDictation}
                              animated
                            />
                          </div>
                        </div>

                        {dictationBelow && (
                          <div className="composer-dictation-row">
                            <DictationRecordingBar
                              levels={dictation.levels}
                              elapsedMs={dictation.elapsedMs}
                              onCancel={dictation.cancel}
                              onConfirm={dictation.toggle}
                              onSend={dictation.commitAndSend}
                              showControls={dictation.showControls}
                            />
                          </div>
                        )}
                      </>
                    )}
                  </form>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {previewScreenshot && previewScreenshotIndex !== null && (
        <ScreenshotPreviewOverlay
          screenshot={previewScreenshot}
          index={previewScreenshotIndex}
          onClose={() => setPreviewScreenshotIndex(null)}
        />
      )}
    </div>
  );
}
