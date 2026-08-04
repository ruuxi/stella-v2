/**
 * Full-list "See all" dialog opened from the chat home overview
 * (`ChatHomeOverview.tsx`). Three sections share the same dialog
 * (Completed / Up next / Recent files) with a search field at the top.
 *
 * Two performance properties matter here, both addressing the user's
 * "shouldn't load all up front" concern:
 *
 *   1. The list is virtualized with `@legendapp/list/react` so even if
 *      the derived dataset has hundreds of rows, only the visible window
 *      is mounted to the DOM.
 *
 *   2. The Completed section renders the conversation's task rows
 *      directly (bounded by thread count — no paging); the Recent files
 *      section grows the files window (`useConversationFiles` →
 *      `localChat:listFiles`) when the user reaches the end of the
 *      currently loaded list.
 *
 * Schedules are always fetched live as a small bounded list and don't
 * need pagination.
 */
import { useMemo, useState } from "react";
import { Search, X } from "@/ui/icons";
import { LegendList, } from "@legendapp/list/react";
import { Dialog } from "@/ui/dialog";
import { getTaskDisplayText, getTaskGroupStatusText, getTaskHierarchyStatusText, } from "@/features/chat/lib/event-transforms";
import { buildCompletedActivityList, } from "./activity-history-model";
import { formatNextRun } from "@/global/schedule/format-schedule";
import { DisplayTabIcon } from "@/features/workspace-display/icons";
import { basenameOf } from "@/features/workspace-display/path-to-viewer";
import { displayTabKindForPayload } from "@/features/workspace-display/payload-kind";
import { deriveConversationFiles, } from "@/features/workspace-display/derive-conversation-files";
import "./activity-history-dialog.css";
const SECTION_TITLES = {
    done: "Completed",
    upNext: "Up next",
    files: "Recent files",
};
const SECTION_PLACEHOLDERS = {
    done: "Search completed",
    upNext: "Search scheduled",
    files: "Search files",
};
const SECTION_EMPTY = {
    done: "Nothing completed yet.",
    upNext: "Nothing scheduled.",
    files: "No files yet.",
};
const taskBadge = (task) => {
    switch (task.status) {
        case "completed":
            return "Done";
        case "error":
            return "Failed";
        case "canceled":
            return "Stopped";
        default:
            return "";
    }
};
const taskLabel = (task) => (getTaskDisplayText(task) || task.description || "").trim();
export function ActivityHistoryDialog({ open, onOpenChange, section, tasks, fileEvents, onLoadMoreFiles, hasMoreFiles, isLoadingMoreFiles, schedules, nowMs, onSelectTask, onOpenSchedule, onOpenFile, }) {
    const queryScope = open ? section : null;
    const [queryState, setQueryState] = useState({ scope: queryScope, value: "" });
    const query = queryState.scope === queryScope ? queryState.value : "";
    const setQuery = (value) => setQueryState({ scope: queryScope, value });
    const needle = query.trim().toLowerCase();
    const files = useMemo(() => {
        if (section !== "files")
            return [];
        return deriveConversationFiles(fileEvents);
    }, [fileEvents, section]);
    const filteredSchedules = useMemo(() => {
        if (!needle)
            return schedules;
        return schedules.filter((entry) => entry.name.toLowerCase().includes(needle));
    }, [schedules, needle]);
    const filteredFiles = useMemo(() => {
        if (!needle)
            return files;
        return files.filter((entry) => entry.path.toLowerCase().includes(needle));
    }, [files, needle]);
    const listItems = useMemo(() => {
        if (section === "done") {
            return buildCompletedActivityList(tasks, needle);
        }
        if (section === "upNext") {
            return filteredSchedules.map((entry) => ({ kind: "upNext", entry }));
        }
        const rows = filteredFiles.map((entry) => ({
            kind: "files",
            entry,
        }));
        if (hasMoreFiles || isLoadingMoreFiles) {
            rows.push({ kind: "loading", id: "pager-loading" });
        }
        return rows;
    }, [
        filteredFiles,
        filteredSchedules,
        hasMoreFiles,
        isLoadingMoreFiles,
        needle,
        section,
        tasks,
    ]);
    const totalForSection = section === "done"
        ? tasks.filter((task) => task.status !== "running").length
        : section === "upNext"
            ? schedules.length
            : files.length;
    const empty = listItems.length === 0 ||
        (listItems.length === 1 && listItems[0].kind === "loading");
    const renderItem = ({ item }) => {
        if (item.kind === "done") {
            const { task } = item;
            const label = taskLabel(task);
            const nestedStyle = item.depth > 0
                ? { "--activity-depth": item.depth }
                : undefined;
            return (<div className={`activity-history-dialog__row${item.depth > 0 ? " activity-history-dialog__row--grouped" : ""}`} data-status={task.status} style={nestedStyle}>
          <button type="button" className="activity-history-dialog__row-button" onClick={() => onSelectTask?.(task)} aria-label={`Use ${label || "activity"} as context`}>
            <span className="activity-history-dialog__row-text">{label}</span>
            <span className="activity-history-dialog__row-meta">
              {taskBadge(task)}
            </span>
          </button>
        </div>);
        }
        if (item.kind === "doneGroup") {
            const { group } = item;
            const nestedStyle = item.depth > 0
                ? { "--activity-depth": item.depth }
                : undefined;
            return (<div className={`activity-history-dialog__row activity-history-dialog__row--group${item.depth > 0 ? " activity-history-dialog__row--grouped" : ""}`} data-status={group.status} style={nestedStyle}>
          <span className="activity-history-dialog__row-text">
            {group.label.trim()}
          </span>
          <span className="activity-history-dialog__row-meta">
            {getTaskGroupStatusText(group)}
          </span>
        </div>);
        }
        if (item.kind === "doneHierarchy") {
            const { hierarchy } = item;
            const owner = hierarchy.owner;
            const label = taskLabel(owner);
            const nestedStyle = item.depth > 0
                ? { "--activity-depth": item.depth }
                : undefined;
            return (<div className={`activity-history-dialog__row activity-history-dialog__row--hierarchy${item.depth > 0 ? " activity-history-dialog__row--grouped" : ""}`} data-status={owner.status} style={nestedStyle}>
          <button type="button" className="activity-history-dialog__row-button activity-history-dialog__row-button--hierarchy" onClick={() => onSelectTask?.(owner)} aria-label={`Use ${label || "manager activity"} as context`}>
            <span className="activity-history-dialog__row-main">
              <span className="activity-history-dialog__row-text">{label}</span>
              {owner.outputPreview?.trim() ? (<span className="activity-history-dialog__row-summary">
                  {owner.outputPreview.trim()}
                </span>) : null}
            </span>
            <span className="activity-history-dialog__row-meta">
              {getTaskHierarchyStatusText(hierarchy)} · {taskBadge(owner)}
            </span>
          </button>
        </div>);
        }
        if (item.kind === "upNext") {
            const { entry } = item;
            return (<div className="activity-history-dialog__row">
          <button type="button" className="activity-history-dialog__row-button" onClick={() => onOpenSchedule(entry)}>
            <span className="activity-history-dialog__row-text">
              {entry.name}
            </span>
            <span className="activity-history-dialog__row-meta">
              {formatNextRun(entry.nextRunAtMs, nowMs)}
            </span>
          </button>
        </div>);
        }
        if (item.kind === "files") {
            const { entry } = item;
            return (<div className="activity-history-dialog__row">
          <button type="button" className="activity-history-dialog__row-button activity-history-dialog__row-button--file" onClick={() => onOpenFile(entry)} title={entry.path}>
            <DisplayTabIcon kind={displayTabKindForPayload(entry.payload)} size={16}/>
            <span className="activity-history-dialog__row-text">
              {basenameOf(entry.path)}
            </span>
            <span className="activity-history-dialog__row-meta activity-history-dialog__row-meta--path">
              {entry.path}
            </span>
          </button>
        </div>);
        }
        return (<div className="activity-history-dialog__loading" role="status" aria-live="polite">
        Loading earlier history…
      </div>);
    };
    return (<Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content size="md" fit className="activity-history-dialog">
        <Dialog.Header>
          <Dialog.Title>{SECTION_TITLES[section]}</Dialog.Title>
          <Dialog.CloseButton />
        </Dialog.Header>
        <div className="activity-history-dialog__search">
          <Search size={14} aria-hidden="true"/>
          <input type="text" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={SECTION_PLACEHOLDERS[section]} spellCheck={false} autoFocus aria-label={SECTION_PLACEHOLDERS[section]}/>
          {query && (<button type="button" className="activity-history-dialog__search-clear" onClick={() => setQuery("")} aria-label="Clear search">
              <X size={12}/>
            </button>)}
        </div>
        <Dialog.Body>
          {empty ? (<div className="activity-history-dialog__empty-wrap">
              <p className="activity-history-dialog__empty">
                {needle
                ? `No matches in ${totalForSection.toLocaleString()}.`
                : SECTION_EMPTY[section]}
              </p>
            </div>) : (<div className="activity-history-dialog__scroll">
              <LegendList data={listItems} keyExtractor={keyExtractor} renderItem={renderItem} estimatedItemSize={36} recycleItems onEndReached={section === "files" ? onLoadMoreFiles : undefined} onEndReachedThreshold={0.6} style={{ height: "100%", width: "100%" }}/>
            </div>)}
        </Dialog.Body>
      </Dialog.Content>
    </Dialog>);
}
const keyExtractor = (item) => {
    switch (item.kind) {
        case "done":
            return `done:${item.task.id}`;
        case "doneGroup":
            return `done-group:${item.depth}:${item.group.groupKey}`;
        case "doneHierarchy":
            return `done-hierarchy:${item.hierarchy.owner.id}`;
        case "upNext":
            return `up:${item.entry.kind}:${item.entry.id}`;
        case "files":
            return `file:${item.entry.path}`;
        case "loading":
            return item.id;
    }
};
