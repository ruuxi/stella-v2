import type { TaskLifecycleStatus } from "./agent-runtime";

export type AgentTitleRecord = {
  kind: string;
  role?: string;
  payload?: Record<string, unknown>;
  card?: unknown;
};

export type JournalAgent = {
  title?: string;
  status?: TaskLifecycleStatus;
};

const LIVE_THREAD_STATUSES = new Set(["running", "resuming", "waiting_for_user"]);

export const agentThreadStatus = (status: string): TaskLifecycleStatus => {
  if (LIVE_THREAD_STATUSES.has(status)) return "running";
  if (status === "completed") return "completed";
  if (status === "canceled") return "canceled";
  return "error";
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const payloadText = (payload: Record<string, unknown>): string => {
  const content = payload.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const entry = asRecord(block);
      return entry?.type === "text" && typeof entry.text === "string" ? entry.text : "";
    })
    .join("\n");
};

const parseJson = (text: string): Record<string, unknown> | null => {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
};

const WAKE_KIND_RE = /^\[(Agent completed|Task failed|Task canceled|Subagent paused)\]/m;
const WAKE_THREAD_RE =
  /^\[(?:Agent completed|Task failed|Task canceled|Subagent paused)\][\s\S]*?(?:^thread_id:\s*(\S+)|\(thread ([^)]+)\))/m;
const WAKE_DESCRIPTION_RE =
  /^\[(?:Agent completed|Task failed|Task canceled|Subagent paused)\][\s\S]*?^description:\s*(.+)$/m;
const AGENT_NOTE_RE = /^<agent-message from="([^"\n]*)" thread_id="([^"\n]*)">/;

const WAKE_STATUS: Record<string, TaskLifecycleStatus> = {
  "Agent completed": "completed",
  "Task failed": "error",
  "Task canceled": "canceled",
  "Subagent paused": "canceled",
};

const CARD_STATUS: Record<string, TaskLifecycleStatus> = {
  "agent-started": "running",
  "agent-progress": "running",
  "agent-completed": "completed",
  "agent-failed": "error",
  "agent-canceled": "canceled",
};

const LIVE_DELIVERIES = new Set(["steered", "resumed", "delivered_agent_still_working"]);

const wakeAgent = (
  text: string,
): { threadId: string; title?: string; status: TaskLifecycleStatus } | null => {
  const kind = WAKE_KIND_RE.exec(text)?.[1];
  const match = WAKE_THREAD_RE.exec(text);
  const threadId = nonEmpty(match?.[1] ?? match?.[2]);
  if (!kind || !threadId) return null;
  const title = nonEmpty(WAKE_DESCRIPTION_RE.exec(text)?.[1]);
  return { threadId, ...(title ? { title } : {}), status: WAKE_STATUS[kind] ?? "completed" };
};

export const agentNoteSender = (
  text: string,
): { threadId: string; title: string } | null => {
  const match = AGENT_NOTE_RE.exec(text.trimStart());
  const title = nonEmpty(match?.[1]);
  const threadId = nonEmpty(match?.[2]);
  if (!title || !threadId || title === "Stella") return null;
  return { threadId, title };
};

const lifecycleCard = (
  card: unknown,
): { threadId: string; title?: string; status?: TaskLifecycleStatus } | null => {
  const value = asRecord(card);
  if (value?.type !== "agent-lifecycle") return null;
  const event = asRecord(value.event);
  const payload = asRecord(event?.payload);
  const threadId = nonEmpty(payload?.agentId);
  if (!threadId || typeof event?.type !== "string") return null;
  const title = event.type === "agent-started" ? nonEmpty(payload?.description) : undefined;
  const status = CARD_STATUS[event.type];
  return { threadId, ...(title ? { title } : {}), ...(status ? { status } : {}) };
};

const resultThreadId = (
  payload: Record<string, unknown>,
  json: Record<string, unknown> | null,
  callThreadId: string | undefined,
): string | undefined =>
  nonEmpty(asRecord(payload.details)?.thread_id) ??
  (payload.toolName === "spawn_agent" || payload.toolName === "send_message"
    ? (nonEmpty(json?.thread_id) ?? callThreadId)
    : undefined);

const resultStatus = (
  payload: Record<string, unknown>,
  json: Record<string, unknown> | null,
): TaskLifecycleStatus | undefined => {
  if (payload.isError === true) return undefined;
  if (payload.toolName === "spawn_agent") return "running";
  if (payload.toolName !== "send_message") return undefined;
  const details = asRecord(payload.details);
  const delivery = nonEmpty(details?.delivered) ?? nonEmpty(json?.delivered) ?? nonEmpty(json?.status);
  return !delivery || LIVE_DELIVERIES.has(delivery) || delivery === "delivered" ? "running" : undefined;
};

export const journalAgents = (
  records: readonly AgentTitleRecord[],
): Map<string, JournalAgent> => {
  const agents = new Map<string, JournalAgent>();
  const hinted = new Map<string, string>();
  const spawnDescriptions = new Map<string, string>();
  const messageTargets = new Map<string, string>();
  const agentFor = (threadId: string): JournalAgent => {
    let agent = agents.get(threadId);
    if (!agent) {
      agent = {};
      agents.set(threadId, agent);
    }
    return agent;
  };
  const name = (threadId: string, title: string | undefined) => {
    if (title) agentFor(threadId).title = title;
  };
  const hint = (threadId: string, title: string | undefined) => {
    if (title && !hinted.has(threadId)) hinted.set(threadId, title);
  };
  const settle = (threadId: string, status: TaskLifecycleStatus | undefined) => {
    if (status) agentFor(threadId).status = status;
  };
  for (const record of records) {
    if (record.kind === "card") {
      const card = lifecycleCard(record.card);
      if (!card) continue;
      name(card.threadId, card.title);
      settle(card.threadId, card.status);
      continue;
    }
    if (record.kind !== "message" || !record.payload) continue;
    const payload = record.payload;
    if (record.role === "assistant") {
      if (!Array.isArray(payload.content)) continue;
      for (const block of payload.content) {
        const entry = asRecord(block);
        if (entry?.type !== "toolCall") continue;
        const callId = nonEmpty(entry.id);
        if (!callId) continue;
        const args = asRecord(entry.arguments);
        if (entry.name === "spawn_agent") {
          const description = nonEmpty(args?.description);
          if (description) spawnDescriptions.set(callId, description);
        } else if (entry.name === "send_message") {
          const target = nonEmpty(args?.thread_id);
          if (target) messageTargets.set(callId, target);
        }
      }
      continue;
    }
    if (record.role === "toolResult") {
      const json = parseJson(payloadText(payload));
      const callId = nonEmpty(payload.toolCallId);
      const threadId = resultThreadId(
        payload,
        json,
        callId && payload.toolName === "send_message" ? messageTargets.get(callId) : undefined,
      );
      if (!threadId) continue;
      name(
        threadId,
        nonEmpty(asRecord(payload.details)?.description) ??
          (payload.toolName === "spawn_agent" && callId
            ? spawnDescriptions.get(callId)
            : undefined),
      );
      settle(threadId, resultStatus(payload, json));
      continue;
    }
    if (record.role === "user") {
      const text = payloadText(payload);
      const wake = wakeAgent(text);
      if (wake) {
        hint(wake.threadId, wake.title);
        settle(wake.threadId, wake.status);
      }
      const note = agentNoteSender(text);
      if (note) {
        hint(note.threadId, note.title);
        settle(note.threadId, "running");
      }
    }
  }
  for (const [threadId, title] of hinted) {
    const agent = agentFor(threadId);
    if (!agent.title) agent.title = title;
  }
  return agents;
};

export const journalAgentTitles = (
  records: readonly AgentTitleRecord[],
): Map<string, string> => {
  const titles = new Map<string, string>();
  for (const [threadId, agent] of journalAgents(records)) {
    if (agent.title) titles.set(threadId, agent.title);
  }
  return titles;
};
