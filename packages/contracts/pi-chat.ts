/**
 * Stella's chat on pi-durable, as its clients see it.
 *
 * The host watches a conversation with pi-durable's `watchEvents` and passes
 * the event batches through unchanged: a `snapshot` when a client attaches,
 * then one batch per commit. Every client folds them with `reducePiChat` into
 * the same `PiChatState`: the transcript's entries, the run, the assistant
 * message in flight and the tools running.
 *
 * The types are structural copies of the pi-durable and pi-ai shapes clients
 * read, so this module stays dependency-free.
 */

/**
 * Whether the desktop's chat runs on pi-durable: unless the user's engine is
 * Claude Code, whose turns keep their own path.
 */
export const desktopPiChatEnabled = (engine: string | undefined): boolean => engine !== "claude_code_local";

/**
 * Stella's marks on a part of a user message. Providers read only a part's
 * `type`, `text` and `data`, so the model never sees them.
 */
export type PiPartMarks = {
  /** Model input the user did not type: context, attachment notices, images sized for the model. */
  hidden?: true;
  /** How the user's message shows besides its text; one part carries it. */
  display?: PiUserDisplay;
  /**
   * The id the sending client gave the message (a phone's, for a chat it
   * placed on a computer). Its journal row keeps it, so that client's
   * pending message binds to the row instead of showing twice.
   */
  clientMsgId?: string;
  /** A prompt a schedule fired: read by Stella, not shown, and answered in the chat. */
  source?: "schedule";
};

export type PiUserDisplay = {
  /** What the user attached: image previews and file references. */
  attachments?: Array<{
    kind: "image" | "file";
    name?: string;
    mimeType?: string;
    size?: number;
    url?: string;
    path?: string;
  }>;
  /** The context the composer sent along: app selection, activity, quoted and pasted text. */
  context?: Record<string, unknown>;
};

export type PiContentBlock =
  | { type: "text"; text: string; stella?: PiPartMarks }
  | { type: "thinking"; thinking: string }
  | { type: "image"; data: string; mimeType: string; stella?: PiPartMarks }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

/** A part of a user message: text or an image, maybe marked. */
export type PiUserPart = Extract<PiContentBlock, { type: "text" } | { type: "image" }>;

/** What a voice session wrote: what was said, or the session's summary (`voiceSession`). */
export type PiVoiceMarks = { source?: "voice"; voiceSession?: { durationMs: number } };

export type PiUserMessage = {
  role: "user";
  content: string | PiContentBlock[];
  timestamp: number;
  /** `schedule`: a schedule's prompt, as the journal and the cloud mark it. */
  source?: "voice" | "schedule";
} & Omit<PiVoiceMarks, "source">;
export type PiAssistantMessage = {
  role: "assistant";
  content: PiContentBlock[];
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  timestamp: number;
  /** Model history the timeline leaves out (what the voice model said). */
  stella?: { hidden?: true };
} & PiVoiceMarks;
export type PiToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: PiContentBlock[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
};
export type PiMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage | { role: "system"; content: unknown };

/** One transcript entry: `pi.user`, `pi.assistant`, `pi.tool-result`, `pi.system`, `pi.compaction`, ... */
export type PiEntry = {
  id: number;
  conversationId: number;
  kind: string;
  model?: PiMessage[];
  data?: unknown;
  head?: number;
};

export type PiToolSlot = {
  callId: string;
  name: string;
  status: "pending" | "running" | "done";
  output?: string;
  entry?: number;
};

export type PiMessageChange =
  | { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; block: PiContentBlock }
  | { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_delta"; contentIndex: number; path: (string | number)[]; delta: string }
  | { type: "block"; contentIndex: number; block: PiContentBlock }
  | { type: "message"; message: PiAssistantMessage };

export type PiSubmission = {
  id: number;
  type: "input" | "write";
  requestId?: string;
  status: "queued" | "placed" | "done" | "unanswered";
  entry?: number;
  answer?: number;
  reason?: string;
};

/** pi-durable's agent events (spec §9.4); clients ignore the kinds they do not read. */
export type PiChatEvent =
  | {
      type: "snapshot";
      entries: PiEntry[];
      run?: { inputs: number[] };
      generation?: { attempt: number; message?: PiAssistantMessage; retry?: { at: number; error: string } };
      tools: PiToolSlot[];
      inbox: { id: number; mode: string }[];
    }
  | { type: "run_start"; inputs: number[] }
  | { type: "run_end"; inputs: number[] }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "message_start"; message: PiMessage }
  | { type: "message_update"; changes: PiMessageChange[] }
  | { type: "message_end"; entry: PiEntry }
  | { type: "entry_appended"; entry: PiEntry }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      output?: { trimStart?: number; append?: string } | { set: string };
    }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; entry?: PiEntry }
  | { type: "submission"; record: PiSubmission }
  | { type: "auto_retry_start"; attempt: number; at: number; errorMessage: string }
  | { type: "auto_retry_end"; attempt: number }
  | { type: "task_failed"; taskId: number; kind: string; message: string }
  | { type: "compaction_start"; reason: string; blocking: boolean }
  | { type: "compaction_end"; reason: string }
  /** Stella's turns another writer is running (the cloud, another computer), from the journal. */
  | { type: "remote_turns"; turns: PiRemoteTurn[] };

/** A turn of the conversation running elsewhere, which the journal shows as started. */
export type PiRemoteTurn = {
  turnId: string;
  /** Its prompt row's client id: a placement's dispatch id when one placed it. */
  clientMsgId?: string;
};

// ---- host ↔ client requests --------------------------------------------------

/** The rest of a desktop composer send (`RuntimeChatPayload`), which the runtime prepares for the model. */
export type PiChatSend = {
  selectedText?: string | null;
  chatContext?: unknown;
  attachments?: unknown[];
  deviceId?: string;
  platform?: string;
  timezone?: string;
  locale?: string;
  mode?: string;
  messageMetadata?: Record<string, unknown>;
  agentType?: string;
  /** Where the conversation is stored; a conversation kept here only runs here. */
  storageMode?: "cloud" | "local";
  /** Where the user asked this message to run (the composer's destination). */
  executionTarget?: { mode: "automatic" } | { mode: "cloud" } | { mode: "device"; deviceId: string };
  /** Where the conversation's Stella runs could not take this send, so this computer answers it, as with no record. */
  followSender?: boolean;
};

/** A send that went to run elsewhere: its turn comes back through the journal. */
export type PiChatPlacedResult = {
  placed: {
    /** The host's run for the placement, which stops it (`agent.cancelChat`). */
    runId: string;
    /** The id its journal row carries, which the pending message binds to. */
    userMessageId: string;
  };
};

export type PiChatRequest =
  | { op: "submit"; conversationId: string; requestId: string; text: string; send?: PiChatSend }
  /** Stop the conversation's run here, and the placed turns it runs elsewhere (their dispatch ids). */
  | { op: "abort"; conversationId: string; dispatchIds?: string[] }
  | { op: "watch"; conversationId: string }
  | { op: "unwatch"; conversationId: string }
  | { op: "older"; conversationId: string; beforeEntryId: number }
  | { op: "agents"; conversationId: string }
  /** A turn was placed elsewhere: follow the journal closely until it shows. */
  | { op: "follow"; conversationId: string }
  /** Stella's greeting after onboarding, as a reply in the conversation; kept on this computer. */
  | { op: "welcome"; conversationId: string; message: string }
  /** The local files Stella's replies and its agents linked (`{ paths }`): what a paired phone may open. */
  | { op: "files"; conversationId: string }
  /**
   * Where the conversation's brain runs (`PiChatBrainResult`): a send for a
   * conversation whose Stella runs elsewhere is placed there.
   */
  | { op: "brain"; conversationId: string };

/**
 * Where a conversation's Stella runs (`@stella/contracts/turn-plane/pi-brain`):
 * here, or where a send is placed instead.
 */
export type PiChatBrainResult =
  | { here: true }
  | { here: false; target: { mode: "cloud" } | { mode: "device"; deviceId: string }; label?: string };

/**
 * The model calls of the conversations on pi, as the usage dashboard lists
 * them (`LocalModelUsagePage`). Sent by the desktop's main process, not by a
 * window, so it names no conversation it acts on.
 */
export type PiChatUsageRequest = {
  op: "usage";
  fromMs?: number;
  toMs?: number;
  conversationId?: string;
  threadId?: string;
  limit?: number;
};

export type PiChatWatchResult = {
  /** The snapshot, its entries widened to the latest page of the whole history. */
  snapshot: Extract<PiChatEvent, { type: "snapshot" }>;
  hasOlder: boolean;
  remote?: PiRemoteTurn[];
};

export type PiChatOlderResult = { entries: PiEntry[]; hasOlder: boolean };

/** One of a conversation's agents, as the app lists it (`agents`). */
export type PiChatAgent = {
  threadId: string;
  description: string;
  status: "running" | "completed" | "error";
  startedAt: number;
  updatedAt: number;
  /** Its latest prose, oldest first. */
  assistantMessages: string[];
  error?: string;
};

export type PiChatAgentsResult = { agents: PiChatAgent[] };

export type PiChatEventsPayload = { conversationId: string; events: PiChatEvent[] };

// ---- the client state ----------------------------------------------------------

export type PiChatState = {
  /** Transcript entries, ascending by id. */
  entries: PiEntry[];
  hasOlder: boolean;
  running: boolean;
  /** The assistant message being generated. */
  streaming?: PiAssistantMessage;
  /** Tools of the current run by call id. */
  tools: Record<string, { name: string; status: PiToolSlot["status"]; output?: string }>;
  /** Client request ids by the user entry each became. */
  requestIds: Record<number, string>;
  /** Request ids pi has admitted but not yet placed in the transcript. */
  queued: string[];
  retry?: { at: number; error: string };
  /** The last task failure of the current run. */
  failure?: string;
  compacting: boolean;
  /** Turns running elsewhere (`remote_turns`). */
  remote: PiRemoteTurn[];
};

export const emptyPiChat = (): PiChatState => ({
  entries: [],
  hasOlder: false,
  running: false,
  tools: {},
  requestIds: {},
  queued: [],
  compacting: false,
  remote: [],
});

/** Entries merged by id, ascending. */
export const mergePiEntries = (entries: readonly PiEntry[], more: readonly PiEntry[]): PiEntry[] => {
  if (more.length === 0) return entries as PiEntry[];
  const byId = new Map<number, PiEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  for (const entry of more) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => a.id - b.id);
};

const appendEntry = (entries: PiEntry[], entry: PiEntry): PiEntry[] => {
  const last = entries[entries.length - 1];
  if (!last || last.id < entry.id) return [...entries, entry];
  return mergePiEntries(entries, [entry]);
};

const applyChange = (message: PiAssistantMessage, change: PiMessageChange): PiAssistantMessage => {
  if (change.type === "message") return change.message;
  const content = [...message.content];
  const at = change.contentIndex;
  switch (change.type) {
    case "text_start":
    case "thinking_start":
    case "toolcall_start":
    case "block":
      content[at] = change.block;
      break;
    case "text_delta": {
      const block = content[at];
      content[at] = { type: "text", text: (block?.type === "text" ? block.text : "") + change.delta };
      break;
    }
    case "thinking_delta": {
      const block = content[at];
      content[at] = { type: "thinking", thinking: (block?.type === "thinking" ? block.thinking : "") + change.delta };
      break;
    }
    case "toolcall_delta":
      // Arguments stream as JSON fragments; the finished block replaces them.
      return message;
  }
  return { ...message, content };
};

const toolOutput = (
  previous: string | undefined,
  output: Extract<PiChatEvent, { type: "tool_execution_update" }>["output"],
): string | undefined => {
  if (!output) return previous;
  if ("set" in output) return output.set;
  const kept = (previous ?? "").slice(output.trimStart ?? 0);
  return kept + (output.append ?? "");
};

const reduceOne = (state: PiChatState, event: PiChatEvent): PiChatState => {
  switch (event.type) {
    case "snapshot": {
      const tools: PiChatState["tools"] = {};
      for (const slot of event.tools) {
        tools[slot.callId] = { name: slot.name, status: slot.status, ...(slot.output ? { output: slot.output } : {}) };
      }
      // The snapshot names no request ids, so a live run keeps what this watch
      // saw queued; an idle pi with an empty inbox has nothing queued or
      // compacting, whatever finished while nobody watched.
      const idle = event.run === undefined;
      return {
        ...state,
        entries: mergePiEntries(state.entries, event.entries),
        running: !idle,
        ...(idle && event.inbox.length === 0 ? { queued: [] } : {}),
        ...(idle ? { compacting: false } : {}),
        ...(event.generation?.message ? { streaming: event.generation.message } : { streaming: undefined }),
        ...(event.generation?.retry ? { retry: event.generation.retry } : { retry: undefined }),
        tools,
      };
    }
    case "run_start":
      return { ...state, running: true, failure: undefined, tools: {} };
    case "run_end":
      return { ...state, running: false, streaming: undefined, retry: undefined, compacting: false };
    case "message_start":
      return event.message.role === "assistant" ? { ...state, streaming: event.message } : state;
    case "message_update": {
      if (!state.streaming) return state;
      let streaming = state.streaming;
      for (const change of event.changes) streaming = applyChange(streaming, change);
      return { ...state, streaming };
    }
    case "message_end":
      return {
        ...state,
        entries: appendEntry(state.entries, event.entry),
        ...(event.entry.kind === "pi.assistant" ? { streaming: undefined, retry: undefined } : {}),
      };
    case "entry_appended":
      return { ...state, entries: appendEntry(state.entries, event.entry) };
    case "tool_execution_start":
      return { ...state, tools: { ...state.tools, [event.toolCallId]: { name: event.toolName, status: "running" } } };
    case "tool_execution_update": {
      const slot = state.tools[event.toolCallId];
      const output = toolOutput(slot?.output, event.output);
      return {
        ...state,
        tools: {
          ...state.tools,
          [event.toolCallId]: { name: event.toolName, status: slot?.status ?? "running", ...(output ? { output } : {}) },
        },
      };
    }
    case "tool_execution_end":
      return {
        ...state,
        entries: event.entry ? appendEntry(state.entries, event.entry) : state.entries,
        tools: { ...state.tools, [event.toolCallId]: { name: event.toolName, status: "done" } },
      };
    case "submission": {
      const { record } = event;
      if (record.type !== "input" || !record.requestId) return state;
      const requestId = record.requestId;
      const queued = record.status === "queued"
        ? state.queued.includes(requestId) ? state.queued : [...state.queued, requestId]
        : state.queued.filter((id) => id !== requestId);
      const requestIds = record.entry !== undefined && state.requestIds[record.entry] !== requestId
        ? { ...state.requestIds, [record.entry]: requestId }
        : state.requestIds;
      return { ...state, queued, requestIds };
    }
    case "remote_turns":
      return { ...state, remote: event.turns };
    case "auto_retry_start":
      return { ...state, retry: { at: event.at, error: event.errorMessage } };
    case "auto_retry_end":
      return { ...state, retry: undefined };
    case "task_failed":
      return { ...state, failure: event.message };
    case "compaction_start":
      return event.blocking ? { ...state, compacting: true } : state;
    case "compaction_end":
      return { ...state, compacting: false };
    default:
      return state;
  }
};

/** Fold one batch of events into the state. */
export const reducePiChat = (state: PiChatState, events: readonly PiChatEvent[]): PiChatState => {
  let next = state;
  for (const event of events) next = reduceOne(next, event);
  return next;
};

/** The text of a message's text blocks. */
export const piMessageText = (message: PiMessage | undefined): string => {
  if (!message || message.role === "system") return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
};

/** An agent's report, which arrives as user input the user never wrote. */
export const PI_REPORT_RE = /^\[(Agent completed|Task failed|Task canceled|Subagent paused)\]/;
const LEADING_SYSTEM_REMINDER_RE = /^<system-reminder>[\s\S]*?<\/system-reminder>\s*/;

/**
 * A note an agent sent with `send_message`, as `formatAgentMessage`
 * (`agent-directory`) frames it: the whole text, not a message that quotes one.
 */
const AGENT_NOTE_RE = /^<agent-message from="[^"\n]*" thread_id="[^"\n]*">\n[\s\S]*\n<\/agent-message>$/;

/** Text from Stella's agents, not the user: an agent's report, or a note an agent sent. */
export const PI_LATE_ANSWER_PREFIX = "[Late answer]";

export const isPiAgentText = (text: string): boolean => {
  const body = text.trimStart().replace(LEADING_SYSTEM_REMINDER_RE, "");
  return (
    PI_REPORT_RE.test(body) ||
    body.startsWith(PI_LATE_ANSWER_PREFIX) ||
    AGENT_NOTE_RE.test(text.trim())
  );
};

/**
 * A user message an agent sent: one of its text parts is a report or a note.
 * Readers hide it, and show Stella's answer to it.
 */
export const isPiAgentInput = (message: PiUserMessage): boolean =>
  typeof message.content === "string"
    ? isPiAgentText(message.content)
    : message.content.some((part) => part.type === "text" && isPiAgentText(part.text));

/**
 * A prompt a schedule fired (a task, a reminder): runtime input the user never
 * wrote. Readers hide it, and show Stella's answer to it, which is the delivery.
 */
export const isPiScheduledInput = (message: PiUserMessage): boolean =>
  message.source === "schedule" ||
  (typeof message.content !== "string" &&
    message.content.some((part) => (part.type === "text" || part.type === "image") && part.stella?.source === "schedule"));

/**
 * Whether readers hide a user message: one the user never wrote (an agent's
 * report or note, a prompt the app sent), or one with nothing to show.
 */
export const piUserHidden = (message: PiUserMessage): boolean => {
  const { text, display } = piUserView(message);
  return (
    isPiScheduledInput(message) ||
    isPiAgentText(piMessageText(message)) ||
    isPiAgentText(text) ||
    (!text.trim() && !display)
  );
};

/**
 * A user message as the conversation journal holds one, and its readers
 * render it: the text the user typed or said, previews of what they attached
 * (images as image blocks, files as declared attachments) and the context
 * chips, without the parts the runtime added for the model. A message the user
 * never wrote (an agent's report or note, a prompt the app sent) is hidden and
 * keeps its whole text, so a reader can still tell what it answered.
 */
export const piJournalUserMessage = (
  message: PiUserMessage,
): { message: Record<string, unknown>; hidden: boolean; clientMsgId?: string } => {
  const { text, display } = piUserView(message);
  const clientMsgId =
    typeof message.content === "string"
      ? undefined
      : message.content.flatMap((part) =>
          (part.type === "text" || part.type === "image") && part.stella?.clientMsgId ? [part.stella.clientMsgId] : [],
        )[0];
  const hidden = piUserHidden(message);
  const images: PiContentBlock[] = [];
  const files: Array<Record<string, unknown>> = [];
  for (const attachment of display?.attachments ?? []) {
    const match = attachment.kind === "image" ? /^data:([^;,]+);base64,(.+)$/s.exec(attachment.url ?? "") : null;
    if (match) images.push({ type: "image", mimeType: match[1]!, data: match[2]! });
    else if (attachment.kind === "file") files.push({ ...attachment, kind: "file" });
  }
  return {
    hidden,
    ...(clientMsgId ? { clientMsgId } : {}),
    message: {
      role: "user",
      content: [{ type: "text", text: hidden ? piMessageText(message) : text }, ...images],
      timestamp: message.timestamp,
      ...(message.source
        ? { source: message.source }
        : isPiScheduledInput(message)
          ? { source: "schedule" }
          : {}),
      ...(message.voiceSession ? { voiceSession: message.voiceSession } : {}),
      ...(files.length > 0 ? { attachments: files } : {}),
      ...(display?.context ? { metadata: { context: display.context } } : {}),
    },
  };
};

/** What a user message shows: its unmarked text and what its marks display. */
export const piUserView = (message: PiUserMessage): { text: string; display?: PiUserDisplay } => {
  if (typeof message.content === "string") return { text: message.content };
  let display: PiUserDisplay | undefined;
  const text: string[] = [];
  for (const part of message.content) {
    if ((part.type === "text" || part.type === "image") && part.stella?.display) display ??= part.stella.display;
    if (part.type === "text" && !part.stella?.hidden) text.push(part.text);
  }
  return { text: text.join("\n"), ...(display ? { display } : {}) };
};

// ---- what reaches clients ---------------------------------------------------------

/** Prompt sections stay with the host; they are large and no client renders them. */
const isHostOnly = (entry: PiEntry | undefined): boolean => entry?.kind === "pi.system";

/** Provider signatures (encrypted reasoning) mean nothing to a client. */
const unsigned = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value, (key, field) => (key === "thinkingSignature" || key === "textSignature" ? undefined : field))) as T;

/** Events as clients receive them: no prompt sections, no provider signatures. */
export const piEventsForClients = (events: readonly PiChatEvent[]): PiChatEvent[] => {
  const out: PiChatEvent[] = [];
  for (const event of events) {
    switch (event.type) {
      case "snapshot":
        out.push(unsigned({ ...event, entries: event.entries.filter((entry) => !isHostOnly(entry)) }));
        break;
      case "message_end":
      case "entry_appended":
        if (!isHostOnly(event.entry)) out.push(unsigned(event));
        break;
      case "message_start":
      case "message_update":
      case "tool_execution_end":
        out.push(unsigned(event));
        break;
      default:
        out.push(event);
    }
  }
  return out;
};

/** Entries as clients receive them, newest kept first within `maxBytes`. */
export const piEntriesForClients = (
  entries: readonly PiEntry[],
  maxBytes: number,
): { entries: PiEntry[]; trimmed: boolean } => {
  const kept: PiEntry[] = [];
  let bytes = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (isHostOnly(entry)) continue;
    const clean = unsigned(entry);
    bytes += JSON.stringify(clean).length;
    if (bytes > maxBytes && kept.length > 0) return { entries: kept.reverse(), trimmed: true };
    kept.push(clean);
  }
  return { entries: kept.reverse(), trimmed: false };
};
