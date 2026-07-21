/**
 * Inline "background work" card — the live presentation of a stable,
 * spawn-anchored task occurrence.
 *
 * Marks, in the chat flow itself, the spot where Stella kicked something
 * off in the background. The card records "this task was triggered here" at
 * spawn time and stays put as a historical anchor. Progress/failure update
 * this same surface; a fully completed occurrence switches to the settled
 * `AgentCompletionCard` presentation in the same row. Several pieces of work
 * started in the same turn collapse into this one card (it just tallies
 * them as a count) rather than stacking a card per thread.
 *
 * Two variants share the same surface:
 *   - spawn ("started X" — `spawn_agent` or `spawn_manager` kicked off new
 *     background work)
 *   - follow-up ("update sent to X" — `send_input` advanced an already-
 *     spawned thread). A follow-up reuses the thread's original description,
 *     so the runtime carries the follow-up's own message on `statusText`;
 *     the card surfaces THAT (not the stale spawn description) and reads as a
 *     distinct update breadcrumb. See `getBackgroundWork`.
 *
 * Presence/identity and the captured descriptions come from the spawning
 * turn's tool events (`useEventRows`). The running/settled tell is derived
 * from the durable thread Activity projection, with the occurrence lifecycle
 * as its loading fallback; elapsed time is never evidence of completion.
 */
import { useLayoutEffect, useMemo } from "react";
import { notifyChatContentGrowth } from "@/shell/chat-scroll-follow";
import { Eye } from "@/ui/icons";
import { TextShimmer } from "@/app/chat/TextShimmer";
import { useThreadActivity } from "@/features/chat/hooks/use-thread-activity";
import { selectLatestThreadAssistantSummary } from "@/features/chat/lib/agent-assistant-summary";
import {
  agentPresentationFallback,
  deriveAgentCardPresentationStatus,
  deriveThreadAndOwnedPresentationStatus,
} from "@/features/chat/lib/agent-activity-presentation";
import { AgentLifecycleStatusIcon } from "@/features/chat/components/AgentLifecycleStatusIcon";
import { openThreadChatDisplayTab } from "@/shell/display/default-tabs";
import "./background-work-card.css";

/** Sweep duration for the title shimmer — a touch quicker than the base
 *  TextShimmer so the in-progress state reads as lively. */
const TITLE_SHIMMER_MS = 1900;

/** Per-thread descriptions in spawn order, from the reload-safe
 *  descriptions captured on the spawning row at spawn time. */
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
  label,
  conversationId,
}: {
  threadIds: string[];
  /** Reload-safe subset whose `agent-completed` event has landed — used to
   *  decide whether the title still shimmers. */
  completedThreadIds?: string[];
  /** Subset paused since this card's spawn (latest `agent-canceled` wins) —
   *  the shimmer stops and the subtitle reads "Paused" until a resume's
   *  fresh `agent-started` supersedes this card. */
  pausedThreadIds?: string[];
  /** Run-scoped failures. These settle the existing card in place. */
  failedThreadIds?: string[];
  /** Subset a later turn's card now owns; frozen as settled here. */
  supersededThreadIds?: string[];
  /** Per-thread spawn/last-advanced time (ms) for the stale-spawn fallback. */
  spawnedAtMs?: Record<string, number>;
  descriptions?: Record<string, string>;
  /** Per-thread follow-up text for `send_input` re-activations. */
  statusTexts?: Record<string, string>;
  /** Threads on this card that are `send_input` follow-ups, not fresh spawns. */
  followUpThreadIds?: string[];
  cardId: string;
  startEventIdsByThread: Record<string, string>;
  attemptGenerationsByThread?: Record<string, number>;
  rootRunIdsByThread?: Record<string, string>;
  terminalEventIdsByThread?: Record<string, string>;
  label?: string;
  conversationId?: string | null;
}) {
  const { records: activityRecords } = useThreadActivity(
    conversationId ?? undefined,
  );

  const presentationStatus = useMemo(() => {
    const completed = new Set(completedThreadIds ?? []);
    const paused = new Set(pausedThreadIds ?? []);
    const failed = new Set(failedThreadIds ?? []);
    const superseded = new Set(supersededThreadIds ?? []);
    const statuses = threadIds.map((threadId) => {
      const authoritative = superseded.has(threadId)
        ? undefined
        : deriveThreadAndOwnedPresentationStatus(activityRecords, threadId, {
            attemptGeneration: attemptGenerationsByThread?.[threadId],
            rootRunId: rootRunIdsByThread?.[threadId],
            startedAtMs: spawnedAtMs?.[threadId],
          });
      if (authoritative) return authoritative;
      if (failed.has(threadId)) return "error" as const;
      if (paused.has(threadId)) return "canceled" as const;
      if (completed.has(threadId)) return "completed" as const;
      if (superseded.has(threadId)) return "completed" as const;
      return "running" as const;
    });
    return deriveAgentCardPresentationStatus({
      working: statuses.includes("running"),
      failed: statuses.includes("error"),
      paused: statuses.includes("canceled"),
    });
  }, [
    activityRecords,
    attemptGenerationsByThread,
    completedThreadIds,
    failedThreadIds,
    pausedThreadIds,
    rootRunIdsByThread,
    spawnedAtMs,
    supersededThreadIds,
    threadIds,
  ]);
  const working = presentationStatus === "running";

  // The card mounting grows its row outside the streaming-text notify path
  // (a spawn lands as a tool event, not a text chunk) — tell the scroll
  // surfaces so auto-follow keeps the card in frame. See
  // `notifyChatContentGrowth`.
  useLayoutEffect(() => {
    notifyChatContentGrowth();
  }, []);

  const resolved = resolveDescriptions(threadIds, descriptions ?? {});
  const multi = threadIds.length > 1;

  // A single-thread card whose one thread was re-activated via `send_input`
  // renders as a follow-up: its own message (the spawn description is stale
  // for an update). Multi-thread cards stay a plain spawn tally — that
  // collapse is about volume, not the spawn/update distinction.
  const followUpId =
    !multi && followUpThreadIds?.includes(threadIds[0])
      ? threadIds[0]
      : undefined;
  const isFollowUp = followUpId !== undefined;

  // Several threads in one turn collapse to a plain count instead of cycling
  // through descriptions — a single task shows its own description.
  const lifecycleTitle = isFollowUp
    ? statusTexts?.[followUpId] || resolved[0] || label?.trim() || "Follow-up"
    : multi
      ? label?.trim() || resolved[0] || `${threadIds.length} tasks`
      : resolved[0] || label?.trim() || "Background work";
  const assistantSummaryExcludedThreadIds = useMemo(
    () =>
      (supersededThreadIds ?? []).filter(
        (threadId) => attemptGenerationsByThread?.[threadId] === undefined,
      ),
    [attemptGenerationsByThread, supersededThreadIds],
  );
  const latestAssistantSummary = useMemo(
    () =>
      selectLatestThreadAssistantSummary(activityRecords, {
        threadIds,
        excludedThreadIds: assistantSummaryExcludedThreadIds,
        attemptGenerationsByThread,
        rootRunIdsByThread,
        startedAtMsByThread: spawnedAtMs,
      }),
    [
      activityRecords,
      assistantSummaryExcludedThreadIds,
      attemptGenerationsByThread,
      rootRunIdsByThread,
      spawnedAtMs,
      threadIds,
    ],
  );
  if (threadIds.length === 0) return null;
  const title = lifecycleTitle;
  const failed = presentationStatus === "error";
  const showPaused = presentationStatus === "canceled";
  const subtitle =
    latestAssistantSummary?.text ??
    agentPresentationFallback(presentationStatus);
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
      className="background-work-card"
      data-state={failed ? "failed" : isFollowUp ? "follow-up" : "started"}
      data-lifecycle-status={presentationStatus}
      data-working={presentationStatus === "running" ? "true" : undefined}
      data-paused={showPaused ? "true" : undefined}
      data-activity-card-id={cardId}
      data-agent-ids={threadIds.join(",")}
      data-start-event-ids={startEventIds.join(",")}
      data-root-run-ids={rootRunIds.join(",")}
      data-terminal-event-ids={terminalEventIds.join(",")}
    >
      <span className="background-work-card__glyph" aria-hidden="true">
        <AgentLifecycleStatusIcon
          status={presentationStatus}
          size={16}
          strokeWidth={1.75}
        />
      </span>
      <span className="background-work-card__text">
        <span className="background-work-card__title">
          {working ? (
            <TextShimmer text={title} durationMs={TITLE_SHIMMER_MS} />
          ) : (
            title
          )}
        </span>
        <span className="background-work-card__subtitle">{subtitle}</span>
      </span>
      <span className="background-work-card__actions">
        {threadIds.map((threadId) => (
          <button
            key={threadId}
            type="button"
            className="background-work-card__chat"
            onClick={() =>
              openThreadChatDisplayTab({
                threadId,
                title: descriptions?.[threadId] || "Agent thread",
              })
            }
            aria-label="View activity"
            title="View activity"
          >
            <Eye size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        ))}
      </span>
    </div>
  );
}
