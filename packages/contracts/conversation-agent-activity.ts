/**
 * Who is working in a conversation right now, folded from its journal.
 *
 * Both sides of the conversation socket need the same answer. The client used
 * to derive it from the records it happened to be holding, which made "what is
 * running" a function of how much transcript a device had scrolled through: an
 * agent whose `agent-started` card sat below the retained window simply did not
 * exist. The journal is the authority, so the fold lives here, next to the
 * lifecycle card contract, and the Durable Object answers from the whole
 * journal while a client folds the rows it has on top of that answer.
 *
 * Two kinds of evidence, because two placements record agents differently:
 *  - a cloud-placed turn writes `agent-lifecycle` cards;
 *  - a turn a computer ran is mirrored with its `spawn_agent` / `send_input`
 *    tool results and the hidden wake prompt (`[Agent completed]` and friends)
 *    that reported the outcome.
 * A lifecycle card always wins: when an agent has cards, its mirrored rows are
 * the same facts said less precisely.
 */

import { parseCloudAgentLifecycleCard } from "./cloud-agent-lifecycle.js";

export type AgentActivityStatus =
  | "running"
  | "completed"
  | "error"
  | "canceled";

export type AgentActivityEntry = {
  agentId: string;
  title: string;
  agentType?: string;
  status: AgentActivityStatus;
  statusText?: string;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
};

/**
 * One fold in progress. Kept open so a reader that has already scanned the
 * journal can apply later rows to it instead of scanning again.
 */
export type AgentActivityState = {
  entries: Map<string, AgentActivityEntry>;
  generations: Map<string, number>;
  carded: Set<string>;
};

/** The shape the fold needs, satisfied by every journal record type we have. */
export type AgentActivityRecordInput = {
  kind: string;
  createdAtMs: number;
  role?: string | undefined;
  hidden?: boolean | undefined;
  payload?: Record<string, unknown> | undefined;
  card?: unknown;
};

export const emptyAgentActivityState = (): AgentActivityState => ({
  entries: new Map(),
  generations: new Map(),
  carded: new Set(),
});

const WAKE_THREAD_RE =
  /^\[(?:Agent completed|Task failed|Task canceled|Subagent paused)\][\s\S]*?(?:^thread_id:\s*(\S+)|\(thread ([^)]+)\))/mu;
const WAKE_DESCRIPTION_RE =
  /^\[(?:Agent completed|Task failed|Task canceled|Subagent paused)\][\s\S]*?^description:\s*(.+)$/mu;

/**
 * The agent named by a hidden lifecycle wake prompt, with its description when
 * the prompt carried one. A mirrored turn has no lifecycle card, so this is the
 * only place such an agent's title comes from.
 */
export const lifecycleWakeTarget = (
  text: string,
): { threadId: string; description?: string } | null => {
  const match = WAKE_THREAD_RE.exec(text);
  const threadId = (match?.[1] ?? match?.[2])?.trim();
  if (!threadId) return null;
  const description = WAKE_DESCRIPTION_RE.exec(text)?.[1]?.trim();
  return description ? { threadId, description } : { threadId };
};

const WAKE_STATUS: readonly [RegExp, AgentActivityStatus][] = [
  [/^\[Agent completed\]/mu, "completed"],
  [/^\[Subagent paused\]/mu, "completed"],
  [/^\[Task failed\]/mu, "error"],
  [/^\[Task canceled\]/mu, "canceled"],
];

const wakeStatus = (text: string): AgentActivityStatus | null => {
  for (const [pattern, status] of WAKE_STATUS) {
    if (pattern.test(text)) return status;
  }
  return null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Message text, whether the payload carries a string or content blocks. */
export const agentActivityMessageText = (
  payload: Record<string, unknown> | undefined,
): string => {
  const content = payload?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) => {
      const block = asRecord(entry);
      return typeof block?.text === "string" ? block.text : "";
    })
    .join("\n");
};

/**
 * Stella's tools reach some engines under a namespaced name (Claude Code sees
 * `mcp__stella__spawn_agent`). The runtime matches on the bare name, so the
 * journal is read the same way.
 */
export const bareToolName = (name: string): string =>
  name.includes("__") ? (name.split("__").at(-1) ?? name) : name;

const toolResultThreadId = (
  payload: Record<string, unknown> | undefined,
): string | null => {
  const details = asRecord(payload?.details);
  if (typeof details?.thread_id === "string" && details.thread_id) {
    return details.thread_id;
  }
  try {
    const parsed = asRecord(JSON.parse(agentActivityMessageText(payload)));
    return typeof parsed?.thread_id === "string" && parsed.thread_id
      ? parsed.thread_id
      : null;
  } catch {
    return null;
  }
};

/**
 * A `spawn_agent` / `send_input` call waiting for its result row.
 *
 * Exposed so a long-lived reader can keep the map across folds: the call and
 * the tool result that names the agent are separate journal rows, and an
 * incremental fold would otherwise lose the call before the result arrived.
 */
export type AgentActivityToolCall = {
  name: string;
  description?: string;
  threadId?: string;
};

type ToolCall = AgentActivityToolCall;

const collectToolCalls = (
  records: readonly AgentActivityRecordInput[],
  into: Map<string, ToolCall>,
): Map<string, ToolCall> => {
  for (const record of records) {
    if (record.kind !== "message" || record.role !== "assistant") continue;
    const content = record.payload?.content;
    if (!Array.isArray(content)) continue;
    for (const entry of content) {
      const block = asRecord(entry);
      if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
      if (typeof block.name !== "string") continue;
      const args = asRecord(block.arguments);
      into.set(block.id, {
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
  return into;
};

/**
 * Folds journal rows into agent activity, in journal order. Safe to call
 * repeatedly with later rows: the state carries everything a continuation
 * needs, so a reader never rescans what it has already folded.
 */
export const foldAgentActivity = (
  state: AgentActivityState,
  records: readonly AgentActivityRecordInput[],
  options?: { toolCalls?: Map<string, ToolCall> },
): AgentActivityState => {
  for (const record of records) {
    if (record.kind !== "card") continue;
    const card = parseCloudAgentLifecycleCard(record.card);
    if (card) state.carded.add(card.event.payload.agentId);
  }
  const calls = collectToolCalls(records, options?.toolCalls ?? new Map());

  const start = (
    agentId: string,
    title: string | undefined,
    at: number,
    extra: Partial<AgentActivityEntry> = {},
  ): void => {
    const existing = state.entries.get(agentId);
    const resolvedTitle = title?.trim() || existing?.title;
    if (!resolvedTitle) return;
    state.entries.set(agentId, {
      agentId,
      title: resolvedTitle,
      status: "running",
      createdAtMs: at,
      updatedAtMs: at,
      ...(existing?.agentType ? { agentType: existing.agentType } : {}),
      ...extra,
    });
  };

  const settle = (
    agentId: string,
    status: AgentActivityStatus,
    at: number,
  ): void => {
    const existing = state.entries.get(agentId);
    if (!existing || existing.status !== "running") return;
    const { statusText: _statusText, ...rest } = existing;
    state.entries.set(agentId, {
      ...rest,
      status,
      completedAtMs: at,
      updatedAtMs: at,
    });
  };

  for (const record of records) {
    if (record.kind === "card") {
      const card = parseCloudAgentLifecycleCard(record.card);
      if (!card) continue;
      const { event } = card;
      const agentId = event.payload.agentId;
      const generation = event.payload.attemptGeneration;
      const current = state.generations.get(agentId) ?? 0;
      if (event.type === "agent-started") {
        if (generation < current) continue;
        state.generations.set(agentId, generation);
        start(agentId, event.payload.description, record.createdAtMs, {
          ...(event.payload.agentType
            ? { agentType: event.payload.agentType }
            : {}),
          ...(event.payload.statusText?.trim()
            ? { statusText: event.payload.statusText.trim() }
            : {}),
        });
        continue;
      }
      if (generation !== current) continue;
      if (event.type === "agent-progress") {
        const existing = state.entries.get(agentId);
        const statusText = event.payload.statusText.trim();
        if (existing?.status === "running" && statusText) {
          state.entries.set(agentId, {
            ...existing,
            statusText,
            updatedAtMs: record.createdAtMs,
          });
        }
        continue;
      }
      settle(
        agentId,
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
      const text = agentActivityMessageText(record.payload);
      const target = lifecycleWakeTarget(text);
      const status = wakeStatus(text);
      if (!target || !status || state.carded.has(target.threadId)) continue;
      settle(target.threadId, status, record.createdAtMs);
      continue;
    }

    if (record.role !== "toolResult" || record.payload?.isError === true) {
      continue;
    }
    const callId =
      typeof record.payload?.toolCallId === "string"
        ? record.payload.toolCallId
        : "";
    const call = calls.get(callId);
    const toolName =
      typeof record.payload?.toolName === "string"
        ? bareToolName(record.payload.toolName)
        : call?.name;
    if (toolName !== "spawn_agent" && toolName !== "send_input") continue;
    const threadId = toolResultThreadId(record.payload) ?? call?.threadId ?? null;
    if (!threadId || state.carded.has(threadId)) continue;
    if (toolName === "send_input") {
      if (state.entries.get(threadId)?.status === "running") continue;
      start(threadId, undefined, record.createdAtMs);
      continue;
    }
    const details = asRecord(record.payload?.details);
    start(
      threadId,
      call?.description ??
        (typeof details?.description === "string"
          ? details.description
          : undefined),
      record.createdAtMs,
      { agentType: "general" },
    );
  }
  return state;
};

/** Settled agents one folded state keeps for context before it forgets them. */
const MAX_SETTLED_ENTRIES = 256;
/** Unanswered tool calls one folded state holds open. */
const MAX_PENDING_TOOL_CALLS = 512;

/**
 * Bounds a fold that is kept alive across appends.
 *
 * Running agents are never dropped — they are the answer. Settled ones are kept
 * only so a later row about the same agent reads as a correction rather than a
 * new start, and the oldest-settled are the least likely to see one. The tool
 * call map is trimmed the same way: a call whose result never came is dead
 * weight after enough rows have gone by.
 */
export const trimAgentActivity = (
  state: AgentActivityState,
  toolCalls?: Map<string, AgentActivityToolCall>,
): void => {
  const settled = [...state.entries.values()].filter(
    (entry) => entry.status !== "running",
  );
  if (settled.length > MAX_SETTLED_ENTRIES) {
    settled.sort((a, b) => a.updatedAtMs - b.updatedAtMs);
    for (const entry of settled.slice(0, settled.length - MAX_SETTLED_ENTRIES)) {
      state.entries.delete(entry.agentId);
      state.generations.delete(entry.agentId);
      state.carded.delete(entry.agentId);
    }
  }
  // `carded` and `generations` are keyed by agent id and are written for every
  // lifecycle card seen, including ones whose entry was never created (a card
  // with no description cannot start a row) — so they do not shrink with the
  // entry map and would grow for the life of the fold. An id no entry mentions
  // has nothing left to correct.
  if (state.carded.size > MAX_SETTLED_ENTRIES) {
    for (const agentId of state.carded) {
      if (!state.entries.has(agentId)) state.carded.delete(agentId);
    }
  }
  if (state.generations.size > MAX_SETTLED_ENTRIES) {
    for (const agentId of state.generations.keys()) {
      if (!state.entries.has(agentId)) state.generations.delete(agentId);
    }
  }
  if (toolCalls && toolCalls.size > MAX_PENDING_TOOL_CALLS) {
    // Insertion order is journal order, so the first keys are the oldest.
    for (const key of [...toolCalls.keys()].slice(
      0,
      toolCalls.size - MAX_PENDING_TOOL_CALLS,
    )) {
      toolCalls.delete(key);
    }
  }
};

/** Every agent the journal still shows as working, oldest start first. */
export const runningAgentEntries = (
  state: AgentActivityState,
  limit?: number,
): AgentActivityEntry[] => {
  const running = [...state.entries.values()].filter(
    (entry) => entry.status === "running",
  );
  return limit !== undefined && running.length > limit
    ? running.slice(running.length - limit)
    : running;
};

/**
 * How many running agents one `ready` frame carries. A conversation with more
 * live work than this is already past the point where a list helps, and the
 * frame has a size budget to keep.
 */
export const READY_RUNNING_AGENTS_LIMIT = 64;

export const parseAgentActivityEntry = (
  value: unknown,
): AgentActivityEntry | null => {
  const raw = asRecord(value);
  if (!raw) return null;
  const agentId = typeof raw.agentId === "string" ? raw.agentId : "";
  const title = typeof raw.title === "string" ? raw.title : "";
  if (!agentId || !title) return null;
  const createdAtMs =
    typeof raw.createdAtMs === "number" && Number.isFinite(raw.createdAtMs)
      ? raw.createdAtMs
      : 0;
  const updatedAtMs =
    typeof raw.updatedAtMs === "number" && Number.isFinite(raw.updatedAtMs)
      ? raw.updatedAtMs
      : createdAtMs;
  return {
    agentId,
    title,
    status: "running",
    createdAtMs,
    updatedAtMs,
    ...(typeof raw.agentType === "string" && raw.agentType
      ? { agentType: raw.agentType }
      : {}),
    ...(typeof raw.statusText === "string" && raw.statusText.trim()
      ? { statusText: raw.statusText.trim() }
      : {}),
  };
};
