import {
  getActivityRowCompletedAtMs,
  getActivityRowSearchText,
  getActivityRowStatus,
  groupActivityTasks,
  type ActivityRow,
  type TaskHierarchy,
  type TaskItem,
} from "@/features/chat/lib/event-transforms";

export type CompletedActivityItem =
  | { kind: "done"; task: TaskItem; depth: number }
  | { kind: "doneHierarchy"; hierarchy: TaskHierarchy; depth: number };

const appendCompletedRow = (
  row: ActivityRow,
  depth: number,
  items: CompletedActivityItem[],
) => {
  if (row.kind === "task") {
    items.push({ kind: "done", task: row.task, depth });
    return;
  }
  items.push({ kind: "doneHierarchy", hierarchy: row.hierarchy, depth });
  for (const child of row.hierarchy.children) {
    appendCompletedRow(child, depth + 1, items);
  }
};
/**
 * Build the Completed dialog from the full ownership projection, then select
 * terminal roots. Filtering tasks before nesting would orphan a completed
 * child whose owner is still running and make it reappear as a top-level
 * history row.
 */
export function buildCompletedActivityList(
  tasks: readonly TaskItem[],
  needle = "",
): CompletedActivityItem[] {
  const normalizedNeedle = needle.trim().toLowerCase();
  const roots = groupActivityTasks(tasks)
    .filter((row) => getActivityRowStatus(row) !== "running")
    .filter(
      (row) =>
        !normalizedNeedle ||
        getActivityRowSearchText(row).toLowerCase().includes(normalizedNeedle),
    )
    .sort(
      (a, b) => getActivityRowCompletedAtMs(b) - getActivityRowCompletedAtMs(a),
    );
  const items: CompletedActivityItem[] = [];
  for (const row of roots) appendCompletedRow(row, 0, items);
  return items;
}
