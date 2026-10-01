/**
 * Cloud agent threads projected into the exact Activity row model the local
 * runtime produces (C10). A thread that ran in the cloud is the same kind of
 * work as one that ran on this Mac — it lists in the same Activity section,
 * with the same expand/updates/open affordances. Only a small placement
 * badge says where it ran.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { TaskLifecycleStatus } from "@stella/contracts/agent-runtime";
import { CONVERSATION_AGENT_THREADS_MAX } from "@stella/contracts/backend/agent-threads";
import type { TaskItem } from "@/features/chat/lib/event-transforms";
import { useCloudConversationSession } from "@/global/auth/hooks/use-cloud-conversation-session";
import { useBackendView } from "@/platform/backend/use-backend-view";
import { cloudConversationBelongsToOwnerSubject } from "./cloud-conversation-selection";
import type { CloudAgentThread } from "./cloud-api";

/** Human label for where a thread ran. */
export const cloudPlacementLabel = (placement: string): string =>
  placement === "computer" ? "Computer" : "Cloud";

const threadStatus = (status: string): TaskLifecycleStatus => {
  if (status === "running") return "running";
  if (status === "completed") return "completed";
  if (status === "canceled") return "canceled";
  return "error";
};

/** The agent's own report — the same prose a local agent leaves behind. */
export const cloudThreadReport = (
  thread: CloudAgentThread,
): string | undefined => {
  if (thread.resultJson) {
    try {
      const parsed = JSON.parse(thread.resultJson) as { finalText?: string };
      if (typeof parsed.finalText === "string" && parsed.finalText.trim()) {
        return parsed.finalText.trim();
      }
    } catch {
      // A non-JSON result is still the agent's own text.
      return thread.resultJson;
    }
  }
  return thread.errorMessage?.trim() || undefined;
};

export const cloudThreadToTask = (thread: CloudAgentThread): TaskItem => {
  const status = threadStatus(thread.status);
  const report = cloudThreadReport(thread);
  return {
    id: thread.threadId,
    description: thread.description,
    agentType: thread.agentType || "general",
    source: "stella",
    // Cloud activity has its own cancel/resume authority. Until those controls
    // are integrated, local lifecycle actions must never target this row.
    readOnly: true,
    status,
    startedAtMs: thread.createdAt,
    lastUpdatedAtMs: thread.updatedAt,
    ...(status === "running" ? {} : { completedAtMs: thread.updatedAt }),
    ...(report
      ? {
          assistantMessages: [report],
          assistantMessagesUpdatedAtMs: thread.updatedAt,
        }
      : {}),
  };
};

export type CloudActivity = {
  threads: CloudAgentThread[];
  tasks: TaskItem[];
  /** taskId → placement label, rendered as the row's placement badge. */
  placements: ReadonlyMap<string, string>;
  threadsById: ReadonlyMap<string, CloudAgentThread>;
  hasRunning: boolean;
};

const EMPTY_ACTIVITY: CloudActivity = {
  threads: [],
  tasks: [],
  placements: new Map(),
  threadsById: new Map(),
  hasRunning: false,
};

/** The deepest the sidebar ever renders (`SEARCH_CAPS.activity`). */
const ACTIVITY_THREAD_LIMIT = 40;

const projectCloudActivity = (
  threads: readonly CloudAgentThread[] | undefined,
): CloudActivity => {
  if (!threads?.length) return EMPTY_ACTIVITY;
  const tasks: TaskItem[] = [];
  const placements = new Map<string, string>();
  const threadsById = new Map<string, CloudAgentThread>();
  for (const thread of threads) {
    tasks.push(cloudThreadToTask(thread));
    placements.set(thread.threadId, cloudPlacementLabel(thread.placement));
    threadsById.set(thread.threadId, thread);
  }
  return {
    threads: [...threads],
    tasks,
    placements,
    threadsById,
    hasRunning: threads.some((thread) => thread.status === "running"),
  };
};

/**
 * Every cloud thread the owner has, regardless of which cloud conversation it
 * hangs off. Desktop-dispatched agents, scheduled runs, and threads spawned
 * from the phone each land in a different conversation, and a thread that is
 * still running must stay in the sidebar no matter which of them the owner
 * touched last.
 */
export const useCloudActivity = (): CloudActivity => {
  const { isCloudConversationReady, ownerSubject } = useCloudConversationSession();
  // Errors arrive as state, never as a throw: this runs in the left sidebar,
  // which an unavailable backend must not take down.
  const recent = useBackendView(
    "agentThreads.recent",
    isCloudConversationReady ? { limit: ACTIVITY_THREAD_LIMIT } : "skip",
  );
  const threads = useMemo(
    () =>
      recent.value
        ? cloudThreadsForOwnerSubject(recent.value, ownerSubject)
        : undefined,
    [ownerSubject, recent.value],
  );
  return useMemo(() => projectCloudActivity(threads), [threads]);
};

export type CloudConversationActivity = CloudActivity & {
  /** False only while the authenticated conversation query is unresolved. */
  hasLoaded: boolean;
  /** True while an older cursor exists or that cursor is being loaded. */
  hasOlder: boolean;
  isLoadingOlder: boolean;
  loadOlder: () => void;
};

/** Match the historical first-page size while making every older row reachable. */
export const CLOUD_ACTIVITY_PAGE_SIZE = 30;

export const cloudThreadsForOwnerSubject = (
  threads: readonly CloudAgentThread[],
  ownerSubject: string | null,
): CloudAgentThread[] =>
  threads.filter((thread) =>
    cloudConversationBelongsToOwnerSubject(thread, ownerSubject),
  );

export const mergeCloudThreadSnapshots = (
  history: readonly CloudAgentThread[],
  running: readonly CloudAgentThread[],
): CloudAgentThread[] => {
  const byId = new Map(history.map((thread) => [thread.threadId, thread]));
  for (const thread of running) {
    const current = byId.get(thread.threadId);
    if (!current || thread.updatedAt > current.updatedAt) {
      byId.set(thread.threadId, thread);
    }
  }
  return [...byId.values()].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.threadId.localeCompare(b.threadId),
  );
};

/**
 * Canonical agent-thread state for one conversation. Unlike the global
 * sidebar query, this projection can drive every conversation-scoped Activity
 * consumer (composer pill, mobile bridge, and presence) in a browser.
 */
export const useCloudConversationActivity = (
  conversationId: string | null,
): CloudConversationActivity => {
  const { isCloudConversationReady, ownerSubject } =
    useCloudConversationSession();
  const enabled = isCloudConversationReady && Boolean(conversationId);
  // History is the conversation's newest threads as one live view; "older"
  // raises the window. Running threads are their own view so a long-running
  // one never falls out behind newer completions.
  const [limit, setLimit] = useState(CLOUD_ACTIVITY_PAGE_SIZE);
  useEffect(() => setLimit(CLOUD_ACTIVITY_PAGE_SIZE), [conversationId]);
  const page = useBackendView(
    "agentThreads.forConversation",
    enabled && conversationId ? { conversationId, limit } : "skip",
    { keepPreviousValue: true },
  );
  const running = useBackendView(
    "agentThreads.running",
    enabled && conversationId ? { conversationId } : "skip",
  );
  const pageThreads = page.value?.threads;
  const runningThreads = running.value;
  // The backend authorizes every read. This second owner check keeps a value
  // from the previous account out of even one transition frame.
  const ownedThreads = useMemo(
    () =>
      pageThreads
        ? cloudThreadsForOwnerSubject(pageThreads, ownerSubject)
        : undefined,
    [ownerSubject, pageThreads],
  );
  const ownedRunningThreads = useMemo(
    () =>
      runningThreads
        ? cloudThreadsForOwnerSubject(runningThreads, ownerSubject)
        : undefined,
    [ownerSubject, runningThreads],
  );
  const pageOwnedByCurrentScope =
    pageThreads === undefined || ownedThreads?.length === pageThreads.length;
  const runningOwnedByCurrentScope =
    runningThreads === undefined ||
    ownedRunningThreads?.length === runningThreads.length;
  const pageScopeIsCurrent =
    pageOwnedByCurrentScope && runningOwnedByCurrentScope;
  const runningHasLoaded = !enabled || running.status !== "loading";
  const threads = useMemo(
    () =>
      pageScopeIsCurrent
        ? mergeCloudThreadSnapshots(
            ownedThreads ?? [],
            ownedRunningThreads ?? [],
          )
        : undefined,
    [ownedRunningThreads, ownedThreads, pageScopeIsCurrent],
  );
  const hasLoaded =
    pageScopeIsCurrent &&
    runningHasLoaded &&
    (!enabled || page.status !== "loading");
  // A raised window loads as a fresh subscription; until it lands the
  // previous rows stay on screen.
  const isLoadingOlder =
    pageScopeIsCurrent &&
    page.status === "loading" &&
    limit > CLOUD_ACTIVITY_PAGE_SIZE;
  const hasOlder =
    pageScopeIsCurrent &&
    ((page.value?.hasMore ?? false) || isLoadingOlder) &&
    limit < CONVERSATION_AGENT_THREADS_MAX;
  const canLoadMore = page.status === "ready" && page.value.hasMore;
  const loadOlder = useCallback(() => {
    if (pageScopeIsCurrent && canLoadMore) {
      setLimit((current) =>
        Math.min(current + CLOUD_ACTIVITY_PAGE_SIZE, CONVERSATION_AGENT_THREADS_MAX),
      );
    }
  }, [canLoadMore, pageScopeIsCurrent]);
  return useMemo(
    () => ({
      ...projectCloudActivity(threads),
      hasLoaded,
      hasOlder,
      isLoadingOlder,
      loadOlder,
    }),
    [hasLoaded, hasOlder, isLoadingOlder, loadOlder, threads],
  );
};

/**
 * Cloud rows own durable identity/status. Desktop runtime rows only decorate
 * a matching running row with lower-latency operational detail, or bridge the
 * brief interval before the cloud row becomes observable.
 */
export const mergeCloudConversationTasks = (
  canonical: readonly TaskItem[],
  operational: readonly TaskItem[],
): TaskItem[] => {
  if (canonical.length === 0) return [...operational];
  const operationalById = new Map(
    operational.map((task) => [task.id, task] as const),
  );
  const canonicalIds = new Set(canonical.map((task) => task.id));
  const merged = canonical.map((task) => {
    const overlay = operationalById.get(task.id);
    if (!overlay || task.status !== "running") return task;
    return {
      ...task,
      ...(overlay.statusText ? { statusText: overlay.statusText } : {}),
      ...(overlay.toolActivity ? { toolActivity: overlay.toolActivity } : {}),
      ...(overlay.reasoningText
        ? { reasoningText: overlay.reasoningText }
        : {}),
      ...(overlay.anchorTurnId ? { anchorTurnId: overlay.anchorTurnId } : {}),
    };
  });
  for (const task of operational) {
    if (!canonicalIds.has(task.id)) merged.push(task);
  }
  return merged;
};
