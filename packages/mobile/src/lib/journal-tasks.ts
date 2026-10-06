import type { AgentActivityEntry } from "@stella/contracts/conversation-agent-activity";
import type { MobileTask } from "../types";
import {
  messageText,
  type JournalMessageRecord,
  type JournalRecord,
} from "./cloud-conversation-protocol";
import { lifecycleWakeTask } from "./mobile-reply-context";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Stella's tools reach some engines under a namespaced name (Claude Code sees
 * `mcp__stella__spawn_agent`). The runtime matches on the bare name, so the
 * journal is read the same way.
 */
export const bareToolName = (name: string): string =>
  name.includes("__") ? (name.split("__").at(-1) ?? name) : name;

const WAKE_STATUS: readonly [RegExp, MobileTask["status"]][] = [
  [/^\[Agent completed\]/mu, "completed"],
  [/^\[Subagent paused\]/mu, "completed"],
  [/^\[Task failed\]/mu, "error"],
  [/^\[Task canceled\]/mu, "canceled"],
];

const wakeStatus = (text: string): MobileTask["status"] | null => {
  for (const [pattern, status] of WAKE_STATUS) {
    if (pattern.test(text)) return status;
  }
  return null;
};

const toolResultThreadId = (record: JournalMessageRecord): string | null => {
  const details = asRecord(record.payload.details);
  if (typeof details?.thread_id === "string" && details.thread_id) {
    return details.thread_id;
  }
  try {
    const parsed = asRecord(JSON.parse(messageText(record.payload)));
    return typeof parsed?.thread_id === "string" && parsed.thread_id
      ? parsed.thread_id
      : null;
  } catch {
    return null;
  }
};

type ToolCall = { name: string; description?: string; threadId?: string };

const toolCallsById = (records: readonly JournalRecord[]) => {
  const calls = new Map<string, ToolCall>();
  for (const record of records) {
    if (record.kind !== "message" || record.role !== "assistant") continue;
    const content = record.payload.content;
    if (!Array.isArray(content)) continue;
    for (const entry of content) {
      const block = asRecord(entry);
      if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
      if (typeof block.name !== "string") continue;
      const args = asRecord(block.arguments);
      calls.set(block.id, {
        name: bareToolName(block.name),
        ...(typeof args?.description === "string" && args.description.trim()
          ? { description: args.description.trim() }
          : {}),
        ...(typeof args?.thread_id === "string" && args.thread_id
          ? { threadId: args.thread_id }
          : {}),
      });
    }
  }
  return calls;
};

/**
 * Background tasks as the conversation journal records them, in journal
 * order. A cloud-placed turn writes `agent-lifecycle` cards; a turn the
 * computer ran is mirrored with only its `spawn_agent` / `send_input` results
 * and the hidden wake prompt (`[Agent completed]` and friends) that reported
 * the outcome. Both read into the same task rows, so the chat can tell what
 * is running without a live connection to the computer that runs it.
 */
/**
 * The server's running-agent snapshot as task rows.
 *
 * This is the only source that can name an agent whose start row sits below the
 * records this view holds — which, after any real time away, is most of them.
 * Marked `authoritativeRunning` so the chrome's staleness rule leaves them
 * alone: silence in the retained window is not evidence about an agent the
 * journal itself just said is working.
 */
export const agentSnapshotTasks = (
  agents: readonly AgentActivityEntry[],
): MobileTask[] =>
  agents.map((agent) => ({
    id: agent.agentId,
    title: agent.title,
    status: "running" as const,
    authoritativeRunning: true as const,
    createdAt: agent.createdAtMs,
    updatedAt: agent.updatedAtMs,
    ...(agent.agentType ? { agentType: agent.agentType } : {}),
    ...(agent.statusText ? { statusText: agent.statusText } : {}),
  }));

/**
 * Re-stamps `authoritativeRunning` after a merge.
 *
 * The merge rules prefer whichever snapshot is newer and copy only a few named
 * fields forward, so a row the server named as running can come out of a merge
 * carrying a local fold's shape instead. The server's word is about the agent,
 * not about one snapshot of it, so it is applied again afterwards — and only to
 * rows the merge still considers running, because a terminal row this device
 * genuinely saw is newer evidence than the list.
 */
export const markAuthoritativeRunning = (
  tasks: readonly MobileTask[],
  agents: readonly AgentActivityEntry[],
): MobileTask[] => {
  if (agents.length === 0) return [...tasks];
  const running = new Set(agents.map((agent) => agent.agentId));
  return tasks.map((task) =>
    task.status === "running" &&
    !task.authoritativeRunning &&
    running.has(task.id)
      ? { ...task, authoritativeRunning: true as const }
      : task,
  );
};

export const collectJournalTasks = (
  records: readonly JournalRecord[],
): MobileTask[] => {
  const carded = new Set<string>();
  for (const record of records) {
    if (record.kind === "card" && record.card.type === "agent-lifecycle") {
      carded.add(record.card.event.payload.agentId);
    }
  }
  const calls = toolCallsById(records);
  const tasks = new Map<string, MobileTask>();
  const generations = new Map<string, number>();

  const start = (
    id: string,
    title: string | undefined,
    at: number,
    extra: Partial<MobileTask> = {},
  ) => {
    const existing = tasks.get(id);
    const resolvedTitle = title?.trim() || existing?.title;
    if (!resolvedTitle) return;
    tasks.set(id, {
      id,
      title: resolvedTitle,
      status: "running",
      createdAt: at,
      updatedAt: at,
      ...(existing?.agentType ? { agentType: existing.agentType } : {}),
      ...extra,
    });
  };

  const settle = (id: string, status: MobileTask["status"], at: number) => {
    const existing = tasks.get(id);
    if (!existing || existing.status !== "running") return;
    const { statusText: _statusText, ...rest } = existing;
    tasks.set(id, { ...rest, status, completedAt: at, updatedAt: at });
  };

  for (const record of records) {
    if (record.kind === "card") {
      if (record.card.type !== "agent-lifecycle") continue;
      const { event } = record.card;
      const id = event.payload.agentId;
      const generation = event.payload.attemptGeneration;
      const current = generations.get(id) ?? 0;
      if (event.type === "agent-started") {
        if (generation < current) continue;
        generations.set(id, generation);
        start(id, event.payload.description, record.createdAtMs, {
          ...(event.payload.agentType ? { agentType: event.payload.agentType } : {}),
          ...(event.payload.statusText?.trim()
            ? { statusText: event.payload.statusText.trim() }
            : {}),
        });
        continue;
      }
      if (generation !== current) continue;
      if (event.type === "agent-progress") {
        const existing = tasks.get(id);
        const statusText = event.payload.statusText.trim();
        if (existing?.status === "running" && statusText) {
          tasks.set(id, { ...existing, statusText, updatedAt: record.createdAtMs });
        }
        continue;
      }
      settle(
        id,
        event.type === "agent-completed"
          ? "completed"
          : event.type === "agent-failed"
            ? "error"
            : "canceled",
        record.createdAtMs,
      );
      continue;
    }
    if (record.kind !== "message") continue;

    if (record.role === "user" && record.hidden) {
      const text = messageText(record.payload);
      const task = lifecycleWakeTask(text);
      const status = wakeStatus(text);
      if (!task || !status || carded.has(task.threadId)) continue;
      settle(task.threadId, status, record.createdAtMs);
      continue;
    }

    if (record.role !== "toolResult" || record.payload.isError === true) continue;
    const callId =
      typeof record.payload.toolCallId === "string" ? record.payload.toolCallId : "";
    const call = calls.get(callId);
    const toolName =
      typeof record.payload.toolName === "string"
        ? bareToolName(record.payload.toolName)
        : call?.name;
    if (toolName !== "spawn_agent" && toolName !== "send_input") continue;
    const threadId = toolResultThreadId(record) ?? call?.threadId ?? null;
    if (!threadId || carded.has(threadId)) continue;
    if (toolName === "send_input") {
      if (tasks.get(threadId)?.status === "running") continue;
      start(threadId, undefined, record.createdAtMs);
      continue;
    }
    const details = asRecord(record.payload.details);
    start(
      threadId,
      call?.description ??
        (typeof details?.description === "string" ? details.description : undefined),
      record.createdAtMs,
      { agentType: "general" },
    );
  }

  return [...tasks.values()];
};
