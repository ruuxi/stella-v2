import type { ChatMessage, MobileTask } from "../types";
import type { DesktopTaskDecoration } from "./desktop-bridge-chat";

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

/**
 * Overlay the desktop's authoritative thread-activity rows and live
 * decoration onto the synced-message task fold.
 *
 * The authoritative rows (runtime `runtime_agents` projection) win outright
 * for status/title/timestamps of any task they cover — a running row is
 * running (no staleness settling), a terminal row is done even if the fold's
 * loaded window never saw the terminal event. Rows for tasks the fold has
 * never heard of are only added while RUNNING: the fold stays the source of
 * durable history so the tray doesn't balloon with rows from before the
 * loaded message window.
 *
 * Decoration owns the ephemeral extras for running tasks — mid-run statusText
 * ticks and reasoning phrases that are never persisted — falling back to the
 * fold's last-synced copies when absent (older desktop, or no tick yet).
 */
export const overlayDesktopThreadTasks = (
  folded: MobileTask[],
  authoritative: MobileTask[] | null,
  decoration: DesktopTaskDecoration | null,
): MobileTask[] => {
  if (!authoritative?.length && !decoration) return folded;
  const byId = new Map<string, MobileTask>();
  for (const task of folded) byId.set(task.id, task);
  for (const row of authoritative ?? []) {
    const existing = byId.get(row.id);
    if (!existing && row.status !== "running") continue;
    byId.set(row.id, {
      ...row,
      ...(row.status === "running" && existing?.statusText
        ? { statusText: existing.statusText }
        : {}),
      ...(row.status === "running" && existing?.reasoningSummaries?.length
        ? { reasoningSummaries: existing.reasoningSummaries }
        : {}),
    });
  }
  if (decoration) {
    for (const [id, task] of byId) {
      if (task.status !== "running") continue;
      const statusText = decoration.statusTextByAgentId[id];
      const reasoningSummaries = decoration.reasoningSummariesByAgentId[id];
      if (!statusText && !reasoningSummaries?.length) continue;
      byId.set(id, {
        ...task,
        ...(statusText ? { statusText } : {}),
        ...(reasoningSummaries?.length ? { reasoningSummaries } : {}),
      });
    }
  }
  const rank = (task: MobileTask) => (task.status === "running" ? 0 : 1);
  return [...byId.values()].sort(
    (a, b) =>
      rank(a) - rank(b) || b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  );
};
