import { useCallback, useLayoutEffect, useState } from "react";
import { notifyChatContentGrowth } from "@/shell/chat-scroll-follow";
import { Check, ChevronDown, ChevronRight } from "@/ui/icons";
import { DisplayTabIcon } from "@/features/workspace-display/icons";
import type { AgentModelConfigsByThread } from "@/features/chat/hooks/use-agent-model-configs";
import {
  openAgentThreadTab,
  openDisplayPayloadTab,
} from "@/features/workspace-display/open-payload";
import { displayTabKindForPayload } from "@/features/workspace-display/payload-kind";
import {
  basenameOf,
  localFilePathForPayload,
} from "@/features/workspace-display/path-to-viewer";
import type { ConversationFileEntry } from "@/features/workspace-display/derive-conversation-files";
import type { AgentCompletionSection } from "@/features/chat/lib/agent-completion";
import { OpenWithMenu } from "./OpenWithMenu";
import { useT, useTPlural } from "@/shared/i18n";
import "./agent-activity-row.css";

const PILL_CAP = 5;

const FilePill = ({ entry }: { entry: ConversationFileEntry }) => {
  const localFilePath = localFilePathForPayload(entry.payload);
  return (
    <span
      className="agent-activity-files__pill"
      title={entry.path}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="agent-activity-files__pill-open"
        onClick={() => openDisplayPayloadTab(entry.payload)}
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

  modelConfigByThread?: AgentModelConfigsByThread;
}) {
  const t = useT();

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
