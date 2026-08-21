/**
 * Inline "agent completed" treatment for a spawn-anchored background card.
 *
 * When the matching lifecycle occurrence completes, the original
 * `BackgroundWorkCard` slot switches to this settled presentation. It never
 * creates a second completion-time row.
 *
 * Design — deliberately minimal, matching the running row:
 *   - No card chrome, no file pills, no provider icons, no completion
 *     excerpt. The task DESCRIPTION alone, on one quiet line.
 *   - A grey (uncolored) checkmark in the leading slot as the done tell,
 *     and a trailing chevron as the click-through affordance. Clicking the
 *     row opens the agent's thread, where the full result and produced
 *     files live.
 *   - Several agents completing at the same point stack as sibling rows,
 *     never merged into one flat line.
 */
import { useCallback, useLayoutEffect } from "react";
import { notifyChatContentGrowth } from "@/shell/chat-scroll-follow";
import { Check, ChevronRight } from "@/ui/icons";
import type { AgentModelConfigsByThread } from "@/features/chat/hooks/use-agent-model-configs";
import { openAgentThreadTab } from "@/features/workspace-display/open-payload";
import type { AgentCompletionSection } from "@/features/chat/lib/agent-completion";
import { useT } from "@/shared/i18n";
import "./agent-activity-row.css";

export function AgentCompletionCard({
  sections,
  cardId,
  conversationId,
}: {
  sections: AgentCompletionSection[];
  cardId?: string;
  conversationId: string;
  /** Accepted for call-site compatibility; the minimal rows no longer
   *  surface provider icons. */
  modelConfigByThread?: AgentModelConfigsByThread;
}) {
  const t = useT();
  // The completion row usually replaces the running spawn row after the run
  // has settled — no stream text notify fires, so tell the scroll surfaces
  // about the growth ourselves. See `notifyChatContentGrowth`.
  useLayoutEffect(() => {
    notifyChatContentGrowth();
  }, []);
  const openSection = useCallback(
    (section: AgentCompletionSection) =>
      openAgentThreadTab({
        threadId: section.agentId,
        conversationId,
        agentType: section.agentType ?? "Agent",
        title: section.title,
      }),
    [conversationId],
  );

  // Every completion renders — a fileless agent still finished its task, so
  // the row must not depend on produced files (files live in the thread).
  const visible = sections;
  if (visible.length === 0) return null;
  const startEventIds = visible
    .map((section) => section.startEventId)
    .filter(Boolean);
  const completionEventIds = visible
    .map((section) => section.completionEventId)
    .filter(Boolean);
  const rootRunIds = [
    ...new Set(visible.map((section) => section.rootRunId).filter(Boolean)),
  ];
  const artifactIds = visible.flatMap((section) =>
    section.files.map((entry) => entry.path),
  );

  return (
    <div
      className="agent-activity-group"
      data-activity-card-id={cardId}
      data-agent-ids={visible.map((section) => section.agentId).join(",")}
      data-start-event-ids={startEventIds.join(",")}
      data-root-run-ids={rootRunIds.join(",")}
      data-terminal-event-ids={completionEventIds.join(",")}
      data-artifact-ids={artifactIds.join(",")}
    >
      {visible.map((section) => (
        <div
          key={section.startEventId ?? section.agentId}
          className="agent-activity-row"
          role="button"
          tabIndex={0}
          aria-label={t("app.chat.agentCompletion.openNamedThread", {
            title: section.title,
          })}
          onClick={(event) => {
            if ((event.target as Element).closest("button, a")) return;
            openSection(section);
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            openSection(section);
          }}
          data-lifecycle-status="completed"
          data-agent-id={section.agentId}
        >
          <span className="agent-activity-row__glyph" aria-hidden="true">
            <Check size={13} strokeWidth={1.75} />
          </span>
          <span className="agent-activity-row__title">{section.title}</span>
          <ChevronRight
            size={13}
            strokeWidth={1.75}
            aria-hidden
            className="agent-activity-row__chevron"
          />
        </div>
      ))}
    </div>
  );
}
