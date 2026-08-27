import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, } from "react";
import { DropOverlay } from "@/app/chat/DropOverlay";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { useUiState } from "@/context/ui-state";
import { AgentLifecycleStatusIcon } from "@/features/chat/components/AgentLifecycleStatusIcon";
import { CompactChildState } from "@/features/chat/components/CompactSubagentSummary";
import { flattenActivityTasks, getActivityRowSearchText, groupActivityTasks, summarizeCompactActivity, } from "@/features/chat/lib/event-transforms";
import { displaySearchStore, useDisplaySearchFocusRequest, useDisplaySearchOpen, useDisplaySearchQuery, } from "@/features/workspace-display/display-search-store";
import { DisplayTabIcon } from "@/features/workspace-display/icons";
import { forgetArtifactFileEntry, useFileEntries, } from "@/features/workspace-display/files-index";
import { dataTransferHasSupportedMedia, importLocalMedia, isSupportedMediaFile, } from "@/features/workspace-display/media-files";
import { openAgentThreadTab, openDisplayPayloadTab, } from "@/features/workspace-display/open-payload";
import { useActiveSidebarSection, } from "@/features/workspace-display/sidebar-sections";
import { useDisplayPanelOpen, useDisplayTabList, } from "@/features/workspace-display/tab-store";
import { notifyMediaGenerationError } from "@/global/billing/paid-media-tier-toast";
import { loadCanvasHtmlHistory, removeCanvasHtmlItem, } from "@/shell/display/canvas-tab/canvas-items";
import { removeGeneratedMediaItem } from "@/shell/display/payload-to-tab-spec";
import { bucketByRecency } from "@/shared/lib/recency-buckets";
import { ChevronRight, Eye, LayoutList, Search, X } from "@/ui/icons";
import { DeferredDisplayContent } from "./DeferredDisplayContent";
import "./files-section.css";

export const WORK_PAGE_SIZE = 50;
export const WORK_PAGE_END_THRESHOLD_PX = 160;
const forgetEntry = (entry) => {
    switch (entry.source) {
        case "canvas":
            if (entry.filePath)
                removeCanvasHtmlItem(entry.filePath);
            return;
        case "media":
            removeGeneratedMediaItem(entry.id);
            return;
        case "artifact":
            forgetArtifactFileEntry(entry.id);
    }
};
const workItemLabel = (item) => item.kind === "agent" ? item.task.description : item.entry.title;
const taskTimestamp = (task) => task.lastUpdatedAtMs || task.completedAtMs || task.startedAtMs;

const RECENCY_LABELS = {
    today: "Today",
    yesterday: "Yesterday",
    thisWeek: "This week",
    thisMonth: "This month",
    older: "Older",
};

function AgentThreadButton({ task, conversationId }) {
    return (<button type="button" className="files-list__open" onClick={() => conversationId
        ? openAgentThreadTab({
            threadId: task.id,
            conversationId,
            agentType: task.agentType,
            title: task.description.trim() || task.agentType || "Agent thread",
            source: task.source,
            readOnly: task.readOnly,
            parentAgentId: task.parentAgentId,
        })
        : undefined} title={task.description}>
      <span className="files-list__icon" aria-hidden="true">
        <AgentLifecycleStatusIcon status={task.status} size={17} strokeWidth={1.75}/>
      </span>
      <span className="files-list__title">{task.description}</span>
      <span className="files-list__meta">
        {task.source === "claude-native" ? "Claude · read-only" : "Agent"}
      </span>
    </button>);
}

function AgentGroupRow({ hierarchy, conversationId, expanded, onToggle }) {
    const owner = hierarchy.owner;
    const descendants = useMemo(() => flattenActivityTasks(hierarchy.children), [hierarchy.children]);
    const summary = useMemo(() => summarizeCompactActivity(descendants), [descendants]);
    const label = owner.description.trim() || owner.agentType || "Agent";
    return (<>
      <li className="files-list__item files-list__item--group" data-expanded={expanded ? "true" : undefined}>
        <button type="button" className="files-list__open files-list__group-toggle" data-compact="true" onClick={onToggle} aria-expanded={expanded} title={label}>
          <span className="files-list__group-head">
            <span className="files-list__group-caret" aria-hidden="true">
              <ChevronRight size={14} strokeWidth={2}/>
            </span>
            <span className="files-list__icon" aria-hidden="true">
              <AgentLifecycleStatusIcon status={owner.status} size={17} strokeWidth={1.75}/>
            </span>
            <span className="files-list__title">{label}</span>
          </span>
          <CompactChildState summary={summary} prioritizeFailure={owner.status === "running" && !expanded} startedAtMs={owner.startedAtMs} running={owner.status === "running"}/>
        </button>
        <button type="button" className="files-list__group-open" onClick={() => conversationId
            ? openAgentThreadTab({
                threadId: owner.id,
                conversationId,
                agentType: owner.agentType,
                title: label,
                source: owner.source,
                readOnly: owner.readOnly,
                parentAgentId: owner.parentAgentId,
            })
            : undefined} aria-label="View agent thread" title="View agent thread">
          <Eye size={13} strokeWidth={2} aria-hidden="true"/>
        </button>
      </li>
      {expanded
        ? descendants.map((child) => (<li key={`agent:${child.id}`} className="files-list__item files-list__item--nested">
            <AgentThreadButton task={child} conversationId={conversationId}/>
          </li>))
        : null}
    </>);
}

export function WorkList({ section = "files", idleContent = null }) {

    const showSearch = section === "home";
    const chat = useChatRuntime();
    const { state } = useUiState();
    const entries = useFileEntries();
    const panelOpen = useDisplayPanelOpen();
    const activeSection = useActiveSidebarSection();
    const searchOpen = useDisplaySearchOpen();
    const storedQuery = useDisplaySearchQuery();
    const focusRequest = useDisplaySearchFocusRequest();
    const [inputValue, setInputValue] = useState(storedQuery);
    const deferredQuery = useDeferredValue(inputValue.trim().toLowerCase());
    const inputRef = useRef(null);
    const scrollRef = useRef(null);
    const pageEndRef = useRef(null);
    const [draggingMedia, setDraggingMedia] = useState(false);
    const [visibleItemCount, setVisibleItemCount] = useState(WORK_PAGE_SIZE);

    const [expandedGroupIds, setExpandedGroupIds] = useState(() => new Set());
    const toggleGroup = useCallback((id) => {
        setExpandedGroupIds((prev) => {
            const next = new Set(prev);
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            return next;
        });
    }, []);
    useEffect(() => {
        setExpandedGroupIds(new Set());
    }, [state.conversationId]);
    const dragCounterRef = useRef(0);
    useEffect(() => {
        void loadCanvasHtmlHistory();
    }, []);
    useEffect(() => {
        if (!showSearch) return;
        if (!searchOpen) {
            setInputValue("");
            return;
        }
        const timer = window.setTimeout(() => {
            displaySearchStore.setQuery(inputValue);
        }, 120);
        return () => window.clearTimeout(timer);
    }, [inputValue, searchOpen, showSearch]);
    useEffect(() => {
        if (!showSearch || !searchOpen)
            return;
        const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
        return () => window.cancelAnimationFrame(frame);
    }, [focusRequest, searchOpen, showSearch]);
    useEffect(() => {

        if (searchOpen && (!panelOpen || activeSection !== "home")) {
            displaySearchStore.close();
        }
    }, [activeSection, panelOpen, searchOpen]);
    const query = showSearch && searchOpen ? deferredQuery : "";
    const items = useMemo(() => {

        const agents = query
            ? groupActivityTasks(chat.conversation.tasks)
            .filter((row) => {
            if (!query)
                return true;
            return getActivityRowSearchText(row).toLowerCase().includes(query);
        })
            .map((row) => row.kind === "task"
            ? {
                kind: "agent",
                id: `agent:${row.task.id}`,
                timestamp: taskTimestamp(row.task),
                task: row.task,
            }
            : {
                kind: "agentGroup",
                id: `agent:${row.hierarchy.owner.id}`,
                timestamp: taskTimestamp(row.hierarchy.owner),
                hierarchy: row.hierarchy,
            })
            : [];
        const files = entries
            .filter((entry) => {
            if (!query)
                return true;
            return `${entry.title} ${entry.filePath ?? ""}`
                .toLowerCase()
                .includes(query);
        })
            .map((entry) => ({
            kind: "file",
            id: `file:${entry.id}`,
            timestamp: entry.createdAt,
            entry,
        }));
        return [...agents, ...files].sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
    }, [chat.conversation.tasks, entries, query]);
    const visibleItems = useMemo(() => items.slice(0, visibleItemCount), [items, visibleItemCount]);
    const hasOlderItems = visibleItemCount < items.length;

    const bucketNowMs = Math.floor(Date.now() / 60000) * 60000;
    const itemGroups = useMemo(() => bucketByRecency(visibleItems, (item) => item.timestamp, bucketNowMs), [bucketNowMs, visibleItems]);
    useEffect(() => {
        setVisibleItemCount(WORK_PAGE_SIZE);
    }, [deferredQuery, searchOpen, state.conversationId]);
    const revealOlderItems = useCallback(() => {
        startTransition(() => {
            setVisibleItemCount((current) => Math.min(items.length, current + WORK_PAGE_SIZE));
        });
    }, [items.length]);
    useEffect(() => {
        const root = scrollRef.current;
        const pageEnd = pageEndRef.current;
        if (!root || !pageEnd || !hasOlderItems)
            return;
        const observer = new IntersectionObserver(([entry]) => {
            if (entry?.isIntersecting)
                revealOlderItems();
        }, {
            root,
            rootMargin: `0px 0px ${WORK_PAGE_END_THRESHOLD_PX}px`,
        });
        observer.observe(pageEnd);
        return () => observer.disconnect();
    }, [hasOlderItems, revealOlderItems, visibleItemCount]);
    const importDroppedFiles = useCallback(async (files) => {
        const supported = files.filter(isSupportedMediaFile);
        if (supported.length === 0) {
            notifyMediaGenerationError(new Error("Drop an image, video, or audio file."));
            return;
        }
        try {
            for (const file of supported) {
                await importLocalMedia(file);
            }
            if (supported.length < files.length) {
                notifyMediaGenerationError(new Error("Some files were skipped because they are not media."));
            }
        }
        catch (error) {
            notifyMediaGenerationError(error);
        }
    }, []);
    return (<div className="files-list" data-search-open={(showSearch && searchOpen) || undefined} onDragEnter={(event) => {
            if (!dataTransferHasSupportedMedia(event))
                return;
            event.preventDefault();
            event.stopPropagation();
            dragCounterRef.current += 1;
            if (dragCounterRef.current === 1)
                setDraggingMedia(true);
        }} onDragOver={(event) => {
            if (!dataTransferHasSupportedMedia(event))
                return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "copy";
        }} onDragLeave={(event) => {
            if (!draggingMedia)
                return;
            event.preventDefault();
            event.stopPropagation();
            dragCounterRef.current -= 1;
            if (dragCounterRef.current <= 0) {
                dragCounterRef.current = 0;
                setDraggingMedia(false);
            }
        }} onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            dragCounterRef.current = 0;
            setDraggingMedia(false);
            const files = Array.from(event.dataTransfer.files);
            if (files.length > 0)
                void importDroppedFiles(files);
        }}>
      <DropOverlay visible={draggingMedia} variant="sidebar"/>
      {showSearch ? (<div className="files-list__search">
        <Search size={15} strokeWidth={1.75} aria-hidden="true"/>
        <input ref={inputRef} type="text" value={inputValue} placeholder="Search anything" onFocus={() => {
            if (!searchOpen)
                displaySearchStore.open();
        }} onChange={(event) => setInputValue(event.currentTarget.value)} onKeyDown={(event) => {
            if (event.key === "Escape")
                displaySearchStore.close();
        }} aria-label="Search anything"/>
      </div>) : null}

      {!query && idleContent ? (idleContent) : items.length === 0 ? (<div className="sidebar-section__empty">
          <span className="sidebar-section__empty-icon" aria-hidden="true">
            {query ? (<Search size={17} strokeWidth={1.75}/>) : (<LayoutList size={17} strokeWidth={1.75}/>)}
          </span>
          <p className="sidebar-section__empty-title">
            {query ? "No matches" : "Nothing here yet"}
          </p>
          <p className="sidebar-section__empty-body">
            {query
                ? "No agents or files match that search."
                : "Files you work on with Stella will show up here."}
          </p>
        </div>) : (<div ref={scrollRef} className="sidebar-section__scroll">
          <ul className="files-list__items">
            {itemGroups.map((group) => (<li key={group.id} className="files-list__group">
                <h3 className="files-list__group-heading">
                  {RECENCY_LABELS[group.id]}
                </h3>
                <ul className="files-list__items files-list__group-items">
                  {group.items.map((item) => item.kind === "agentGroup" ? (<AgentGroupRow key={item.id} hierarchy={item.hierarchy} conversationId={state.conversationId} expanded={query ? true : expandedGroupIds.has(item.id)} onToggle={() => toggleGroup(item.id)}/>) : item.kind === "agent" ? (<li key={item.id} className="files-list__item">
                    <AgentThreadButton task={item.task} conversationId={state.conversationId}/>
                </li>) : (<li key={item.id} className="files-list__item">
                  <button type="button" className="files-list__open" onClick={() => openDisplayPayloadTab(item.entry.payload)} title={item.entry.filePath ?? item.entry.title}>
                    <span className="files-list__icon" aria-hidden="true">
                      <DisplayTabIcon kind={item.entry.kind} size={17}/>
                    </span>
                    <span className="files-list__title">
                      {workItemLabel(item)}
                    </span>
                    <span className="files-list__meta">File</span>
                  </button>
                  <button type="button" className="files-list__remove" onClick={() => forgetEntry(item.entry)} aria-label={`Remove ${item.entry.title}`} title={`Remove ${item.entry.title}`}>
                    <X size={12} strokeWidth={2.2} aria-hidden="true"/>
                  </button>
                </li>))}
                </ul>
              </li>))}
          </ul>
          {hasOlderItems ? (<div key={visibleItemCount} ref={pageEndRef} className="files-list__page-end" aria-hidden="true"/>) : null}
        </div>)}
    </div>);
}

export function FilesSection({ location = null }) {
    const { tabs } = useDisplayTabList();
    const openTab = location
        ? (tabs.find((tab) => tab.id === location) ?? null)
        : null;

    return (<div className="work-section">
      <div className="work-section__body">
        {
}
        {!openTab ? (<WorkList section="files" />) : (<div className="sidebar-section__viewer-body">
            <DeferredDisplayContent key={openTab.id} render={openTab.render}/>
          </div>)}
      </div>
    </div>);
}
