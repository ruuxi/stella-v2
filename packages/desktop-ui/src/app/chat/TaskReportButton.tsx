import { useCallback, useEffect, useRef, useState } from "react";
import type { ReplyRef } from "@stella/contracts/reply-refs";
import type { LocalChatAgentReport } from "@stella/contracts/local-chat";
import { Markdown } from "./Markdown";
import { X } from "@/ui/icons";
import { Popover } from "@/ui/popover";
import { useT } from "@/shared/i18n";
import { useCloudAgentReport } from "@/features/cloud/use-cloud-agent-report";
import "./reply-preview.css";

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

export function TaskReportButton({
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
  const [reportRequested, setReportRequested] = useState(false);
  const cloudReport = useCloudAgentReport(conversationId, reference.threadId, reportRequested);
  const resolvedReport = cloudReport === undefined ? undefined : cloudReport ?? report;
  const title =
    liveTitle?.trim() ||
    (reference.title !== reference.threadId ? reference.title.trim() : "") ||
    t("app.chat.focus.agentFallback");

  const prefetch = useCallback(() => {
    if (requestedRef.current) return;
    requestedRef.current = true;
    setReportRequested(true);
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

  const onReportOpenChange = useCallback(
    (open: boolean) => {
      if (open) prefetch();
      setReportOpen(open);
    },
    [prefetch],
  );
  const closeReport = useCallback(() => setReportOpen(false), []);

  const reportBody =
    resolvedReport === undefined
      ? null
      : resolvedReport === null
        ? t("app.chat.replyPreview.reportUnavailable")
        : resolvedReport.result?.trim() ||
          resolvedReport.error?.trim() ||
          t("app.chat.replyPreview.reportEmpty");

  return (
    <div
      className="task-report"
      data-reply-ref-thread-id={reference.threadId}
      onMouseEnter={prefetch}
      onFocus={prefetch}
    >
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
