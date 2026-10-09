/**
 * The quiet "more" link at the end of a reply's text. It opens the full
 * report of the task the reply relays (or cites, once that task has
 * settled), the same popover the task quote used to open. Nothing renders
 * while no quoted task has a report yet.
 */
import { memo } from "react";
import type { ReplyRef } from "@stella/contracts/reply-refs";
import type { AgentCompletionSection } from "@/features/chat/lib/agent-completion";
import { useThreadActivityRecords } from "@/features/chat/hooks/use-thread-activity-records";
import { TaskReportButton } from "./TaskReportButton";

type AgentRef = Extract<ReplyRef, { kind: "agent" }>;

export const ReplyReportLinks = memo(function ReplyReportLinks({
  refs,
  completions = [],
  conversationId,
}: {
  refs: readonly ReplyRef[];
  completions?: readonly AgentCompletionSection[];
  conversationId: string;
}) {
  const completedIds = new Set(completions.map((section) => section.agentId));
  const cited = refs.filter(
    (ref): ref is AgentRef =>
      ref.kind === "agent" && !completedIds.has(ref.threadId),
  );
  const activity = useThreadActivityRecords(
    conversationId,
    [...completedIds, ...cited.map((ref) => ref.threadId)],
  );
  const reports = [
    ...completions.map((section) => ({
      reference: {
        kind: "agent",
        threadId: section.agentId,
        title: section.title,
      } as AgentRef,
      status: activity.get(section.agentId)?.status ?? "completed",
    })),
    ...cited.flatMap((reference) => {
      const status = activity.get(reference.threadId)?.status;
      return status && status !== "running" ? [{ reference, status }] : [];
    }),
  ];
  if (reports.length === 0) return null;
  return (
    <span className="reply-report-links">
      {reports.map(({ reference, status }) => (
        <TaskReportButton
          key={reference.threadId}
          reference={reference}
          conversationId={conversationId}
          status={status}
          liveTitle={activity.get(reference.threadId)?.description ?? reference.title}
          inline
        />
      ))}
    </span>
  );
});
