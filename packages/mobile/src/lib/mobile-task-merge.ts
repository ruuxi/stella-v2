import type { ChatMessage, MobileTask } from "../types";

const isRunningTask = (task: MobileTask) => task.status === "running";

const taskTerminalAt = (task: MobileTask) =>
  typeof task.completedAt === "number" && Number.isFinite(task.completedAt)
    ? task.completedAt
    : task.createdAt;

const isWellFormedTaskId = (value: string): boolean =>
  value.length > 0 && value.trim() === value;

/**
 * Project the merged task graph onto the root mobile Activity surface.
 *
 * A General task whose first unresolved parent is absent from Activity is a
 * normal standalone task owned by the Orchestrator. Once an Activity parent
 * resolves, Manager ancestry, malformed ownership, duplicate ids, cycles, or
 * a later missing ancestor suppress the descendant rather than presenting
 * Manager-internal work as an independent task. Root Manager rows remain
 * visible and also provide the ownership evidence for that suppression.
 */
export const selectRootMobileActivityTasks = (
  tasks: readonly MobileTask[],
): MobileTask[] => {
  const taskById = new Map<string, MobileTask>();
  const duplicateIds = new Set<string>();
  for (const task of tasks) {
    if (taskById.has(task.id)) duplicateIds.add(task.id);
    else taskById.set(task.id, task);
  }

  return tasks.filter((task) => {
    if (!isWellFormedTaskId(task.id) || duplicateIds.has(task.id)) return false;
    if (task.agentType === "manager") {
      return task.parentAgentId === undefined;
    }
    if (task.agentType && task.agentType !== "general") return false;

    let parentId = task.parentAgentId;
    if (parentId === undefined) return true;
    if (!isWellFormedTaskId(parentId)) return false;

    const visited = new Set([task.id]);
    let resolvedActivityParent = false;
    while (parentId) {
      if (visited.has(parentId) || duplicateIds.has(parentId)) return false;
      visited.add(parentId);

      const parent = taskById.get(parentId);
      if (!parent) return !resolvedActivityParent;
      resolvedActivityParent = true;
      if (parent.agentType === "manager") return false;
      if (parent.agentType && parent.agentType !== "general") return false;

      parentId = parent.parentAgentId;
      if (parentId === undefined) return true;
      if (!isWellFormedTaskId(parentId)) return false;
    }

    return false;
  });
};

const withOwnershipFallbacks = (
  existing: MobileTask,
  next: MobileTask,
): MobileTask => ({
  ...next,
  ...(!next.agentType && existing.agentType
    ? { agentType: existing.agentType }
    : {}),
  ...(next.parentAgentId === undefined && existing.parentAgentId !== undefined
    ? { parentAgentId: existing.parentAgentId }
    : {}),
});

const withRunningFallbacks = (
  existing: MobileTask,
  next: MobileTask,
): MobileTask => {
  const ownedNext = withOwnershipFallbacks(existing, next);
  if (!isRunningTask(ownedNext)) return ownedNext;
  return {
    ...ownedNext,
    ...(ownedNext.statusText || !existing.statusText
      ? {}
      : { statusText: existing.statusText }),
    ...(ownedNext.reasoningSummaries?.length ||
    !existing.reasoningSummaries?.length
      ? {}
      : { reasoningSummaries: existing.reasoningSummaries }),
  };
};

export const mergeMobileTaskSnapshot = (
  existing: MobileTask | undefined,
  next: MobileTask,
): MobileTask => {
  if (!existing) return next;

  const existingRunning = isRunningTask(existing);
  const nextRunning = isRunningTask(next);
  if (existingRunning && !nextRunning) {
    return taskTerminalAt(next) >= existing.createdAt
      ? withOwnershipFallbacks(existing, next)
      : existing;
  }
  if (!existingRunning && nextRunning) {
    return next.createdAt > taskTerminalAt(existing)
      ? withRunningFallbacks(existing, next)
      : existing;
  }
  if (!existingRunning && !nextRunning) {
    return taskTerminalAt(next) >= taskTerminalAt(existing)
      ? withOwnershipFallbacks(existing, next)
      : existing;
  }
  return next.createdAt >= existing.createdAt
    ? withRunningFallbacks(existing, next)
    : existing;
};

export const collectConversationTasks = (
  messages: Pick<ChatMessage, "tasks">[],
): MobileTask[] => {
  const byId = new Map<string, MobileTask>();
  for (const message of messages) {
    for (const task of message.tasks ?? []) {
      byId.set(task.id, mergeMobileTaskSnapshot(byId.get(task.id), task));
    }
  }
  const rank = (task: MobileTask) => (task.status === "running" ? 0 : 1);
  return selectRootMobileActivityTasks([...byId.values()]).sort(
    (a, b) =>
      rank(a) - rank(b) ||
      b.createdAt - a.createdAt ||
      a.id.localeCompare(b.id),
  );
};

/**
 * Join the tasks the conversation's cloud journal records with the ones this
 * phone folded from its own optimistic rows. The journal is the authority for
 * every task, including agents running on a paired computer; a task both know
 * about keeps whichever snapshot is newer, so a stale running row cannot
 * revive a task the journal already saw finish.
 */
export const mergeJournalTasks = (
  journal: readonly MobileTask[],
  live: readonly MobileTask[],
): MobileTask[] => {
  if (journal.length === 0) return [...live];
  const byId = new Map<string, MobileTask>();
  for (const task of journal) byId.set(task.id, task);
  for (const task of live) {
    byId.set(task.id, mergeMobileTaskSnapshot(byId.get(task.id), task));
  }
  const rank = (task: MobileTask) => (task.status === "running" ? 0 : 1);
  return selectRootMobileActivityTasks([...byId.values()]).sort(
    (a, b) =>
      rank(a) - rank(b) ||
      b.createdAt - a.createdAt ||
      a.id.localeCompare(b.id),
  );
};
