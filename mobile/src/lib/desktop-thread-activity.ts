import type { MobileTask } from "../types";

const TASK_STATUSES = new Set(["running", "completed", "error", "canceled"]);
const ACTIVITY_AGENT_TYPES = new Set(["general", "manager"]);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

/**
 * Parse the authoritative desktop Activity projection without discarding
 * Manager ownership rows. The presentation layer keeps root Managers and uses
 * those rows to remove their General-agent descendants.
 */
export function parseThreadActivityTasks(value: unknown): MobileTask[] {
  if (!Array.isArray(value)) return [];
  const tasks: MobileTask[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const agentType = asString(record.agentType).trim();
    if (!ACTIVITY_AGENT_TYPES.has(agentType)) continue;
    const id = asString(record.threadId).trim();
    const parentAgentId = asString(record.parentAgentId).trim();
    const status = record.status;
    if (!id || typeof status !== "string" || !TASK_STATUSES.has(status)) {
      continue;
    }
    const title = asString(record.description).trim() || "Background work";
    const startedAt =
      typeof record.startedAt === "number" && Number.isFinite(record.startedAt)
        ? record.startedAt
        : 0;
    const completedAt =
      typeof record.completedAt === "number" &&
      Number.isFinite(record.completedAt)
        ? record.completedAt
        : undefined;
    tasks.push({
      id,
      title,
      agentType,
      ...(parentAgentId ? { parentAgentId } : {}),
      status: status as MobileTask["status"],
      createdAt: startedAt,
      ...(status !== "running" && completedAt !== undefined
        ? { completedAt }
        : {}),
    });
  }
  return tasks;
}
