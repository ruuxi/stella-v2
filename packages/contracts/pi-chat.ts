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

export type PiContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export type PiUserMessage = { role: "user"; content: string | PiContentBlock[]; timestamp: number };
export type PiAssistantMessage = {
  role: "assistant";
  content: PiContentBlock[];
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  timestamp: number;
};
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
  | { type: "compaction_end"; reason: string };

// ---- host ↔ client requests --------------------------------------------------

export type PiChatRequest =
  | { op: "submit"; conversationId: string; requestId: string; text: string }
  | { op: "abort"; conversationId: string }
  | { op: "watch"; conversationId: string }
  | { op: "unwatch"; conversationId: string }
  | { op: "older"; conversationId: string; beforeEntryId: number };

export type PiChatWatchResult = {
  /** The snapshot, its entries widened to the latest page of the whole history. */
  snapshot: Extract<PiChatEvent, { type: "snapshot" }>;
  hasOlder: boolean;
};

export type PiChatOlderResult = { entries: PiEntry[]; hasOlder: boolean };

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
};

export const emptyPiChat = (): PiChatState => ({
  entries: [],
  hasOlder: false,
  running: false,
  tools: {},
  requestIds: {},
  queued: [],
  compacting: false,
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
      return {
        ...state,
        entries: mergePiEntries(state.entries, event.entries),
        running: event.run !== undefined,
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
