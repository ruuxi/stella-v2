/**
 * iMessage-style reply preview above an assistant bubble.
 *
 * For each reply reference the row carries, a small muted bubble quotes
 * what Stella is replying to — the cited message, or the task (title and
 * live status) for an agent — joined to the reply by a thin connector.
 * Clicking a preview opens focus on that target; an agent preview also
 * offers the task's full report.
 *
 * Whether a reference is worth quoting at all is decided upstream by the
 * shared reply-context rule (`@stella/contracts/reply-context`): a row only
 * reaches here with references that point outside the current exchange.
 */
import { memo, useCallback, useState } from "react";
import type { ReplyRef } from "@stella/contracts/reply-refs";
import { AgentLifecycleStatusIcon } from "@/features/chat/components/AgentLifecycleStatusIcon";
import { useT } from "@/shared/i18n";
import { openConversationFocus } from "@/features/chat/services/conversation-focus-store";
import { useThreadActivityRecords } from "@/features/chat/hooks/use-thread-activity-records";
import { TaskReportButton } from "./TaskReportButton";
import "./reply-preview.css";

const MAX_STACKED_PREVIEWS = 3;

type ReplyPreviewProps = {
  refs: readonly ReplyRef[];
  conversationId: string;
};

export const ReplyPreview = memo(function ReplyPreview({
  refs,
  conversationId,
}: ReplyPreviewProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const overflow = refs.length - MAX_STACKED_PREVIEWS;
  const visible =
    !expanded && overflow > 0 ? refs.slice(0, MAX_STACKED_PREVIEWS) : refs;
  const agentThreadIds = refs
    .filter(
      (ref): ref is Extract<ReplyRef, { kind: "agent" }> =>
        ref.kind === "agent",
    )
    .map((ref) => ref.threadId);
  const activity = useThreadActivityRecords(conversationId, agentThreadIds);
  if (refs.length === 0) return null;
  return (
    <div className="reply-preview" data-testid="reply-preview">
      {visible.map((ref) =>
        ref.kind === "message" ? (
          <MessageReplyPreview
            key={`m:${ref.id}`}
            reference={ref}
            conversationId={conversationId}
          />
        ) : (
          <AgentReplyPreview
            key={`a:${ref.threadId}`}
            reference={ref}
            conversationId={conversationId}
            status={activity.get(ref.threadId)?.status}
            liveTitle={activity.get(ref.threadId)?.description}
          />
        ),
      )}
      {!expanded && overflow > 0 ? (
        <button
          type="button"
          className="reply-preview__more"
          onClick={() => setExpanded(true)}
        >
          {t("app.chat.replyPreview.more", { count: overflow })}
        </button>
      ) : null}
      <span className="reply-preview__connector" aria-hidden="true" />
    </div>
  );
});

function MessageReplyPreview({
  reference,
  conversationId,
}: {
  reference: Extract<ReplyRef, { kind: "message" }>;
  conversationId: string;
}) {
  const t = useT();
  const open = useCallback(() => {
    openConversationFocus({
      conversationId,
      root: { kind: "message", id: reference.id },
      title: reference.preview,
    });
  }, [conversationId, reference.id, reference.preview]);
  return (
    <button
      type="button"
      className={`reply-preview__bubble reply-preview__bubble--${reference.role}`}
      onClick={open}
      title={t("app.chat.replyPreview.openMessage")}
      data-reply-ref-message-id={reference.id}
    >
      <span className="reply-preview__label">
        {reference.role === "user"
          ? t("app.chat.replyPreview.replyingToYou")
          : t("app.chat.replyPreview.replyingToStella")}
      </span>
      <span className="reply-preview__text">
        {reference.preview || t("app.chat.replyPreview.emptyMessage")}
      </span>
    </button>
  );
}

function AgentReplyPreview({
  reference,
  conversationId,
  status,
  liveTitle,
}: {
  reference: Extract<ReplyRef, { kind: "agent" }>;
  conversationId: string;
  status?: "running" | "completed" | "error" | "canceled";
  liveTitle?: string;
}) {
  const t = useT();
  const title =
    liveTitle?.trim() ||
    (reference.title !== reference.threadId ? reference.title.trim() : "") ||
    t("app.chat.focus.agentFallback");
  const open = useCallback(() => {
    openConversationFocus({
      conversationId,
      root: { kind: "agent", threadId: reference.threadId },
      title,
    });
  }, [conversationId, reference.threadId, title]);
  // The glyph alone carries the task's state; a word beside it said the
  // same thing twice. Its meaning stays available to assistive tech.
  const statusLabel =
    status === "running"
      ? t("app.chat.replyPreview.statusRunning")
      : status === "error"
        ? t("app.chat.replyPreview.statusFailed")
        : status === "canceled"
          ? t("app.chat.replyPreview.statusPaused")
          : t("app.chat.replyPreview.statusDone");
  return (
    <div
      className="reply-preview__bubble reply-preview__bubble--agent"
      data-reply-ref-thread-id={reference.threadId}
    >
      <button
        type="button"
        className="reply-preview__agent-head"
        onClick={open}
        title={t("app.chat.replyPreview.openTask")}
      >
        <span
          className="reply-preview__agent-icon"
          role="img"
          aria-label={statusLabel}
          title={statusLabel}
          data-status={status ?? "completed"}
        >
          <AgentLifecycleStatusIcon status={status ?? "completed"} />
        </span>
        <span className="reply-preview__agent-title">{title}</span>
      </button>
      <TaskReportButton
        reference={reference}
        conversationId={conversationId}
        status={status}
        liveTitle={title}
      />
    </div>
  );
}
