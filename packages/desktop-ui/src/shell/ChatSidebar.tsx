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
import { ComposerNotice } from "@/app/chat/ComposerNotice";
import { CloudBrowserInterventionCard } from "@/features/cloud/CloudBrowserInterventionCard";
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
import { useCloudConversationSession } from "@/global/auth/hooks/use-cloud-conversation-session";
import { useT } from "@/shared/i18n";
import "./chat-sidebar.css";

// Legend List sums numeric paddings into its content length; passing
// strings (`"10px"`) breaks the math. Keep these as numbers.
const SIDEBAR_CONTENT_STYLE = {
  paddingLeft: 10,
  paddingRight: 10,
  paddingTop: 8,
  paddingBottom: 4,
} as const;

/** Centered column when the display panel owns the full content area. */
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
  /** When provided, attaches/replaces the current chat context before opening. */
  chatContext?: ChatContext | null;
  /** When provided, sets the composer text (replaces existing input). */
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
  /** The run's final assistant message landed (no tool followed it). */
  answerLanded?: boolean;
  runtimeStatusText?: string | null;
  activeToolCallId?: string | null;
  activeToolName?: string | null;
  isToolActive?: boolean;
  pendingUserMessageId: string | null;
  queuedUserMessages?: QueuedUserMessage[];
  /** Removes a still-queued follow-up from the shared send queue by id. */
  removeQueuedUserMessage?: (messageId: string) => void;
  hasOlderMessages: boolean;
  hasNewerMessages: boolean;
  isLoadingOlder: boolean;
  isLoadingNewer: boolean;
  isInitialLoading: boolean;
  extraTail?: React.ReactNode;
  onLoadOlder: () => boolean | void | Promise<boolean>;
  onLoadNewer: () => boolean | void | Promise<boolean>;
  onLoadLatest: () => boolean | void | Promise<boolean>;
  onSend: (
    text: string,
    chatContext?: ChatContext | null,
    selectedText?: string | null,
  ) => boolean | Promise<boolean>;
  onStop?: () => void;
  /** When the display sidebar is expanded to full width. */
  wideLayout?: boolean;
  /**
   * Detach this surface from the shared main-chat runtime context: no activity
   * pill, no cross-thread agent-model badges. Used
   * by the ephemeral Quick chat so it stays a self-contained side conversation.
   */
  isolated?: boolean;
}

/**
 * Keep every independent composer field inside the authenticated account
 * boundary. The wrapper remains mounted while the keyed surface is replaced,
 * so an owner change cannot paint (or later replay) the previous owner's
 * draft text, captured context, or selected text.
 */
export function ChatPanelTab(props: ChatPanelTabProps) {
  const { accountScope } = useCloudConversationSession();
  const previousAccountScopeRef = useRef(accountScope);
  const ignoredOpenRequestIdRef = useRef<number | null>(null);

  if (previousAccountScopeRef.current !== accountScope) {
    previousAccountScopeRef.current = accountScope;
    ignoredOpenRequestIdRef.current = props.openRequest?.id ?? null;
  }

  const openRequest =
    props.openRequest?.id === ignoredOpenRequestIdRef.current
      ? null
      : props.openRequest;

  return (
    <AccountScopedChatPanelTab
      key={accountScope}
      {...props}
      openRequest={openRequest}
    />
  );
}

function AccountScopedChatPanelTab({
  openRequest,
  wideLayout = false,
  messages,
  conversationId,
  isStreaming,
  answerLanded,
  runtimeStatusText,
  activeToolCallId,
  activeToolName,
  isToolActive,
  pendingUserMessageId,
  queuedUserMessages,
  removeQueuedUserMessage,
  hasOlderMessages,
  hasNewerMessages,
  isLoadingOlder,
  isLoadingNewer,
  isInitialLoading,
  extraTail,
  onLoadOlder,
  onLoadNewer,
  onLoadLatest,
  onSend,
  onStop,
  isolated = false,
}: ChatPanelTabProps) {
  const t = useT();
  // Input state + always-current mirror ref, synced at WRITE time. The
  // dictate-and-submit commit is rAF-deferred and can fire before React
  // flushes the render carrying the appended transcript — a ref synced in the
  // render body would still hold the pre-transcript text at that point, so
  // `sendCurrentMessage` would see `canSubmit === false` and silently no-op,
  // leaving the transcript in the composer. See use-composer-message-state.
  const {
    message: inputText,
    setMessage: setInputText,
    messageRef: inputTextRef,
  } = useComposerMessageState();
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const { showStop, requestStop } = useOptimisticStop(isStreaming, onStop);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const restoredConversationScrollRef = useRef<string | null>(null);

  // Perf: the auto-context suggestion strip polls native window/AX
  // enumeration on an interval. Only treat the composer surface as "active"
  // (and thus pollable) while this window is focused and visible — otherwise
  // a backgrounded/hidden renderer keeps spawning the macOS
  // helper + osascript for chips nobody can see. The hook also self-gates on
  // visibility, but unmounting the poll setup here avoids even arming it.
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
  // Isolated surfaces (Quick chat) ignore the shared main-chat runtime so they
  // don't inherit its agents or activity pill.
  const chatRuntime = isolated ? null : mainChatRuntime;
  const agentModelConfigByThread = useAgentModelConfigs(
    chatRuntime?.conversation.tasks ?? [],
  );
  const showActivityPill = Boolean(chatRuntime);

  /*
   * Own scroll-management instance for the sidebar list. Mirrors the
   * full chat (`useFullShellChat` → `useChatScrollManagement`) so the
   * sidebar gets the same Legend-List-backed at-bottom tracking and
   * thumb behavior as the home full chat.
   */
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
  // The indicator hands off to the reply once the run's final assistant
  // message lands; a preamble followed by a tool keeps it up.
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

  // Drag-and-drop file attach stays live at all times, including while the
  // turn is streaming or agents are busy — dropped files attach to
  // `chatContext` just as when idle; submit/queue behavior is unchanged.
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
    // Dictation stays available even while the orchestrator is busy
    // (mid-turn / streaming) — the mic is intentionally NOT gated on
    // `isStreaming`. See `submitComposer` for the in-flight submit flow.
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
      // Only clear the composer draft when Escape targets the composer itself.
      // Otherwise Escape used to dismiss unrelated UI (dropdowns, previews,
      // dialogs) would wipe an in-progress draft.
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
    // The placement gate subtracts the synthetic response spacer before
    // applying Codex's 300px near-bottom threshold, so a visually-bottomed
    // short reply still reframes while deliberate scrollback stays put.
    const shouldNudgeAfterSend = sidebarScroll.getShouldPlaceLatestTurn();
    const accepted = await onSend(trimmedMessage, chatContext, selectedText);
    if (!accepted) return;
    setInputText("");
    setChatContext(null);
    setSelectedText(null);
    setSidebarExpanded(false);
    if (isStreaming) {
      // Queued follow-up — no new user row lands in the event
      // list, just a chip in the trailing region. Keep that footer
      // stack framed without falling through to the prior turn's
      // user bubble.
      if (shouldNudgeAfterSend) {
        sidebarScroll.nudgeQueuedMessagesIntoView();
      }
    } else if (shouldNudgeAfterSend) {
      // Place the newest user turn above the viewport-derived response
      // spacer, using the same gentle loop as stream-follow.
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

  // Submitting while a recording/transcription is still in flight must not
  // race ahead of the dictated text. `commitAndSend` stops + finalizes the
  // recording, waits for the pending transcript to be appended to the
  // composer, and only then fires `onCommit` (→ sendCurrentMessage). For the
  // idle case it sends immediately. Transcription is time-bounded (see the
  // dictation service's per-segment timeout), so a stalled request fails into
  // a recoverable error and fires the commit instead of wedging submit.
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
  // A dictation in flight makes the composer submittable on its own — the
  // pending transcript is the content. Without this the submit arrow stays
  // disabled while the text is empty, so a press during transcription is
  // swallowed and the message is never sent/queued.
  const dictationInFlight = dictation.isRecording || dictation.isTranscribing;
  const canSubmitWithDictation = composerState.canSubmit || dictationInFlight;
  const hasText = inputText.trim().length > 0;
  const dictationBelow = dictation.isRecordingVisible && hasText;
  const dictationInline = dictation.isRecordingVisible && !hasText;
  const formExpanded = sidebarExpanded || dictationBelow;

  // Keep the pill shape in sync when `inputText` changes outside of
  // onChange (e.g. cleared by send, or set by dictation).
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
              extraTail={extraTail}
            />

            <div className="chat-sidebar-composer">
              <ConnectorConnectCard compact conversationId={conversationId} />
              <CloudBrowserInterventionCard
                compact
                conversationId={conversationId}
              />
              <ComposerNotice compact conversationId={conversationId} />
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
                        transcriptPreview={dictation.transcriptPreview}
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
                              transcriptPreview={dictation.transcriptPreview}
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
