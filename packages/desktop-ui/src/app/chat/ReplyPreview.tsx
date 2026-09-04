/**
 * iMessage-style reply preview above an assistant bubble.
 *
 * For each reply reference the row carries, a small muted bubble quotes
 * what Stella is replying to — the cited message, or the task (title and
 * live status) for an agent — joined to the reply by a thin connector.
 * Clicking a preview opens focus on that target. An agent preview also
 * carries a "Report" button that opens the agent's full result, rendered as
 * Markdown, in a floating panel anchored to the bubble (a portal, so the
 * timeline never reflows); clicking outside, Escape, or the close button
 * dismisses it. The report is fetched on hover intent so the click feels
 * immediate, and cached per thread for the life of the window.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ReplyRef } from "@stella/contracts/reply-refs";
import type { LocalChatAgentReport } from "@stella/contracts/local-chat";
import { Markdown } from "@/app/chat/Markdown";
import { AgentLifecycleStatusIcon } from "@/features/chat/components/AgentLifecycleStatusIcon";
import { X } from "@/ui/icons";
import { Popover } from "@/ui/popover";
import { useT } from "@/shared/i18n";
import { openConversationFocus } from "@/features/chat/services/conversation-focus-store";
import { useThreadActivityRecords } from "@/features/chat/hooks/use-thread-activity-records";
import "./reply-preview.css";

const MAX_STACKED_PREVIEWS = 3;

const reportCache = new Map<string, Promise<LocalChatAgentReport | null>>();

const fetchAgentReport = (
  threadId: string,
): Promise<LocalChatAgentReport | null> => {
  const cached = reportCache.get(threadId);
  if (cached) return cached;
  const api =
    typeof window === "undefined" ? undefined : window.electronAPI?.localChat;
  const request = api?.getAgentReport
    ? api.getAgentReport({ threadId }).catch(() => null)
    : Promise.resolve(null);
  reportCache.set(threadId, request);
  // A running task's report changes; only a settled one is worth keeping.
  void request.then((report) => {
    if (!report || report.status === "running") reportCache.delete(threadId);
  });
  return request;
};

export const __testing = {
  clearReportCache(): void {
    reportCache.clear();
  },
};

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
  const [reportOpen, setReportOpen] = useState(false);
  const [report, setReport] = useState<LocalChatAgentReport | null | undefined>(
    undefined,
  );
  const requestedRef = useRef(false);
  const title =
    liveTitle?.trim() ||
    (reference.title !== reference.threadId ? reference.title.trim() : "") ||
    t("app.chat.focus.agentFallback");

  const prefetch = useCallback(() => {
    if (requestedRef.current) return;
    requestedRef.current = true;
    void fetchAgentReport(reference.threadId).then((next) => {
      setReport(next);
    });
  }, [reference.threadId]);

  // A running task finishing while the preview is open swaps in the report.
  useEffect(() => {
    if (
      status === "completed" &&
      requestedRef.current &&
      report?.status === "running"
    ) {
      requestedRef.current = false;
      reportCache.delete(reference.threadId);
      prefetch();
    }
  }, [prefetch, reference.threadId, report?.status, status]);

  const open = useCallback(() => {
    openConversationFocus({
      conversationId,
      root: { kind: "agent", threadId: reference.threadId },
      title,
    });
  }, [conversationId, reference.threadId, title]);

  const onReportOpenChange = useCallback(
    (open: boolean) => {
      if (open) prefetch();
      setReportOpen(open);
    },
    [prefetch],
  );
  const closeReport = useCallback(() => setReportOpen(false), []);

  const statusLabel =
    status === "running"
      ? t("app.chat.replyPreview.statusRunning")
      : status === "error"
        ? t("app.chat.replyPreview.statusFailed")
        : status === "canceled"
          ? t("app.chat.replyPreview.statusPaused")
          : t("app.chat.replyPreview.statusDone");
  const reportBody =
    report === undefined
      ? null
      : report === null
        ? t("app.chat.replyPreview.reportUnavailable")
        : report.result?.trim() ||
          report.error?.trim() ||
          t("app.chat.replyPreview.reportEmpty");

  return (
    <div
      className="reply-preview__bubble reply-preview__bubble--agent"
      data-reply-ref-thread-id={reference.threadId}
      onMouseEnter={prefetch}
      onFocus={prefetch}
    >
      <button
        type="button"
        className="reply-preview__agent-head"
        onClick={open}
        title={t("app.chat.replyPreview.openTask")}
      >
        <span className="reply-preview__agent-icon" aria-hidden="true">
          <AgentLifecycleStatusIcon status={status ?? "completed"} />
        </span>
        <span className="reply-preview__agent-title">{title}</span>
        <span className="reply-preview__agent-status">{statusLabel}</span>
      </button>
      <Popover open={reportOpen} onOpenChange={onReportOpenChange}>
        <Popover.Trigger asChild>
          <button type="button" className="reply-preview__report-toggle">
            {t("app.chat.replyPreview.showReport")}
          </button>
        </Popover.Trigger>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={16}
          className="reply-preview-report-popover"
        >
          <div
            className="reply-preview-report"
            data-testid="reply-preview-report"
          >
            <div className="reply-preview-report__head">
              <span className="reply-preview-report__title">{title}</span>
              <button
                type="button"
                className="reply-preview-report__close"
                onClick={closeReport}
                aria-label={t("app.chat.replyPreview.closeReport")}
                title={t("app.chat.replyPreview.closeReport")}
              >
                <X size={14} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
            <div className="reply-preview-report__body">
              {reportBody === null ? (
                <span className="reply-preview__report-loading">
                  {t("app.chat.replyPreview.reportLoading")}
                </span>
              ) : (
                <Markdown
                  text={reportBody}
                  cacheKey={`reply-preview-report:${reference.threadId}`}
                />
              )}
            </div>
          </div>
        </Popover.Content>
      </Popover>
    </div>
  );
}
