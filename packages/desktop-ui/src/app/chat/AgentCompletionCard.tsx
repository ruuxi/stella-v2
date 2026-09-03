/**
 * Inline "agent completed" treatment for a spawn-anchored background card.
 *
 * When the matching lifecycle occurrence completes, the original
 * `BackgroundWorkCard` slot switches to this settled presentation. It never
 * creates a second completion-time row.
 *
 * Design — deliberately minimal, matching the running row:
 *   - No card chrome, no provider icons, no completion excerpt. The task
 *     DESCRIPTION alone on one quiet line: a grey (uncolored) checkmark in
 *     the leading slot, a trailing chevron opening the agent's thread.
 *   - Produced files return as a strip of PILL-shaped chips directly under
 *     the row — no card surface around them. Same behavior as the old card:
 *     at most `PILL_CAP` pills, then an animated "+N more" expand/collapse;
 *     the pill body uses the authority-aware file opener (signed Drive URL
 *     for cloud files, display payload for local files); local files retain
 *     the shared `OpenWithMenu` affordance.
 *   - Several agents completing at the same point stack as sibling
 *     row+pills groups, never merged into one flat line.
 */
import { useCallback, useLayoutEffect, useState } from "react";
import { notifyChatContentGrowth } from "@/shell/chat-scroll-follow";
import { Check, ChevronDown, ChevronRight } from "@/ui/icons";
import { DisplayTabIcon } from "@/features/workspace-display/icons";
import type { AgentModelConfigsByThread } from "@/features/chat/hooks/use-agent-model-configs";
import { openDisplayPayloadTab } from "@/features/workspace-display/open-payload";
import { openConversationFocus } from "@/features/chat/services/conversation-focus-store";
import { displayTabKindForPayload } from "@/features/workspace-display/payload-kind";
import {
  basenameOf,
  localFilePathForPayload,
} from "@/features/workspace-display/path-to-viewer";
import type { ConversationFileEntry } from "@/features/workspace-display/derive-conversation-files";
import type { AgentCompletionSection } from "@/features/chat/lib/agent-completion";
import { OpenWithMenu } from "./OpenWithMenu";
import { useT, useTPlural } from "@/shared/i18n";
import { useOpenConversationFile } from "@/features/cloud/use-cloud-drive-open";
import "./agent-activity-row.css";

/** Pills shown before the "+N more" control kicks in. */
const PILL_CAP = 5;

const FilePillView = ({
  entry,
  onOpen,
  localFilePath,
}: {
  entry: ConversationFileEntry;
  onOpen: () => void;
  localFilePath?: string | null;
}) => {
  return (
    <span
      className="agent-activity-files__pill"
      title={entry.path}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="agent-activity-files__pill-open"
        onClick={onOpen}
      >
        <span className="agent-activity-files__pill-icon" aria-hidden="true">
          <DisplayTabIcon
            kind={displayTabKindForPayload(entry.payload)}
            size={14}
          />
        </span>
        <span className="agent-activity-files__pill-name">
          {basenameOf(entry.path)}
        </span>
      </button>
      {localFilePath ? (
        <OpenWithMenu filePath={localFilePath} variant="plus" />
      ) : null}
    </span>
  );
};

const CloudFilePill = ({ entry }: { entry: ConversationFileEntry }) => {
  const openFile = useOpenConversationFile();
  return <FilePillView entry={entry} onOpen={() => void openFile(entry)} />;
};

const FilePill = ({ entry }: { entry: ConversationFileEntry }) =>
  entry.cloudDriveFile ? (
    <CloudFilePill entry={entry} />
  ) : (
    <FilePillView
      entry={entry}
      onOpen={() => openDisplayPayloadTab(entry.payload)}
      localFilePath={localFilePathForPayload(entry.payload)}
    />
  );

/** The chip strip under a completed row — old card's cap + "+N more"
 *  expand/collapse (grid-rows 0fr -> 1fr, no JS measurement), minus the
 *  card chrome. */
const FilePills = ({ files }: { files: ConversationFileEntry[] }) => {
  const t = useT();
  const tPlural = useTPlural();
  const [expanded, setExpanded] = useState(false);
  const total = files.length;
  const capped = total > PILL_CAP;
  const head = capped ? files.slice(0, PILL_CAP) : files;
  const rest = capped ? files.slice(PILL_CAP) : [];
  const hiddenCount = rest.length;
  if (total === 0) return null;

  return (
    <div className="agent-activity-files">
      <div className="agent-activity-files__pills">
        {head.map((entry) => (
          <FilePill key={entry.path} entry={entry} />
        ))}
      </div>
      {capped ? (
        // `inert` while collapsed keeps the hidden pills out of the tab
        // order and away from screen readers.
        <div
          className="agent-activity-files__overflow"
          data-expanded={expanded ? "true" : undefined}
          inert={expanded ? undefined : true}
        >
          <div className="agent-activity-files__overflow-clip">
            <div className="agent-activity-files__pills agent-activity-files__pills--overflow">
              {rest.map((entry) => (
                <FilePill key={entry.path} entry={entry} />
              ))}
            </div>
          </div>
        </div>
      ) : null}
      {capped ? (
        <button
          type="button"
          className="agent-activity-files__more"
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((value) => !value);
          }}
          aria-expanded={expanded}
        >
          <ChevronDown
            size={13}
            strokeWidth={2}
            aria-hidden
            className="agent-activity-files__more-chevron"
            data-expanded={expanded ? "true" : undefined}
          />
          <span>
            {expanded
              ? t("app.chat.agentCompletion.showLess")
              : tPlural("app.chat.agentCompletion.showMore", hiddenCount)}
          </span>
        </button>
      ) : null}
    </div>
  );
};

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
      openConversationFocus({
        conversationId,
        root: { kind: "agent", threadId: section.agentId },
        title: section.title,
      }),
    [conversationId],
  );

  // Every completion renders — a fileless agent still finished its task, so
  // the row must not depend on produced files (files only enrich it).
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
          className="agent-activity-group__item"
        >
          <div
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
          <FilePills files={section.files} />
        </div>
      ))}
    </div>
  );
}
