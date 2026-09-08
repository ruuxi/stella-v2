/**
 * Pill-shaped file chips for a chat row.
 *
 * A file a reply links, or a task produced, is one chip: icon, filename,
 * and for a local file the shared `OpenWithMenu` affordance. The chip body
 * uses the authority-aware opener (owner-scoped drive URL for a cloud file,
 * display payload for a local file). At most `PILL_CAP` chips show, then an
 * animated "+N more" expands the rest. The strip has no card surface: it
 * sits under a bubble, or inside the task quote bubble above a reply.
 */
import { useState } from "react";
import { ChevronDown } from "@/ui/icons";
import { DisplayTabIcon } from "@/features/workspace-display/icons";
import { openDisplayPayloadTab } from "@/features/workspace-display/open-payload";
import { displayTabKindForPayload } from "@/features/workspace-display/payload-kind";
import {
  basenameOf,
  localFilePathForPayload,
} from "@/features/workspace-display/path-to-viewer";
import type { ConversationFileEntry } from "@/features/workspace-display/derive-conversation-files";
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

export const FilePill = ({ entry }: { entry: ConversationFileEntry }) =>
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
export const FilePills = ({
  files,
  variant = "row",
}: {
  files: ConversationFileEntry[];
  /** `inline`: inside a quote bubble, without the under-row indent. */
  variant?: "row" | "inline";
}) => {
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
    <div
      className={`agent-activity-files${variant === "inline" ? " agent-activity-files--inline" : ""}`}
    >
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
