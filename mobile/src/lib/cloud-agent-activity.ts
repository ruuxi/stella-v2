import type { MobileTask } from "../types";
import type { CloudAgentThread } from "./cloud-conversation-api";

const MAX_OPERATIONAL_FALLBACK_TASKS = 8;

export type CloudAgentThreadQueryArgs =
  | "skip"
  | { conversationId: string };

export type CloudOperationalTaskScope = {
  accountScope: string;
  conversationId: string;
  desktopDeviceId: string;
};

export type ScopedCloudOperationalTasks = CloudOperationalTaskScope & {
  tasks: MobileTask[];
};

/**
 * Owner-scoped activity must not subscribe until both the exact Convex
 * identity and the ownership migration gate have resolved.
 */
export function resolveCloudAgentThreadQueryArgs({
  canUseOwnerData,
  conversationId,
}: {
  canUseOwnerData: boolean;
  conversationId: string | null;
}): CloudAgentThreadQueryArgs {
  return canUseOwnerData && conversationId
    ? { conversationId }
    : "skip";
}

const threadStatus = (status: string): MobileTask["status"] => {
  if (status === "running") return "running";
  if (status === "completed") return "completed";
  if (status === "canceled") return "canceled";
  return "error";
};

/** Project the canonical Convex lifecycle row into mobile Activity's model. */
export function cloudAgentThreadToMobileTask(
  thread: CloudAgentThread,
): MobileTask {
  const status = threadStatus(thread.status);
  return {
    id: thread.threadId,
    title: thread.description.trim() || "Background work",
    agentType: thread.agentType.trim() || "general",
    status,
    createdAt: thread.createdAt,
    ...(status === "running" ? {} : { completedAt: thread.updatedAt }),
  };
}

export function projectCloudAgentThreads(
  threads: readonly CloudAgentThread[] | undefined,
): MobileTask[] {
  return threads?.map(cloudAgentThreadToMobileTask) ?? [];
}

/**
 * An async bridge refresh may settle after the selected account, conversation,
 * or paired desktop changed. Keep the captured scope on the snapshot and
 * reject it unless every identity still matches the current render.
 */
export function selectScopedCloudOperationalTasks(
  snapshot: ScopedCloudOperationalTasks | null,
  current: CloudOperationalTaskScope | null,
): readonly MobileTask[] {
  if (
    !snapshot ||
    !current ||
    snapshot.accountScope !== current.accountScope ||
    snapshot.conversationId !== current.conversationId ||
    snapshot.desktopDeviceId !== current.desktopDeviceId
  ) {
    return [];
  }
  return snapshot.tasks;
}

const taskRank = (task: MobileTask) => (task.status === "running" ? 0 : 1);

/**
 * Convex owns task identity, status, title, and timestamps. The desktop bridge
 * can decorate a matching running row with low-latency narration/reasoning.
 * Running bridge rows not yet visible in Convex get a small propagation
 * fallback; terminal bridge-only history is never admitted.
 */
export function mergeCanonicalCloudTasks(
  canonical: readonly MobileTask[],
  operational: readonly MobileTask[],
): MobileTask[] {
  const operationalById = new Map(
    operational.map((task) => [task.id, task] as const),
  );
  const canonicalIds = new Set(canonical.map((task) => task.id));
  const merged = canonical.map((task) => {
    const overlay = operationalById.get(task.id);
    if (
      task.status !== "running" ||
      overlay?.status !== "running"
    ) {
      return task;
    }
    return {
      ...task,
      ...(overlay.statusText ? { statusText: overlay.statusText } : {}),
      ...(overlay.reasoningSummaries?.length
        ? { reasoningSummaries: overlay.reasoningSummaries }
        : {}),
    };
  });

  const fallbacks = operational
    .filter(
      (task) => !canonicalIds.has(task.id) && task.status === "running",
    )
    .sort(
      (a, b) =>
        b.createdAt - a.createdAt || a.id.localeCompare(b.id),
    )
    .slice(0, MAX_OPERATIONAL_FALLBACK_TASKS);
  for (const task of fallbacks) {
    merged.push(task);
  }

  return merged.sort(
    (a, b) =>
      taskRank(a) - taskRank(b) ||
      b.createdAt - a.createdAt ||
      a.id.localeCompare(b.id),
  );
}
