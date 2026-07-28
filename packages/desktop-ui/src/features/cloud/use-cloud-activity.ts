/**
 * Cloud agent threads projected into the exact Activity row model the local
 * runtime produces (C10). A thread that ran in the cloud is the same kind of
 * work as one that ran on this Mac — it lists in the same Activity section,
 * with the same expand/updates/open affordances. Only a small placement
 * badge says where it ran.
 */
import { useMemo } from "react";
import {
  useConvexAuth,
  useQueries,
  useQuery,
  type RequestForQueries,
} from "convex/react";
import type { TaskLifecycleStatus } from "@stella/contracts/agent-runtime";
import type { TaskItem } from "@/features/chat/lib/event-transforms";
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

/**
 * The owner's newest cloud conversation is the one the interior chats in —
 * `startCloudChat` reuses it, so the composer and the rendered tail agree on
 * which conversation "the cloud chat" means. Activity does not use it: cloud
 * threads live across many conversations (see `useCloudActivity`).
 */
export const useActiveCloudConversationId = (): string | null => {
  const { isAuthenticated } = useConvexAuth();
  const conversations = useQuery(
    cloudApi.listMyConversations,
    isAuthenticated ? {} : "skip",
  );
  return conversations?.[0]?.conversationId ?? null;
};

/** The deepest the sidebar ever renders (`SEARCH_CAPS.activity`). */
const ACTIVITY_THREAD_LIMIT = 40;

/**
 * Every cloud thread the owner has, regardless of which cloud conversation it
 * hangs off. Desktop-dispatched agents, scheduled runs, and threads spawned
 * from the phone each land in a different conversation, and a thread that is
 * still running must stay in the sidebar no matter which of them the owner
 * touched last.
 */
export const useCloudActivity = (): CloudActivity => {
  const { isAuthenticated } = useConvexAuth();
  // `useQueries`, not `useQuery`: this hook runs inside the left sidebar,
  // which is not wrapped in a CloudBoundary. A deployment that does not have
  // this function yet must cost the user their cloud rows, not the sidebar,
  // so a failed query arrives as a value here instead of throwing in render.
  // Convex's `useQueries` treats a changed request object as a changed
  // subscription and schedules a render-phase state update. Keep this object
  // stable or the sidebar re-renders forever while authenticated.
  const activityQueries = useMemo<RequestForQueries>(() => {
    const queries: RequestForQueries = {};
    if (isAuthenticated) {
      queries.threads = {
        query: cloudApi.listMyRecentAgentThreads,
        args: { limit: ACTIVITY_THREAD_LIMIT },
      };
    }
    return queries;
  }, [isAuthenticated]);
  const results = useQueries(activityQueries);
  const threads = Array.isArray(results.threads)
    ? (results.threads as CloudAgentThread[])
    : undefined;
  return useMemo(() => {
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
      threads,
      tasks,
      placements,
      threadsById,
      hasRunning: threads.some((thread) => thread.status === "running"),
    };
  }, [threads]);
};
