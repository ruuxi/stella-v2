import { getActivityRowCompletedAtMs, getActivityRowSearchText, getActivityRowStatus, groupActivityTasks, } from "@/features/chat/lib/event-transforms";
const appendCompletedRow = (row, depth, items) => {
    if (row.kind === "task") {
        items.push({ kind: "done", task: row.task, depth });
        return;
    }
    items.push({ kind: "doneHierarchy", hierarchy: row.hierarchy, depth });
    for (const child of row.hierarchy.children) {
        appendCompletedRow(child, depth + 1, items);
    }
};

export function buildCompletedActivityList(tasks, needle = "") {
    const normalizedNeedle = needle.trim().toLowerCase();
    const roots = groupActivityTasks(tasks)
        .filter((row) => getActivityRowStatus(row) !== "running")
        .filter((row) => !normalizedNeedle ||
        getActivityRowSearchText(row).toLowerCase().includes(normalizedNeedle))
        .sort((a, b) => getActivityRowCompletedAtMs(b) - getActivityRowCompletedAtMs(a));
    const items = [];
    for (const row of roots)
        appendCompletedRow(row, 0, items);
    return items;
}
