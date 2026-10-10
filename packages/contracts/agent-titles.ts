export type AgentTitleRecord = {
  kind: string;
  role?: string;
  payload?: Record<string, unknown>;
  card?: unknown;
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

const WAKE_THREAD_RE =
  /^\[(?:Agent completed|Task failed|Task canceled|Subagent paused)\][\s\S]*?(?:^thread_id:\s*(\S+)|\(thread ([^)]+)\))/m;
const WAKE_DESCRIPTION_RE =
  /^\[(?:Agent completed|Task failed|Task canceled|Subagent paused)\][\s\S]*?^description:\s*(.+)$/m;
const AGENT_NOTE_RE = /^<agent-message from="([^"\n]*)" thread_id="([^"\n]*)">/;

const wakeTitle = (text: string): { threadId: string; title: string } | null => {
  const match = WAKE_THREAD_RE.exec(text);
  const threadId = nonEmpty(match?.[1] ?? match?.[2]);
  const title = nonEmpty(WAKE_DESCRIPTION_RE.exec(text)?.[1]);
  return threadId && title ? { threadId, title } : null;
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

const startCardTitle = (card: unknown): { threadId: string; title: string } | null => {
  const value = asRecord(card);
  if (value?.type !== "agent-lifecycle") return null;
  const event = asRecord(value.event);
  if (event?.type !== "agent-started") return null;
  const payload = asRecord(event.payload);
  const threadId = nonEmpty(payload?.agentId);
  const title = nonEmpty(payload?.description);
  return threadId && title ? { threadId, title } : null;
};

const resultThreadId = (payload: Record<string, unknown>): string | undefined => {
  const fromDetails = nonEmpty(asRecord(payload.details)?.thread_id);
  if (fromDetails) return fromDetails;
  if (payload.toolName !== "spawn_agent") return undefined;
  try {
    return nonEmpty(asRecord(JSON.parse(payloadText(payload)))?.thread_id);
  } catch {
    return undefined;
  }
};

export const journalAgentTitles = (
  records: readonly AgentTitleRecord[],
): Map<string, string> => {
  const named = new Map<string, string>();
  const hinted = new Map<string, string>();
  const spawnDescriptions = new Map<string, string>();
  const hint = (entry: { threadId: string; title: string } | null) => {
    if (entry && !hinted.has(entry.threadId)) hinted.set(entry.threadId, entry.title);
  };
  for (const record of records) {
    if (record.kind === "card") {
      const started = startCardTitle(record.card);
      if (started) named.set(started.threadId, started.title);
      continue;
    }
    if (record.kind !== "message" || !record.payload) continue;
    const payload = record.payload;
    if (record.role === "assistant") {
      if (!Array.isArray(payload.content)) continue;
      for (const block of payload.content) {
        const entry = asRecord(block);
        if (entry?.type !== "toolCall" || entry.name !== "spawn_agent") continue;
        const callId = nonEmpty(entry.id);
        const description = nonEmpty(asRecord(entry.arguments)?.description);
        if (callId && description) spawnDescriptions.set(callId, description);
      }
      continue;
    }
    if (record.role === "toolResult") {
      const threadId = resultThreadId(payload);
      if (!threadId) continue;
      const callId = nonEmpty(payload.toolCallId);
      const title =
        nonEmpty(asRecord(payload.details)?.description) ??
        (payload.toolName === "spawn_agent" && callId
          ? spawnDescriptions.get(callId)
          : undefined);
      if (title) named.set(threadId, title);
      continue;
    }
    if (record.role === "user") {
      const text = payloadText(payload);
      hint(wakeTitle(text));
      hint(agentNoteSender(text));
    }
  }
  for (const [threadId, title] of hinted) {
    if (!named.has(threadId)) named.set(threadId, title);
  }
  return named;
};
