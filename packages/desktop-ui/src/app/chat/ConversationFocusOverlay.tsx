/**
 * Focus (lineage) overlay — iMessage's thread view for the single chat.
 *
 * Opens over the timeline when a reply preview, a "N replies" affordance,
 * a Tasks row, or an inline agent card is activated. The timeline behind
 * dims; the panel lists only the rows that belong to the focused message
 * or agent thread, rendered through the same row projection as the main
 * chat (cards, tool activity, artifacts included). Escape, the close
 * button, or a click on the dimmed backdrop returns to the full timeline,
 * whose scroll position is untouched because it never unmounted.
 */
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { ConversationEvents } from "@/app/chat/ConversationEvents";
import { X } from "@/ui/icons";
import { useT } from "@/shared/i18n";
import { useChatScrollManagement } from "@/shell/use-chat-scroll-management";
import {
  closeConversationFocus,
  useConversationFocus,
} from "@/features/chat/services/conversation-focus-store";
import { useLineageMessages } from "@/features/chat/services/lineage-messages-store";
import { useThreadActivityRecords } from "@/features/chat/hooks/use-thread-activity-records";
import {
  getDisplayMessageText,
  getDisplayUserText,
} from "@/features/chat/lib/message-turn-display";
import { toReplyPreview } from "@stella/contracts/reply-refs";
import type { AgentModelConfigsByThread } from "@/features/chat/hooks/use-agent-model-configs";
import "./conversation-focus-overlay.css";

const FOCUS_CONTENT_STYLE = {
  paddingTop: 16,
  paddingBottom: 24,
  paddingLeft: 20,
  paddingRight: 20,
} as const;

type ConversationFocusOverlayProps = {
  conversationId: string | null | undefined;
  agentModelConfigByThread?: AgentModelConfigsByThread;
};

export const ConversationFocusOverlay = memo(function ConversationFocusOverlay({
  conversationId,
  agentModelConfigByThread,
}: ConversationFocusOverlayProps) {
  const focus = useConversationFocus(conversationId);
  if (!focus || !conversationId) return null;
  return (
    <FocusPanel
      key={`${focus.root.kind}:${
        focus.root.kind === "message" ? focus.root.id : focus.root.threadId
      }`}
      conversationId={conversationId}
      root={focus.root}
      title={focus.title}
      agentModelConfigByThread={agentModelConfigByThread}
    />
  );
});

function FocusPanel({
  conversationId,
  root,
  title,
  agentModelConfigByThread,
}: {
  conversationId: string;
  root: NonNullable<ReturnType<typeof useConversationFocus>>["root"];
  title?: string;
  agentModelConfigByThread?: AgentModelConfigsByThread;
}) {
  const t = useT();
  const lineage = useLineageMessages(conversationId, root);
  const agentThreadIds = useMemo(
    () => (root.kind === "agent" ? [root.threadId] : []),
    [root],
  );
  const activity = useThreadActivityRecords(conversationId, agentThreadIds);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  const scroll = useChatScrollManagement({
    hasOlderEvents: lineage.hasOlder,
    isLoadingOlder: lineage.isLoadingOlder,
    onLoadOlder: lineage.loadOlder,
    paginationKey: `${conversationId}:${root.kind}:${
      root.kind === "message" ? root.id : root.threadId
    }`,
    surface: "compact",
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      closeConversationFocus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    closeButtonRef.current?.focus({ preventScroll: true });
  }, []);

  const heading = useMemo(() => {
    if (root.kind === "agent") {
      return (
        activity.get(root.threadId)?.description?.trim() ||
        title?.trim() ||
        t("app.chat.focus.agentFallback")
      );
    }
    const rootMessage = lineage.messages.find(
      (message) => message._id === root.id,
    );
    if (rootMessage) {
      const text =
        rootMessage.type === "user_message"
          ? getDisplayUserText(rootMessage)
          : getDisplayMessageText(rootMessage);
      const preview = toReplyPreview(text);
      if (preview) return preview;
    }
    return title?.trim() || t("app.chat.focus.messageFallback");
  }, [activity, lineage.messages, root, t, title]);

  const handleBackdropClick = useCallback((event: React.MouseEvent) => {
    if (event.target === event.currentTarget) closeConversationFocus();
  }, []);

  return (
    <div
      className="conversation-focus"
      data-testid="conversation-focus"
      data-focus-kind={root.kind}
      onMouseDown={handleBackdropClick}
    >
      <section
        className="conversation-focus__panel"
        role="dialog"
        aria-modal="false"
        aria-label={t("app.chat.focus.ariaLabel", { title: heading })}
      >
        <header className="conversation-focus__header">
          <div className="conversation-focus__heading">
            <span className="conversation-focus__kicker">
              {root.kind === "agent"
                ? t("app.chat.focus.kickerAgent")
                : t("app.chat.focus.kickerMessage")}
            </span>
            <h2 className="conversation-focus__title" title={heading}>
              {heading}
            </h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="conversation-focus__close"
            onClick={closeConversationFocus}
            aria-label={t("app.chat.focus.close")}
            title={t("app.chat.focus.closeHint")}
          >
            <X size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </header>
        <div className="conversation-focus__body chat-viewport-region chat-viewport-region--sidebar has-messages">
          <div className="chat-conversation-surface chat-conversation-surface--sidebar conversation-focus__surface">
            {lineage.error ? (
              <div className="conversation-focus__error" role="alert">
                {t("app.chat.focus.error")}
              </div>
            ) : (
              <ConversationEvents
                messages={lineage.messages}
                conversationId={conversationId}
                agentModelConfigByThread={agentModelConfigByThread}
                hasOlderMessages={lineage.hasOlder}
                isLoadingOlder={lineage.isLoadingOlder}
                isLoadingHistory={!lineage.hasLoaded}
                listRef={scroll.listRef}
                className="conversation-focus__list"
                contentContainerStyle={FOCUS_CONTENT_STYLE}
                estimatedItemSize={120}
              />
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
