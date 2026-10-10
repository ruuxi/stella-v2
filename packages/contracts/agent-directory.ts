/**
 * What `agent_status` without a thread_id returns, and how `send_message`
 * frames a message between agents. Desktop and cloud both build their
 * listing from these rows and render it here, so the model sees the same
 * shape wherever it runs.
 */

/** This conversation's orchestrator, as a `send_message` target. */
export const STELLA_MESSAGE_TARGET = "stella";

export const AGENT_MESSAGE_MAX_CHARS = 8_000;

/** Where the orchestrator's resident agent list renders. */
export const AGENT_ROSTER_DOC_PATH = "stella://context/agents";

/** Active agents listed at most; past this the rest are counted, not shown. */
export const AGENT_ROSTER_ACTIVE_LIMIT = 200;
/** Slots inactive agents fill once the active ones are listed. */
export const AGENT_ROSTER_SLOTS = 16;

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

const newestFirst = (a: AgentDirectoryAgentRow, b: AgentDirectoryAgentRow) =>
  b.updatedAt - a.updatedAt || a.threadId.localeCompare(b.threadId);

/**
 * Which agents a list shows: every active one up to the active limit, newest
 * first, then the most recent inactive ones in whatever is left of the slots.
 * 12 active leaves room for 4 inactive; 16 or more active leaves none.
 */
export const selectAgentRoster = (rows: readonly AgentDirectoryAgentRow[]) => {
  const unique = [...new Map(rows.map((row) => [row.threadId, row])).values()];
  const active = unique.filter((row) => isLive(row.status)).sort(newestFirst);
  const inactive = unique.filter((row) => !isLive(row.status)).sort(newestFirst);
  const shownActive = active.slice(0, AGENT_ROSTER_ACTIVE_LIMIT);
  const shownInactive = inactive.slice(
    0,
    Math.max(0, AGENT_ROSTER_SLOTS - shownActive.length),
  );
  return {
    active: shownActive,
    inactive: shownInactive,
    hiddenActive: active.length - shownActive.length,
    hiddenInactive: inactive.length - shownInactive.length,
  };
};

const rosterLine = (row: AgentDirectoryAgentRow, now: number): string =>
  [
    `- ${row.threadId}`,
    row.status,
    row.where,
    `last active ${formatAge(row.updatedAt, now)}`,
    ...(row.parentThreadId ? [`started by ${row.parentThreadId}`] : []),
  ].join(" · ") + `\n  ${row.description.replace(/\s+/g, " ").trim().slice(0, 200)}`;

/**
 * The orchestrator's resident agent list: a snapshot taken where its context
 * starts (thread start, each compaction), so it says when it was taken and
 * points at agent_status for a live view. Undefined when there are no agents.
 */
export const renderAgentRoster = (
  rows: readonly AgentDirectoryAgentRow[],
  now = Date.now(),
): string | undefined => {
  const roster = selectAgentRoster(rows);
  if (roster.active.length === 0 && roster.inactive.length === 0) return undefined;
  const section = (title: string, list: AgentDirectoryAgentRow[], hidden: number) =>
    list.length === 0 && hidden === 0
      ? []
      : [
          `${title}:`,
          ...list.map((row) => rosterLine(row, now)),
          ...(hidden > 0 ? [`- ${hidden} more not shown`] : []),
        ];
  return [
    `Your agents as of ${new Date(now).toISOString().slice(0, 16).replace("T", " ")} UTC. This list is refreshed when your context is compacted; agent_status without a thread_id gives a live one, and send_message reaches any thread_id here.`,
    ...section("Active", roster.active, roster.hiddenActive),
    ...section("Recent", roster.inactive, 0),
    ...(roster.hiddenInactive > 0
      ? ["Older agents are in the history."]
      : []),
  ].join("\n");
};

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
 * other conversations. Agents follow `selectAgentRoster`; older work stays
 * reachable through the history.
 */
export const buildAgentDirectoryResult = (input: {
  caller: AgentDirectoryCaller;
  agents: AgentDirectoryAgentRow[];
  sessions: AgentDirectorySessionRow[];
  now?: number;
}) => {
  const now = input.now ?? Date.now();
  const { caller } = input;
  const roster = selectAgentRoster(
    input.agents.filter(
      (row) =>
        row.conversationId === caller.conversationId &&
        row.threadId !== caller.threadId,
    ),
  );
  const kept = [...roster.active, ...roster.inactive];
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
  const hidden = roster.hiddenActive + roster.hiddenInactive;
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
 * to `thread_id`. Chat readers know a note by this framing (`isPiAgentText`
 * in `pi-chat`) and never show one sent to Stella.
 */
export const formatAgentMessage = (from: AgentMessageSender, text: string): string =>
  `<agent-message from="${escapeAttribute(from.label)}" thread_id="${escapeAttribute(
    from.threadId,
  )}">\n${text.trim()}\n</agent-message>`;
