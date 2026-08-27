import type { TaskLifecycleStatus } from "@stella/contracts/agent-runtime";

export const MAX_ACTIVE_RUNTIME_THREADS = 16;

export const MAX_GROUP_MEMBER_THREADS = 8;

export const THREAD_GROUP_KEY_PREFIX = "grp-";

export type RuntimeThreadRecord = {
  conversationId: string;
  threadId: string;
  name: string;
  agentType: string;

  status: "active" | "evicted";
  createdAt: number;
  lastUsedAt: number;

  agentStatus?: TaskLifecycleStatus;

  agentUpdatedAt?: number;
  description?: string;
  summary?: string;
};

export type RuntimeThreadLiveState = "active" | "paused";

export const deriveRuntimeThreadLiveState = (
  record: Pick<RuntimeThreadRecord, "agentStatus">,
): RuntimeThreadLiveState =>
  record.agentStatus === "running" ? "active" : "paused";

export const runtimeThreadLastActiveAt = (
  record: Pick<RuntimeThreadRecord, "lastUsedAt" | "agentUpdatedAt">,
): number => Math.max(record.lastUsedAt, record.agentUpdatedAt ?? 0);

export const formatRuntimeThreadStatusLabel = (
  record: Pick<RuntimeThreadRecord, "agentStatus">,
): string => {
  if (deriveRuntimeThreadLiveState(record) === "active") return "active";
  return record.agentStatus === "error"
    ? "paused (last run errored)"
    : "paused";
};

export const formatRuntimeThreadStatusSuffix = (
  record: Pick<
    RuntimeThreadRecord,
    "agentStatus" | "lastUsedAt" | "agentUpdatedAt"
  >,
  now = Date.now(),
): string =>
  `${formatRuntimeThreadStatusLabel(record)}, last active ${formatRuntimeThreadAge(
    runtimeThreadLastActiveAt(record),
    now,
  )}`;

export const normalizeRuntimeThreadId = (value: string): string | undefined => {

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const estimateRuntimeTokens = (value: string): number => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Math.max(1, Math.ceil(trimmed.length / 4)) : 0;
};

export const formatRuntimeThreadAge = (
  timestamp: number,
  now = Date.now(),
): string => {
  const ageMs = Math.max(0, now - timestamp);
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return `${Math.floor(ageMs / 86_400_000)}d ago`;
};

const formatPromptValue = (
  value: string | undefined,
  fallback: string,
): string => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\s+/g, " ").slice(0, 180) : fallback;
};

const formatThreadLines = (
  thread: RuntimeThreadRecord,
  now: number,
  indent: string,
): string => {
  const summary = formatPromptValue(thread.summary, "");
  return [
    `${indent}- ${thread.threadId} (${formatRuntimeThreadStatusSuffix(thread, now)})`,
    `${indent}  description: ${formatPromptValue(
      thread.description ??
        (thread.name !== thread.threadId ? thread.name : undefined),
      "No description recorded",
    )}`,
    ...(summary ? [`${indent}  summary: ${summary}`] : []),
  ].join("\n");
};

export const buildActiveThreadsPrompt = (
  threads: RuntimeThreadRecord[],
  now = Date.now(),
): string => {
  if (threads.length === 0) return "";
  const ordered = [...threads]
    .sort(
      (a, b) =>
        runtimeThreadLastActiveAt(b) - runtimeThreadLastActiveAt(a) ||
        a.threadId.localeCompare(b.threadId),
    )
    .slice(0, MAX_ACTIVE_RUNTIME_THREADS);
  return `# Other Threads\nDurable past and ongoing work. Each entry shows its live state: "active" means the agent is executing a turn right now; "paused" means idle but resumable. Any thread_id can be reused later with send_input, even after cancellation or completion. Older work not listed here is searchable with Recall.\n${ordered
    .map((thread) => formatThreadLines(thread, now, ""))
    .join("\n")}`;
};
