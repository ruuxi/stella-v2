import { TaskReportButton } from "./TaskReportButton";
/**
 * Focus (lineage) overlay — iMessage's thread view for the single chat.
 *
 * The selected chain sits above the dimmed timeline in the same chat column.
 * The composer stays available below it. Escape, the close button, or a
 * click outside the column restores the original timeline and scroll position.
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
  paddingTop: 48,
  paddingBottom: 30,
  paddingLeft: 24,
  paddingRight: 24,
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
    const trigger = document.activeElement;
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) {
        trigger.focus({ preventScroll: true });
      }
    };
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
        role="region"
        aria-label={t("app.chat.focus.ariaLabel", { title: heading })}
      >
        <header className="conversation-focus__header">
          {root.kind === "agent" && <TaskReportButton
            key={root.threadId}
            reference={{ kind: "agent", threadId: root.threadId, title: heading }}
            conversationId={conversationId}
            status={activity.get(root.threadId)?.status}
            liveTitle={heading}
          />}
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
        <div className="conversation-focus__body">
          <div className="conversation-focus__surface">
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
                estimatedItemSize={140}
                alignItemsAtEnd
                reserveTailSpace={false}
              />
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
