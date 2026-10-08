/**
 * What `agent_status` without a thread_id returns, and how `send_message`
 * frames a message between agents. Desktop and cloud both build their
 * listing from these rows and render it here, so the model sees the same
 * shape wherever it runs.
 */

/** This conversation's orchestrator, as a `send_message` target. */
export const STELLA_MESSAGE_TARGET = "stella";

export const AGENT_MESSAGE_MAX_CHARS = 8_000;

const DIRECTORY_AGENT_LIMIT = 24;
const DIRECTORY_SESSION_LIMIT = 10;

export type AgentDirectoryStatus =
  | "running"
  | "waiting"
  | "paused"
  | "completed"
  | "failed"
  | "canceled";

export type AgentDirectoryAgentRow = {
  threadId: string;
  conversationId: string;
  parentThreadId?: string;
  description: string;
  status: AgentDirectoryStatus;
  /** "this computer", "cloud", or a device's name. */
  where: string;
  updatedAt: number;
};

export type AgentDirectorySessionRow = {
  /** The conversation id, which is also its Stella's thread id. */
  conversationId: string;
  title: string;
  active: boolean;
  /** "this computer" for a local-only chat, "cloud" for a synced one. */
  where: string;
  updatedAt: number;
};

export type AgentDirectoryCaller = {
  conversationId: string;
  /** Absent when the caller is Stella itself. */
  threadId?: string;
  parentThreadId?: string;
};

export type AgentDirectoryStatusValue = string | undefined | null;

/** Collapses the hosts' status vocabularies into the directory's. */
export const normalizeAgentDirectoryStatus = (
  status: AgentDirectoryStatusValue,
): AgentDirectoryStatus => {
  switch (status) {
    case "running":
    case "resuming":
    case "queued":
    case "pending":
      return "running";
    case "waiting_for_user":
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "canceled":
    case "cancelled":
      return "canceled";
    default:
      return "paused";
  }
};

const formatAge = (timestamp: number, now: number): string => {
  const ageMs = Math.max(0, now - timestamp);
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return `${Math.floor(ageMs / 86_400_000)}d ago`;
};

const isLive = (status: AgentDirectoryStatus) =>
  status === "running" || status === "waiting";

const agentEntry = (row: AgentDirectoryAgentRow, now: number) => ({
  thread_id: row.threadId,
  description: row.description,
  status: row.status,
  where: row.where,
  last_active: formatAge(row.updatedAt, now),
  ...(row.parentThreadId ? { started_by: row.parentThreadId } : {}),
});

/**
 * The model-facing listing. Agents are this conversation's; sessions are the
 * other conversations. Every live agent is kept, then the newest others up to
 * the cap; older work stays reachable through the history.
 */
export const buildAgentDirectoryResult = (input: {
  caller: AgentDirectoryCaller;
  agents: AgentDirectoryAgentRow[];
  sessions: AgentDirectorySessionRow[];
  now?: number;
}) => {
  const now = input.now ?? Date.now();
  const { caller } = input;
  const seen = new Set<string>();
  const agents = input.agents
    .filter((row) => {
      if (row.conversationId !== caller.conversationId) return false;
      if (row.threadId === caller.threadId || seen.has(row.threadId)) return false;
      seen.add(row.threadId);
      return true;
    })
    .sort(
      (a, b) =>
        Number(isLive(b.status)) - Number(isLive(a.status)) ||
        b.updatedAt - a.updatedAt ||
        a.threadId.localeCompare(b.threadId),
    );
  const kept = agents.filter(
    (row, index) => isLive(row.status) || index < DIRECTORY_AGENT_LIMIT,
  );
  const isOwn = (row: AgentDirectoryAgentRow) =>
    caller.threadId
      ? row.parentThreadId === caller.threadId
      : !row.parentThreadId;
  const subagents = kept.filter(isOwn).map((row) => agentEntry(row, now));
  const teammates = kept
    .filter((row) => !isOwn(row))
    .map((row) => ({
      ...agentEntry(row, now),
      ...(row.threadId === caller.parentThreadId ? { relation: "started you" } : {}),
    }));
  const sessions = input.sessions
    .filter((row) => row.conversationId !== caller.conversationId)
    .sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt - a.updatedAt)
    .slice(0, DIRECTORY_SESSION_LIMIT)
    .map((row) => ({
      thread_id: row.conversationId,
      title: row.title.trim() || "Untitled chat",
      status: row.active ? "running" : "idle",
      where: row.where,
      last_active: formatAge(row.updatedAt, now),
    }));
  const hidden = agents.length - kept.length;
  return {
    you: caller.threadId
      ? { thread_id: caller.threadId }
      : { thread_id: caller.conversationId, role: "Stella for this conversation" },
    ...(caller.threadId
      ? {
          stella: {
            thread_id: caller.conversationId,
            note: `Stella for this conversation; "${STELLA_MESSAGE_TARGET}" also reaches it.`,
          },
        }
      : {}),
    subagents,
    teammates,
    sessions,
    note: `Message any thread_id here with send_message.${
      hidden > 0 ? ` ${hidden} older agent${hidden === 1 ? "" : "s"} not shown; find them in the history.` : ""
    }`,
  };
};

export type AgentMessageSender = {
  /** The sender's thread id; the conversation id when it is Stella. */
  threadId: string;
  /** "Stella", or the sending agent's description. */
  label: string;
};

const escapeAttribute = (value: string) =>
  value.replace(/[\r\n]+/g, " ").replace(/"/g, "'").trim().slice(0, 200);

/**
 * A message from another agent, as the receiver reads it. It is a peer's
 * note, never the user's instruction; the receiver answers with send_message
 * to `thread_id`.
 */
export const formatAgentMessage = (from: AgentMessageSender, text: string): string =>
  `<agent-message from="${escapeAttribute(from.label)}" thread_id="${escapeAttribute(
    from.threadId,
  )}">\n${text.trim()}\n</agent-message>`;
