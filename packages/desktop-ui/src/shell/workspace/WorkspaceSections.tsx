import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AppWindowMac, ChevronRight } from "@/ui/icons";
import {
  getServerSnapshot as getUserAppsServerSnapshot,
  getSnapshot as getUserAppsSnapshot,
  subscribe as subscribeToUserApps,
} from "@/app/apps/user-apps-registry";
import {
  formatUserAppCreatedAt,
  listUserApps,
} from "@/app/apps/user-app-library";
import { AgentLifecycleStatusIcon } from "@/features/chat/components/AgentLifecycleStatusIcon";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { useTPlural } from "@/shared/i18n";
import { useUiState } from "@/context/ui-state";
import {
  useConversationSchedules,
  type ScheduleEntry,
} from "@/global/schedule/use-conversation-schedules";
import { formatNextRun } from "@/global/schedule/format-schedule";
import { matchesQuery } from "@/features/workspace-display/display-search-store";
import { sidebarSections } from "@/features/workspace-display/sidebar-sections";
import {
  sectionCollapseStore,
  useSectionCollapsed,
} from "@/shell/section-collapse-store";
import {
  EMPTY_ACTIVITY_EXPANSION,
  activityExpansionStore,
} from "@/shell/activity-expansion-store";
import {
  activityRowKey,
  compareActivityRowsByLifecycleStart,
  flattenActivityTasks,
  getActivityRowCompletedAtMs,
  getActivityRowSearchText,
  getActivityRowStatus,
  groupActivityTasks,
  getTaskAgentUpdates,
  summarizeCompactActivity,
  updateSeenRunningTaskIds,
  type ActivityRow,
  type TaskItem,
} from "@/features/chat/lib/event-transforms";
import {
  deriveConversationFiles,
  type ConversationFileEntry,
} from "@/features/workspace-display/derive-conversation-files";
import {
  agentFilesSignature,
  deriveAgentFilesMap,
  mergeAgentFileEvents,
} from "@/features/workspace-display/agent-files";
import { DisplayTabIcon } from "@/features/workspace-display/icons";
import {
  openAgentThreadTab,
  openDisplayPayloadTab,
} from "@/features/workspace-display/open-payload";
import { displayTabKindForPayload } from "@/features/workspace-display/payload-kind";
import { basenameOf } from "@/features/workspace-display/path-to-viewer";
import { ScheduleDetailsDialog } from "@/global/schedule/ScheduleDetailsDialog";
import type { ScheduleToolAffectedRef } from "@stella/contracts/scheduling";
import { ActivityTaskShimmer } from "@/shell/ActivityTaskShimmer";
import { AgentAssistantUpdates } from "@/shell/AgentAssistantUpdates";
import { CompactChildState } from "@/features/chat/components/CompactSubagentSummary";
import { useContinuousAnimationGate } from "@/shared/hooks/use-continuous-animation-gate";
import { TERMINAL_ROW_AUTOHIDE_MS } from "@/shell/workspace/use-qualifying-activity";
import "@/app/chat/chat-workspace-strip.css";

const SECTION_CAPS = {
  strip: { activity: 8, files: 5, schedule: 4 },
  overview: { activity: 9, files: 6, schedule: 6 },
} as const;

const SEARCH_CAPS = { activity: 40, files: 40, schedule: 30 };
const QUICK_SEARCH_CAPS = { activity: 8, files: 8, schedule: 4 };
const EMPTY_FILES: ReadonlyArray<ConversationFileEntry> = [];
const EMPTY_UPDATES: ReadonlyArray<string> = [];

const AGENT_UPDATE_CAP = 1;

const activityRowText = (row: ActivityRow): string =>
  getActivityRowSearchText(row);

const LIST_GAP_PX = 10;

const ROW_HIDDEN = { height: 0, opacity: 0, marginTop: -LIST_GAP_PX };

const ROW_ENTER = {
  height: "auto",
  opacity: 1,
  marginTop: 0,
  transition: {
    height: { type: "spring", duration: 0.32, bounce: 0 },
    marginTop: { type: "spring", duration: 0.32, bounce: 0 },
    opacity: { duration: 0.2, delay: 0.1, ease: "easeOut" },
  },
} as const;

const ROW_EXIT = {
  height: 0,
  opacity: 0,
  marginTop: -LIST_GAP_PX,
  transition: {
    height: { type: "spring", duration: 0.28, bounce: 0, delay: 0.05 },
    marginTop: { type: "spring", duration: 0.28, bounce: 0, delay: 0.05 },
    opacity: { duration: 0.14, ease: "easeOut" },
  },
} as const;

const ROW_REORDER_TRANSITION = {
  type: "spring",
  duration: 0.32,
  bounce: 0,
} as const;

const ROW_EXIT_INSTANT = { ...ROW_HIDDEN, transition: { duration: 0 } };

const useActivityRowMotionProps = (orderIndex: number) => {
  const reduceMotion = useReducedMotion();
  return {
    layout: reduceMotion ? (false as const) : ("position" as const),
    layoutDependency: orderIndex,
    initial: reduceMotion ? false : ROW_HIDDEN,
    animate: ROW_ENTER,
    exit: reduceMotion ? ROW_EXIT_INSTANT : ROW_EXIT,
    transition: ROW_REORDER_TRANSITION,
  };
};

function WorkspaceSection({
  title,
  sectionId,
  hideHeader = false,
  children,
}: {
  title: string;

  sectionId: string;
  hideHeader?: boolean;
  children?: ReactNode;
}) {
  const collapsed = useSectionCollapsed(sectionId);
  const sectionCollapsed = hideHeader ? false : collapsed;
  return (
    <section className="chat-workspace-strip__section">
      {!hideHeader ? (
        <header className="chat-workspace-strip__section-header">
          <button
            type="button"
            className="chat-workspace-strip__section-toggle"
            onClick={() => sectionCollapseStore.toggle(sectionId)}
            aria-expanded={!sectionCollapsed}
          >
            {title}
          </button>
        </header>
      ) : null}
      <div
        className="chat-workspace-strip__section-collapse"
        data-collapsed={sectionCollapsed ? "true" : undefined}
      >
        <div className="chat-workspace-strip__section-body">{children}</div>
      </div>
    </section>
  );
}

const taskSourceLabel = (task: TaskItem): string | undefined =>
  task.source === "claude-native" ? "Claude · read-only" : undefined;

function TaskStatusIcon({ status }: { status: TaskItem["status"] }) {
  const suffix =
    status === "completed" ? "done" : status === "error" ? "error" : status;
  return (
    <AgentLifecycleStatusIcon
      status={status}
      className={`chat-workspace-strip__task-icon chat-workspace-strip__task-icon--${suffix}`}
      size={15}
      strokeWidth={2}
      aria-hidden="true"
    />
  );
}

const TaskRow = memo(function TaskRow({
  task,
  expanded,
  onToggle,
  onSelect,
  files,
  onOpenFile,
  orderIndex,
  metaText,
  childContent,
  compactChildren,
  compactFailurePriority = false,
  isTopLevel,
}: {
  task: TaskItem;
  expanded: boolean;
  onToggle: (taskId: string, nextExpanded: boolean) => void;

  onSelect: (task: TaskItem) => void;
  files: ReadonlyArray<ConversationFileEntry>;
  onOpenFile: (entry: ConversationFileEntry) => void;

  orderIndex: number;

  metaText?: string;

  childContent?: ReactNode;

  compactChildren?: readonly ActivityRow[];

  compactFailurePriority?: boolean;

  isTopLevel: boolean;
}) {
  const tPlural = useTPlural();
  const motionProps = useActivityRowMotionProps(orderIndex);
  const rowRef = useRef<HTMLLIElement>(null);

  const label = task.description.trim();
  const sourceLabel = taskSourceLabel(task);

  const hasSubagents = Boolean(compactChildren);
  const agentUpdates =
    !hasSubagents && task.status === "running"
      ? getTaskAgentUpdates(task)
      : EMPTY_UPDATES;

  const [filesExpanded, setFilesExpanded] = useState(false);
  const FILE_CHIP_PREVIEW = 2;
  const hasAgentUpdates = agentUpdates.length > 0;

  const parentDetail = compactChildren
    ? task.status === "running"
      ? task.statusText?.trim() &&
        task.statusText.trim() !== task.description.trim()
        ? task.statusText.trim()
        : undefined
      : task.outputPreview?.trim() || undefined
    : undefined;
  const hasFiles = files.length > 0;
  const previewFiles = files.slice(0, FILE_CHIP_PREVIEW);
  const extraFiles = files.slice(FILE_CHIP_PREVIEW);
  const hasExtraFiles = extraFiles.length > 0;
  const compactTasks = useMemo(
    () => (compactChildren ? flattenActivityTasks(compactChildren) : undefined),
    [compactChildren],
  );
  const compactSummary = useMemo(
    () => (compactTasks ? summarizeCompactActivity(compactTasks) : undefined),
    [compactTasks],
  );
  const compactMotionActive = useContinuousAnimationGate({
    active:
      task.status === "running" && (compactSummary?.runningCount ?? 0) > 0,
    elementRef: rowRef,
  });
  const hasChildContent = Boolean(childContent);
  const hasDetail =
    hasChildContent || Boolean(parentDetail) || hasAgentUpdates || hasFiles;
  const detailOpen = expanded && hasDetail;
  return (
    <motion.li
      {...motionProps}
      className="chat-workspace-strip__task-row"
      ref={rowRef}
      data-status={task.status}
      data-source={task.source}
      data-read-only={task.readOnly ? "true" : undefined}
      data-expanded={expanded ? "true" : undefined}
      title={label}
      data-continuous-animation={compactMotionActive ? "true" : undefined}
    >
      <div className="chat-workspace-strip__task-row-head">
        <button
          type="button"
          className="chat-workspace-strip__task-button"
          data-compact={compactSummary ? "true" : undefined}
          onClick={() => onSelect(task)}
          aria-label={
            task.source === "claude-native"
              ? "View Claude conversation"
              : "View activity"
          }
        >
          {compactSummary ? (
            <>
              <span className="chat-workspace-strip__compact-main">
                <span
                  className="chat-workspace-strip__task-icon-wrap"
                  aria-hidden="true"
                >
                  <TaskStatusIcon status={task.status} />
                </span>
                <span className="chat-workspace-strip__task-label">
                  <ActivityTaskShimmer
                    task={task}
                    text={label}
                    isTopLevel={isTopLevel}
                  />
                </span>
                {sourceLabel ? (
                  <span className="chat-workspace-strip__task-source">
                    {sourceLabel}
                  </span>
                ) : null}
              </span>
              <CompactChildState
                summary={compactSummary}
                prioritizeFailure={compactFailurePriority && !expanded}
                startedAtMs={task.startedAtMs}
                running={task.status === "running"}
              />
            </>
          ) : (
            <>
              <span
                className="chat-workspace-strip__task-icon-wrap"
                aria-hidden="true"
              >
                <TaskStatusIcon status={task.status} />
              </span>
              <span className="chat-workspace-strip__task-label">
                <ActivityTaskShimmer
                  task={task}
                  text={label}
                  isTopLevel={isTopLevel}
                />
              </span>
              {sourceLabel ? (
                <span className="chat-workspace-strip__task-source">
                  {sourceLabel}
                </span>
              ) : null}
              {metaText ? (
                <span className="chat-workspace-strip__row-meta chat-workspace-strip__group-status">
                  {metaText}
                </span>
              ) : null}
            </>
          )}
        </button>
        {hasDetail ? (
          <button
            type="button"
            className="chat-workspace-strip__task-caret"
            data-expanded={expanded ? "true" : undefined}
            onClick={() => onToggle(task.id, !expanded)}
            aria-expanded={expanded}
            aria-label={`${label || "Activity"} — ${
              expanded ? "collapse" : "expand"
            }`}
          >
            <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {

}
      <div
        className="chat-workspace-strip__task-collapse"
        data-collapsed={detailOpen ? undefined : "true"}
        inert={!detailOpen}
      >
        <div className="chat-workspace-strip__task-collapse-clip">
          {hasDetail ? (
            <div className="chat-workspace-strip__task-detail">
              {parentDetail ? (
                <p className="chat-workspace-strip__parent-status">
                  {parentDetail}
                </p>
              ) : null}
              {hasAgentUpdates || hasFiles ? (
                <div className="chat-workspace-strip__task-rail">
                  {hasAgentUpdates ? (
                    <AgentAssistantUpdates
                      messages={agentUpdates}
                      max={AGENT_UPDATE_CAP}
                    />
                  ) : null}
                  {hasFiles ? (
                    <ul className="chat-workspace-strip__list chat-workspace-strip__task-files">
                      {previewFiles.map((file) => (
                        <li
                          key={file.path}
                          className="chat-workspace-strip__row"
                          title={file.path}
                        >
                          <button
                            type="button"
                            className="chat-workspace-strip__file-button"
                            onClick={() => onOpenFile(file)}
                          >
                            <DisplayTabIcon
                              kind={displayTabKindForPayload(file.payload)}
                              size={15}
                            />
                            <span className="chat-workspace-strip__file-name">
                              {basenameOf(file.path)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {hasExtraFiles ? (
                    <button
                      type="button"
                      className="chat-workspace-strip__file-button chat-workspace-strip__files-toggle"
                      onClick={() => setFilesExpanded((value) => !value)}
                      aria-expanded={filesExpanded}
                    >
                      <span className="chat-workspace-strip__file-name">
                        {tPlural(
                          "shell.workspace.moreFiles",
                          extraFiles.length,
                        )}
                      </span>
                    </button>
                  ) : null}
                  {hasExtraFiles ? (

                    <div
                      className="chat-workspace-strip__task-collapse"
                      data-collapsed={filesExpanded ? undefined : "true"}
                      inert={!filesExpanded}
                    >
                      <div className="chat-workspace-strip__task-collapse-clip">
                        <ul className="chat-workspace-strip__list chat-workspace-strip__task-files">
                          {extraFiles.map((file) => (
                            <li
                              key={file.path}
                              className="chat-workspace-strip__row"
                              title={file.path}
                            >
                              <button
                                type="button"
                                className="chat-workspace-strip__file-button"
                                onClick={() => onOpenFile(file)}
                              >
                                <DisplayTabIcon
                                  kind={displayTabKindForPayload(file.payload)}
                                  size={15}
                                />
                                <span className="chat-workspace-strip__file-name">
                                  {basenameOf(file.path)}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {childContent}
            </div>
          ) : null}
        </div>
      </div>
    </motion.li>
  );
});

const TasksList = memo(function TasksList({
  rows,
  isTaskExpanded,
  isCompactTaskExpanded,
  onToggleTask,
  onSelectTask,
  agentFiles,
  onOpenFile,
  nested = false,
}: {
  rows: ReadonlyArray<ActivityRow>;
  isTaskExpanded: (task: TaskItem) => boolean;
  isCompactTaskExpanded: (task: TaskItem) => boolean;
  onToggleTask: (taskId: string, nextExpanded: boolean) => void;
  onSelectTask: (task: TaskItem) => void;
  agentFiles: ReadonlyMap<string, ConversationFileEntry[]>;
  onOpenFile: (entry: ConversationFileEntry) => void;
  nested?: boolean;
}) {
  return (
    <ul
      className={`chat-workspace-strip__list chat-workspace-strip__list--tasks${
        nested ? " chat-workspace-strip__group-members" : ""
      }`}
    >
      {
}
      <AnimatePresence initial={false}>
        {rows.map((row, index) =>
          row.kind === "task" ? (
            <TaskRow
              key={activityRowKey(row)}
              task={row.task}
              expanded={isTaskExpanded(row.task)}
              onToggle={onToggleTask}
              onSelect={onSelectTask}
              files={agentFiles.get(row.task.id) ?? EMPTY_FILES}
              onOpenFile={onOpenFile}
              orderIndex={index}
              isTopLevel={!nested}
            />
          ) : (
            <TaskRow
              key={activityRowKey(row)}
              task={
                row.hierarchy.status === row.hierarchy.owner.status
                  ? row.hierarchy.owner
                  : { ...row.hierarchy.owner, status: row.hierarchy.status }
              }
              expanded={isCompactTaskExpanded(row.hierarchy.owner)}
              onToggle={onToggleTask}
              onSelect={onSelectTask}
              files={agentFiles.get(row.hierarchy.owner.id) ?? EMPTY_FILES}
              onOpenFile={onOpenFile}
              orderIndex={index}
              isTopLevel={!nested}
              compactChildren={row.hierarchy.children}
              compactFailurePriority={row.hierarchy.owner.status === "running"}
              childContent={
                <TasksList
                  rows={row.hierarchy.children}
                  isTaskExpanded={isTaskExpanded}
                  isCompactTaskExpanded={isCompactTaskExpanded}
                  onToggleTask={onToggleTask}
                  onSelectTask={onSelectTask}
                  agentFiles={agentFiles}
                  onOpenFile={onOpenFile}
                  nested
                />
              }
            />
          ),
        )}
      </AnimatePresence>
    </ul>
  );
});

const scheduleEntryToAffectedRef = (
  entry: ScheduleEntry,
  conversationId: string,
): ScheduleToolAffectedRef => ({
  kind: entry.kind,
  id: entry.id,
  conversationId,
  name: entry.name,
  enabled: entry.enabled,
  nextRunAtMs: entry.nextRunAtMs,
});

export const WorkspaceSections = memo(function WorkspaceSections({
  query = "",
  variant = "strip",
  searchMode = "complete",
  includeUserApps = false,
  renderEmpty,
  onNavigate,
}: {

  query?: string;

  variant?: "strip" | "overview";

  searchMode?: "complete" | "quick";

  includeUserApps?: boolean;

  renderEmpty?: () => ReactNode;

  onNavigate?: () => void;
} = {}) {
  const chat = useChatRuntime();
  const { state } = useUiState();

  const conversationId = state.conversationId;
  const activity = chat.conversation.activity;
  const allTasks = chat.conversation.tasks;
  const filesFeed = chat.conversation.files;
  const {
    hasOlder: activityHasOlder,
    isLoadingOlder: activityIsLoadingOlder,
    loadOlder: loadOlderActivity,
  } = activity;
  const {
    hasOlder: filesHaveOlder,
    isLoadingOlder: filesAreLoadingOlder,
    loadOlder: loadOlderFiles,
  } = filesFeed;
  const schedules = useConversationSchedules(conversationId);
  const userAppsRegistry = useSyncExternalStore(
    subscribeToUserApps,
    getUserAppsSnapshot,
    getUserAppsServerSnapshot,
  );
  const userApps = userAppsRegistry.apps;

  const normalizedQuery = query.trim().toLowerCase();
  const searching = normalizedQuery.length > 0;
  const quickSearch = searching && searchMode === "quick";
  const caps = searching
    ? quickSearch
      ? QUICK_SEARCH_CAPS
      : SEARCH_CAPS
    : SECTION_CAPS[variant];

  useEffect(() => {
    if (!searching || quickSearch) return;
    if (activityHasOlder && !activityIsLoadingOlder) loadOlderActivity();
  }, [
    searching,
    quickSearch,
    activityHasOlder,
    activityIsLoadingOlder,
    loadOlderActivity,
  ]);

  useEffect(() => {
    if (!searching || quickSearch) return;
    if (filesHaveOlder && !filesAreLoadingOlder) loadOlderFiles();
  }, [
    searching,
    quickSearch,
    filesHaveOlder,
    filesAreLoadingOlder,
    loadOlderFiles,
  ]);

  const [openScheduleEntry, setOpenScheduleEntry] =
    useState<ScheduleEntry | null>(null);

  const seenRunningTasksRef = useRef<ReadonlySet<string>>(new Set());

  const [expandOverrides, setExpandOverrides] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map());
  const isTaskExpanded = useCallback(
    (task: TaskItem): boolean => {
      const override = expandOverrides.get(task.id);
      return (
        override ??
        (task.status === "running" || seenRunningTasksRef.current.has(task.id))
      );
    },
    [expandOverrides],
  );
  const isCompactTaskExpanded = useCallback(
    (task: TaskItem): boolean => expandOverrides.get(task.id) ?? false,
    [expandOverrides],
  );
  const toggleTask = useCallback((taskId: string, nextExpanded: boolean) => {
    setExpandOverrides((prev) => {
      const next = new Map(prev);
      next.set(taskId, nextExpanded);
      return next;
    });
  }, []);

  const [seededConversationId, setSeededConversationId] = useState<
    string | null | undefined
  >(undefined);
  if (seededConversationId !== conversationId) {
    setSeededConversationId(conversationId);
    const snapshot = conversationId
      ? activityExpansionStore.load(conversationId)
      : EMPTY_ACTIVITY_EXPANSION;
    seenRunningTasksRef.current = new Set(snapshot.seenTaskIds);
    setExpandOverrides(new Map(Object.entries(snapshot.taskOverrides)));
  }

  useMemo(() => {

    if (allTasks.length === 0) return;
    seenRunningTasksRef.current = updateSeenRunningTaskIds(
      seenRunningTasksRef.current,
      allTasks,
    );
  }, [allTasks]);

  const groupedRows = useMemo(() => groupActivityTasks(allTasks), [allTasks]);

  useEffect(() => {
    if (!conversationId || allTasks.length === 0) return;
    activityExpansionStore.save(conversationId, {
      seenTaskIds: [...seenRunningTasksRef.current],
      taskOverrides: Object.fromEntries(expandOverrides),
    });
  }, [conversationId, allTasks, expandOverrides]);

  const matchingActivityKeys = useMemo(() => {
    if (!searching) return null;
    const keys = new Set<string>();
    for (const row of groupedRows) {
      if (activityRowText(row).toLowerCase().includes(normalizedQuery)) {
        keys.add(activityRowKey(row));
      }
    }
    return keys;
  }, [groupedRows, normalizedQuery, searching]);

  const activityRows = useMemo(
    () =>
      matchingActivityKeys
        ? groupedRows.filter((row) =>
            matchingActivityKeys.has(activityRowKey(row)),
          )
        : groupedRows,
    [groupedRows, matchingActivityKeys],
  );

  const runningRows = useMemo(() => {
    const ordered = [...groupedRows]
      .filter((row) => getActivityRowStatus(row) === "running")
      .sort(compareActivityRowsByLifecycleStart);
    const visible = matchingActivityKeys
      ? ordered.filter((row) => matchingActivityKeys.has(activityRowKey(row)))
      : ordered;

    return visible;
  }, [groupedRows, matchingActivityKeys]);

  const doneRows = useMemo(
    () =>
      [...activityRows]
        .filter((row) => getActivityRowStatus(row) !== "running")
        .sort(
          (a, b) =>
            getActivityRowCompletedAtMs(b) - getActivityRowCompletedAtMs(a) ||
            activityRowKey(a).localeCompare(activityRowKey(b)),
        ),
    [activityRows],
  );

  const agentFileEvents = useMemo(
    () => mergeAgentFileEvents(activity.activities, filesFeed.files),
    [activity.activities, filesFeed.files],
  );
  const agentFilesCacheRef = useRef<{
    signature: string;
    result: Map<string, ConversationFileEntry[]>;
  } | null>(null);
  const agentFiles = useMemo(() => {
    const signature = agentFilesSignature(agentFileEvents);
    const cached = agentFilesCacheRef.current;
    if (cached && cached.signature === signature) return cached.result;
    const result = deriveAgentFilesMap(agentFileEvents);
    agentFilesCacheRef.current = { signature, result };
    return result;
  }, [agentFileEvents]);

  const searchableFiles = useMemo(
    () =>
      deriveConversationFiles(agentFileEvents).map((entry) => ({
        entry,
        searchText: entry.path.toLowerCase(),
      })),
    [agentFileEvents],
  );
  const filteredFiles = useMemo(() => {
    if (!searching) return EMPTY_FILES;
    return searchableFiles
      .filter(({ searchText }) => searchText.includes(normalizedQuery))
      .map(({ entry }) => entry);
  }, [normalizedQuery, searchableFiles, searching]);

  const filteredSchedules = useMemo(() => {
    if (!query) return schedules;
    return schedules.filter((entry) => matchesQuery(entry.name, query));
  }, [schedules, query]);

  const visibleUserApps = useMemo(
    () =>
      includeUserApps && searching
        ? listUserApps(userApps, query, "recent").slice(0, 8)
        : [],
    [includeUserApps, query, searching, userApps],
  );

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (searching) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [searching]);

  const visibleDoneRows = useMemo(
    () =>

      searching
        ? doneRows.slice(0, Math.max(0, caps.activity - runningRows.length))
        : doneRows.filter(
            (row) =>
              nowMs - getActivityRowCompletedAtMs(row) <=
              TERMINAL_ROW_AUTOHIDE_MS,
          ),
    [doneRows, caps.activity, runningRows.length, searching, nowMs],
  );
  const visibleActivityRows = useMemo(
    () => {
      const rows = [...runningRows, ...visibleDoneRows];
      return quickSearch ? rows.slice(0, caps.activity) : rows;
    },
    [caps.activity, quickSearch, runningRows, visibleDoneRows],
  );
  const visibleFiles = useMemo(
    () => filteredFiles.slice(0, caps.files),
    [caps.files, filteredFiles],
  );
  const upNext = useMemo(
    () => filteredSchedules.slice(0, caps.schedule),
    [filteredSchedules, caps.schedule],
  );
  const hasActivity = visibleActivityRows.length > 0;
  const hasFiles = searching && visibleFiles.length > 0;
  const hasSchedule = upNext.length > 0;
  const hasUserApps = visibleUserApps.length > 0;
  const dialogAffected = useMemo<ScheduleToolAffectedRef[]>(() => {
    if (!openScheduleEntry || !conversationId) return [];
    return [scheduleEntryToAffectedRef(openScheduleEntry, conversationId)];
  }, [conversationId, openScheduleEntry]);

  const handleOpenFile = useCallback(
    (entry: ConversationFileEntry) => {
      openDisplayPayloadTab(entry.payload);
      onNavigate?.();
    },
    [onNavigate],
  );

  const handleSelectTask = useCallback(
    (task: TaskItem) => {
      if (!conversationId) return;
      openAgentThreadTab({
        threadId: task.id,
        conversationId,
        agentType: task.agentType,
        title: task.description.trim() || task.agentType || "Agent thread",
        source: task.source,
        readOnly: task.readOnly,
        parentAgentId: task.parentAgentId,
      });
      onNavigate?.();
    },
    [conversationId, onNavigate],
  );

  if (
    !hasActivity &&
    !hasFiles &&
    !hasSchedule &&
    !hasUserApps
  ) {
    return renderEmpty ? <>{renderEmpty()}</> : null;
  }

  return (
    <>
      <div className="chat-workspace-strip__panel">
        {hasActivity && (
          <WorkspaceSection
            title="Activity"
            sectionId="activity"
            hideHeader
          >
            <TasksList
              rows={visibleActivityRows}
              isTaskExpanded={isTaskExpanded}
              isCompactTaskExpanded={isCompactTaskExpanded}
              onToggleTask={toggleTask}
              onSelectTask={handleSelectTask}
              agentFiles={agentFiles}
              onOpenFile={handleOpenFile}
            />
          </WorkspaceSection>
        )}

        {hasFiles && (
          <WorkspaceSection title="Files" sectionId="files">
            <ul className="chat-workspace-strip__list">
              {visibleFiles.map((file) => (
                <li
                  key={file.path}
                  className="chat-workspace-strip__row"
                  title={file.path}
                >
                  <button
                    type="button"
                    className="chat-workspace-strip__file-button"
                    onClick={() => handleOpenFile(file)}
                  >
                    <DisplayTabIcon
                      kind={displayTabKindForPayload(file.payload)}
                      size={15}
                    />
                    <span className="chat-workspace-strip__file-name">
                      {basenameOf(file.path)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </WorkspaceSection>
        )}

        {hasSchedule && (
          <WorkspaceSection title="Schedule" sectionId="schedule">
            <ul className="chat-workspace-strip__list">
              {upNext.map((entry) => (
                <li
                  key={`${entry.kind}:${entry.id}`}
                  className="chat-workspace-strip__row"
                >
                  <button
                    type="button"
                    className="chat-workspace-strip__file-button"
                    onClick={() => {
                      setOpenScheduleEntry(entry);
                    }}
                  >
                    <span className="chat-workspace-strip__row-label">
                      {entry.name.trim()}
                    </span>
                    <span className="chat-workspace-strip__row-meta">
                      {formatNextRun(entry.nextRunAtMs, nowMs)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </WorkspaceSection>
        )}

        {hasUserApps && (
          <WorkspaceSection title="Apps" sectionId="user-apps">
            <ul className="chat-workspace-strip__list">
              {visibleUserApps.map((app) => (
                <li key={app.slug} className="chat-workspace-strip__row">
                  <button
                    type="button"
                    className="chat-workspace-strip__file-button"
                    onClick={() => {
                      sidebarSections.openLocation("apps", app.slug);
                      onNavigate?.();
                    }}
                  >
                    <AppWindowMac size={15} strokeWidth={1.75} aria-hidden />
                    <span className="chat-workspace-strip__file-name">
                      {app.meta.label}
                    </span>
                    <span className="chat-workspace-strip__row-meta">
                      {formatUserAppCreatedAt(app.meta.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </WorkspaceSection>
        )}

      </div>
      <ScheduleDetailsDialog
        open={openScheduleEntry !== null}
        onOpenChange={(next) => {
          if (!next) setOpenScheduleEntry(null);
        }}
        affected={dialogAffected}
      />
    </>
  );
});
