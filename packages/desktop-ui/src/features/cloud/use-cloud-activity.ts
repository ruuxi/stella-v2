/**
 * Cloud agent threads projected into the exact Activity row model the local
 * runtime produces (C10). A thread that ran in the cloud is the same kind of
 * work as one that ran on this Mac — it lists in the same Activity section,
 * with the same expand/updates/open affordances. Only a small placement
 * badge says where it ran.
 */
import { useCallback, useMemo } from "react";
import {
  usePaginatedQuery_experimental,
  useQueries,
  type RequestForQueries,
} from "convex/react";
import type { TaskLifecycleStatus } from "@stella/contracts/agent-runtime";
import type { TaskItem } from "@/features/chat/lib/event-transforms";
import { useCloudMode } from "@/global/auth/hooks/use-cloud-mode";
import { cloudConversationBelongsToAccountScope } from "./cloud-conversation-selection";
import { cloudApi, type CloudAgentThread } from "./cloud-api";

/** Human label for a C2 workspace identity. */
export const cloudWorkspaceLabel = (workspace: string): string => {
  if (workspace === "drive") return "Drive";
  if (workspace === "stella") return "Stella";
  if (workspace === "computer") return "Computer";
  const [kind, ...rest] = workspace.split(":");
  const slug = rest.join(":");
  if (slug && (kind === "project" || kind === "app")) return slug;
  return workspace;
};

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
  /** taskId → workspace label, rendered as the row's placement badge. */
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
    placements.set(thread.threadId, cloudWorkspaceLabel(thread.workspace));
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
  const { cloudMode } = useCloudMode();
  // `useQueries`, not `useQuery`: this hook runs inside the left sidebar,
  // which is not wrapped in a CloudBoundary. A deployment that does not have
  // this function yet must cost the user their cloud rows, not the sidebar,
  // so a failed query arrives as a value here instead of throwing in render.
  // Convex's `useQueries` treats a changed request object as a changed
  // subscription and schedules a render-phase state update. Keep this object
  // stable or the sidebar re-renders forever while authenticated.
  const activityQueries = useMemo<RequestForQueries>(() => {
    const queries: RequestForQueries = {};
    if (cloudMode) {
      queries.threads = {
        query: cloudApi.listMyRecentAgentThreads,
        args: { limit: ACTIVITY_THREAD_LIMIT },
      };
    }
    return queries;
  }, [cloudMode]);
  const results = useQueries(activityQueries);
  const threads = Array.isArray(results.threads)
    ? (results.threads as CloudAgentThread[])
    : undefined;
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

export const cloudThreadsForAccountScope = (
  threads: readonly CloudAgentThread[],
  accountScope: string,
): CloudAgentThread[] =>
  threads.filter((thread) =>
    cloudConversationBelongsToAccountScope(thread, accountScope),
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
  const { cloudMode, accountScope, identityRevision } = useCloudMode();
  // Object-form pagination returns deployment-skew/auth-refresh errors as a
  // value instead of throwing through the shell. That preserves the previous
  // `useQueries` behavior while delegating cursor splitting and invalid-cursor
  // recovery to Convex's official pagination implementation.
  const page = usePaginatedQuery_experimental({
    query: cloudApi.listMyAgentThreadsPage,
    args:
      cloudMode && conversationId
        ? { conversationId, identityRevision }
        : "skip",
    initialNumItems: CLOUD_ACTIVITY_PAGE_SIZE,
  });
  const runningQueries = useMemo<RequestForQueries>(() => {
    const queries: RequestForQueries = {};
    if (cloudMode && conversationId) {
      queries.running = {
        query: cloudApi.listMyRunningAgentThreads,
        args: { conversationId, identityRevision },
      };
    }
    return queries;
  }, [cloudMode, conversationId, identityRevision]);
  const runningResults = useQueries(runningQueries);
  const pageThreads = Array.isArray(page.data)
    ? (page.data as CloudAgentThread[])
    : undefined;
  const runningThreads = Array.isArray(runningResults.running)
    ? (runningResults.running as CloudAgentThread[])
    : undefined;
  // Convex authorization is the real boundary. This second owner check keeps
  // a cached page from the previous account out of even one transition frame
  // while the authenticated subscription is being replaced.
  const ownedThreads = useMemo(
    () =>
      pageThreads
        ? cloudThreadsForAccountScope(pageThreads, accountScope)
        : undefined,
    [accountScope, pageThreads],
  );
  const ownedRunningThreads = useMemo(
    () =>
      runningThreads
        ? cloudThreadsForAccountScope(runningThreads, accountScope)
        : undefined,
    [accountScope, runningThreads],
  );
  const pageOwnedByCurrentScope =
    pageThreads === undefined || ownedThreads?.length === pageThreads.length;
  const runningOwnedByCurrentScope =
    runningThreads === undefined ||
    ownedRunningThreads?.length === runningThreads.length;
  const pageScopeIsCurrent =
    pageOwnedByCurrentScope && runningOwnedByCurrentScope;
  const runningHasLoaded =
    !cloudMode || !conversationId || runningResults.running !== undefined;
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
    (!cloudMode ||
      !conversationId ||
      page.status === "error" ||
      page.data !== undefined);
  const isLoadingOlder =
    pageScopeIsCurrent && page.status === "pending" && page.data !== undefined;
  const hasOlder =
    pageScopeIsCurrent &&
    ((page.status === "success" && page.canLoadMore) || isLoadingOlder);
  const loadMore = page.loadMore;
  const loadOlder = useCallback(() => {
    if (pageScopeIsCurrent && page.status === "success" && page.canLoadMore) {
      loadMore(CLOUD_ACTIVITY_PAGE_SIZE);
    }
  }, [loadMore, page.canLoadMore, page.status, pageScopeIsCurrent]);
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
