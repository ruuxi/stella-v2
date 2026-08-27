import { useLayoutEffect, useMemo } from "react";
import { notifyChatContentGrowth } from "@/shell/chat-scroll-follow";
import { TextShimmer } from "@/app/chat/TextShimmer";
import { useThreadActivityRecords } from "@/features/chat/hooks/use-thread-activity-records";
import {
  deriveAgentCardPresentationStatus,
  deriveThreadAndOwnedPresentationStatus,
} from "@/features/chat/lib/agent-activity-presentation";
import { openAgentThreadTab } from "@/features/workspace-display/open-payload";
import { ArrowRight, Check, ChevronRight } from "@/ui/icons";
import { StellaStarGlyph } from "./AgentActivityGlyph";
import { useT, useTPlural } from "@/shared/i18n";
import "./agent-activity-row.css";

const TITLE_SHIMMER_MS = 1900;

function resolveDescriptions(
  threadIds: string[],
  descriptions: Record<string, string>,
): string[] {
  const out: string[] = [];
  for (const id of threadIds) {
    const captured = descriptions[id];
    if (captured) out.push(captured);
  }
  return out;
}

export function BackgroundWorkCard({
  threadIds,
  completedThreadIds,
  pausedThreadIds,
  failedThreadIds,
  supersededThreadIds,
  spawnedAtMs,
  descriptions,
  statusTexts,
  followUpThreadIds,
  cardId,
  startEventIdsByThread,
  attemptGenerationsByThread,
  rootRunIdsByThread,
  terminalEventIdsByThread,
  conversationId,
}: {
  threadIds: string[];

  completedThreadIds?: string[];

  pausedThreadIds?: string[];

  failedThreadIds?: string[];

  supersededThreadIds?: string[];

  spawnedAtMs?: Record<string, number>;
  descriptions?: Record<string, string>;

  statusTexts?: Record<string, string>;

  followUpThreadIds?: string[];
  cardId: string;
  startEventIdsByThread: Record<string, string>;
  attemptGenerationsByThread?: Record<string, number>;
  rootRunIdsByThread?: Record<string, string>;
  terminalEventIdsByThread?: Record<string, string>;
  conversationId: string;
}) {
  const t = useT();
  const tPlural = useTPlural();
  const threadActivity = useThreadActivityRecords(conversationId, threadIds);

  const presentationStatus = useMemo(() => {
    const completed = new Set(completedThreadIds ?? []);
    const paused = new Set(pausedThreadIds ?? []);
    const failed = new Set(failedThreadIds ?? []);
    const superseded = new Set(supersededThreadIds ?? []);
    const statuses = threadIds
      .filter((threadId) => !superseded.has(threadId))
      .map((threadId) => {
        const authoritative = deriveThreadAndOwnedPresentationStatus(
          threadActivity.has(threadId) ? [threadActivity.get(threadId)!] : [],
          threadId,
          {
            attemptGeneration: attemptGenerationsByThread?.[threadId],
            rootRunId: rootRunIdsByThread?.[threadId],
            startedAtMs: spawnedAtMs?.[threadId],
          },
        );
        if (authoritative) return authoritative;
        if (failed.has(threadId)) return "error" as const;
        if (paused.has(threadId)) return "canceled" as const;
        if (completed.has(threadId)) return "completed" as const;

        return "running" as const;
      });
    return deriveAgentCardPresentationStatus({
      working: statuses.includes("running"),
      failed: statuses.includes("error"),
      paused: statuses.includes("canceled"),
    });
  }, [
    attemptGenerationsByThread,
    completedThreadIds,
    failedThreadIds,
    pausedThreadIds,
    rootRunIdsByThread,
    spawnedAtMs,
    supersededThreadIds,
    threadActivity,
    threadIds,
  ]);
  const working = presentationStatus === "running";

  useLayoutEffect(() => {
    notifyChatContentGrowth();
  }, []);

  const resolved = resolveDescriptions(threadIds, descriptions ?? {});
  const multi = threadIds.length > 1;

  const followUpId =
    !multi && followUpThreadIds?.includes(threadIds[0])
      ? threadIds[0]
      : undefined;
  const isFollowUp = followUpId !== undefined;

  const title = isFollowUp
    ? statusTexts?.[followUpId] ||
      resolved[0] ||
      t("app.chat.backgroundWork.followUp")
    : multi
      ? resolved[0] ||
        tPlural("app.chat.backgroundWork.taskCount", threadIds.length)
      : resolved[0] || t("app.chat.backgroundWork.title");

  if (threadIds.length === 0) return null;
  const openThread = (threadId: string) => {
    const record = threadActivity.get(threadId);
    openAgentThreadTab({
      threadId,
      conversationId,
      agentType: record?.agentType ?? "Agent",
      title:
        descriptions?.[threadId]?.trim() ||
        t("app.chat.backgroundWork.agentThread"),
    });
  };
  const primaryThreadId = threadIds[0]!;

  const failed = presentationStatus === "error";
  const showPaused = presentationStatus === "canceled";
  const startEventIds = threadIds
    .map((id) => startEventIdsByThread[id])
    .filter(Boolean);
  const rootRunIds = [
    ...new Set(threadIds.map((id) => rootRunIdsByThread?.[id]).filter(Boolean)),
  ];
  const terminalEventIds = threadIds
    .map((id) => terminalEventIdsByThread?.[id])
    .filter(Boolean);
  return (
    <div
      className="agent-activity-row"
      role="button"
      tabIndex={0}
      aria-label={t("app.chat.backgroundWork.openNamedThread", { title })}
      onClick={(event) => {
        if ((event.target as Element).closest("button, a")) return;
        openThread(primaryThreadId);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openThread(primaryThreadId);
      }}
      data-state={failed ? "failed" : isFollowUp ? "follow-up" : "started"}
      data-lifecycle-status={presentationStatus}
      data-working={working ? "true" : undefined}
      data-paused={showPaused ? "true" : undefined}
      data-activity-card-id={cardId}
      data-agent-ids={threadIds.join(",")}
      data-start-event-ids={startEventIds.join(",")}
      data-root-run-ids={rootRunIds.join(",")}
      data-terminal-event-ids={terminalEventIds.join(",")}
    >
      {

}
      <span className="agent-activity-row__glyph" aria-hidden="true">
        {!working && isFollowUp ? (
          <ArrowRight size={13} strokeWidth={1.75} />
        ) : !working && presentationStatus === "completed" ? (
          <Check size={13} strokeWidth={1.75} />
        ) : (
          <StellaStarGlyph />
        )}
      </span>
      <span className="agent-activity-row__title">
        {working ? (
          <TextShimmer text={title} durationMs={TITLE_SHIMMER_MS} />
        ) : (
          title
        )}
      </span>
      <ChevronRight
        size={13}
        strokeWidth={1.75}
        aria-hidden
        className="agent-activity-row__chevron"
      />
    </div>
  );
}
