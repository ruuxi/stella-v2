import type { ChatMessage, MobileTask } from "../types";

const isRunningTask = (task: MobileTask) => task.status === "running";

const taskTerminalAt = (task: MobileTask) =>
  typeof task.completedAt === "number" && Number.isFinite(task.completedAt)
    ? task.completedAt
    : task.createdAt;

const withRunningFallbacks = (
  existing: MobileTask,
  next: MobileTask,
): MobileTask => {
  if (!isRunningTask(next)) return next;
  return {
    ...next,
    ...(next.statusText || !existing.statusText
      ? {}
      : { statusText: existing.statusText }),
    ...(next.reasoningSummaries?.length || !existing.reasoningSummaries?.length
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
    return taskTerminalAt(next) >= existing.createdAt ? next : existing;
  }
  if (!existingRunning && nextRunning) {
    return next.createdAt > taskTerminalAt(existing)
      ? withRunningFallbacks(existing, next)
      : existing;
  }
  if (!existingRunning && !nextRunning) {
    return taskTerminalAt(next) >= taskTerminalAt(existing) ? next : existing;
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
  return [...byId.values()].sort(
    (a, b) =>
      rank(a) - rank(b) || b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  );
};
