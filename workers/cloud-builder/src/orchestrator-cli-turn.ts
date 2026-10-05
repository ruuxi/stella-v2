/**
 * The OrchestratorSession's side of a cloud chat turn run by the real Claude
 * Code CLI (see `@stella/contracts/cloud-orchestrator-cli`).
 *
 * When a turn's execution engine is `anthropic`, the Durable Object never runs
 * Stella's Agent loop and never mints an `anthropic` model capability. It
 * builds the same system prompt and tools it always would, then dispatches
 * the turn to the conversation's orchestrator BuildSession as an agent turn
 * with `agentRole: "orchestrator"`. The container's `claude` calls the DO's
 * tools back through the turn broker, and its finalized assistant messages
 * arrive as ordered event batches that the DO journals exactly as it
 * journals its own loop's messages.
 *
 * This module holds the pieces that do not need the object's private state:
 * the durable records, frame parsing, the tool catalog, prompt composition
 * (the delta since the CLI last saw the conversation), and the BuildSession
 * calls. The object owns the lifecycle glue in `runCliTurn` and the
 * `CLOUD_CLI_TURN_DO_PATHS` routes.
 */

import type {
  AgentMessage,
  AgentTool,
  AgentToolResult,
} from "@stella/runtime/kernel/agent-core/types.js";
import {
  orchestratorCliThreadId,
  type CloudCliAssistantMessage,
  type CloudCliTurnEventsForward,
  type CloudCliTurnIdentity,
  type CloudCliTurnTerminal,
  type CloudCliTurnToolForward,
  type CloudOrchestratorCliTurnSpec,
  type CloudOrchestratorEvent,
  type CloudOrchestratorToolContent,
  type CloudOrchestratorToolDescriptor,
  type CloudOrchestratorToolResult,
} from "@stella/contracts/cloud-orchestrator-cli";
import {
  TURN_PLANE_PROTOCOL,
  type CloudAgentTurnStartRequest,
  type CloudAgentTurnStartResponse,
} from "@stella/contracts/turn-plane/turn-start";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import { formatMessageRefTag } from "@stella/contracts/reply-refs";
import { HEADER_GATE_ADMITTED } from "./turn-start-request.js";

// ---------------------------------------------------------------------------
// Durable state
// ---------------------------------------------------------------------------

/**
 * The conversation's latest CLI turn, written before the dispatch leaves the
 * object. A turn resumed after eviction finds it and waits for that exact
 * attempt instead of dispatching again; the internal routes accept frames
 * only for the identity it names while it is unfinished.
 */
export const ORCHESTRATOR_CLI_TURN_KEY = "orchestratorCliTurn:v1";

/**
 * The newest journal seq the CLI session has seen, per journal epoch. Each
 * CLI prompt carries the model rows written after it by anything other than
 * the CLI itself (turns on other engines, local desktop turns, voice rows),
 * so switching engines mid-conversation loses nothing.
 */
export const ORCHESTRATOR_CLI_DELIVERED_KEY = "orchestratorCliDelivered:v1";

/** First-use fingerprint of one CLI tool call, for exact replay. */
export const orchestratorCliToolCallKey = (
  turnId: string,
  toolCallId: string,
): string => `orchestratorCliTool:${turnId}:${toolCallId}`;

/** Journal writer of every row the CLI produced (assistant + tool results). */
export const ORCHESTRATOR_CLI_WRITER = "orchestrator-cli";

/** Writer key of the tool result the DO journaled for one CLI tool call. */
export const orchestratorCliToolResultWriterKey = (
  turnId: string,
  toolCallId: string,
): string => `turn:${turnId}:cli-tool:${toolCallId}`;

/** Writer key of the reply the DO repairs from the terminal's `finalText`. */
export const orchestratorCliFinalWriterKey = (turnId: string): string =>
  `turn:${turnId}:cli-final`;

export type OrchestratorCliTurnRecord = CloudCliTurnIdentity & {
  /** The turn's prompt row; the delta it carried ends just before it. */
  promptSeq: number;
  /** Highest event batch applied; batches apply strictly in order. */
  appliedBatchSeq: number;
  dispatchedAt: number;
  /** Cumulative usage from the latest `usage` event. */
  usage?: { inputTokens: number; outputTokens: number; llmCalls: number };
  /** Set by `/internal/cli-turn/terminal` before any waiter is woken. */
  terminal?: CloudCliTurnTerminal;
  /** The DO's turn ended; no frame for this identity is accepted again. */
  finished?: boolean;
};

export type OrchestratorCliDelivered = { journalEpoch: number; seq: number };

export type OrchestratorCliToolCallRecord = {
  fingerprint: string;
  startedAt: number;
};

export const sameCliTurnIdentity = (
  left: CloudCliTurnIdentity,
  right: CloudCliTurnIdentity,
): boolean =>
  left.conversationId === right.conversationId &&
  left.threadId === right.threadId &&
  left.turnId === right.turnId &&
  left.attemptGeneration === right.attemptGeneration;

// ---------------------------------------------------------------------------
// Frame parsing (BuildSession -> DO). The BuildSession fills the identity
// from its own broker claim; the DO still validates every field it reads.
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundedString = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : null;

const nonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const parseCliTurnIdentity = (
  value: unknown,
): CloudCliTurnIdentity | null => {
  if (!isRecord(value)) return null;
  const conversationId = boundedString(value.conversationId, 512);
  const threadId = boundedString(value.threadId, 600);
  const turnId = boundedString(value.turnId, 128);
  const attemptGeneration = value.attemptGeneration;
  if (
    !conversationId ||
    !threadId ||
    !turnId ||
    !nonNegativeInteger(attemptGeneration) ||
    attemptGeneration < 1 ||
    threadId !== orchestratorCliThreadId(conversationId)
  ) {
    return null;
  }
  return { conversationId, threadId, turnId, attemptGeneration };
};

export const parseCliTurnToolForward = (
  value: unknown,
): CloudCliTurnToolForward | null => {
  const identity = parseCliTurnIdentity(value);
  if (!identity || !isRecord(value)) return null;
  const toolCallId = boundedString(value.toolCallId, 256);
  const name = boundedString(value.name, 64);
  if (!toolCallId || !name || !isRecord(value.args)) return null;
  return { ...identity, toolCallId, name, args: value.args };
};

const isUsage = (value: unknown): boolean =>
  isRecord(value) &&
  ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(
    (field) => typeof value[field] === "number",
  );

const STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted"]);

const isCliAssistantMessage = (
  value: unknown,
): value is CloudCliAssistantMessage =>
  isRecord(value) &&
  value.role === "assistant" &&
  value.api === "claude-code" &&
  value.provider === "anthropic" &&
  typeof value.model === "string" &&
  typeof value.timestamp === "number" &&
  typeof value.stopReason === "string" &&
  STOP_REASONS.has(value.stopReason) &&
  isUsage(value.usage) &&
  Array.isArray(value.content) &&
  value.content.every(
    (block) =>
      isRecord(block) &&
      ((block.type === "text" && typeof block.text === "string") ||
        (block.type === "thinking" && typeof block.thinking === "string") ||
        (block.type === "toolCall" &&
          typeof block.id === "string" &&
          typeof block.name === "string" &&
          isRecord(block.arguments))),
  );

const parseCliEvent = (value: unknown): CloudOrchestratorEvent | null => {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case "text_delta":
      return typeof value.text === "string"
        ? { type: "text_delta", text: value.text }
        : null;
    case "status":
      return (value.state === "running" || value.state === "compacting") &&
        typeof value.text === "string"
        ? { type: "status", state: value.state, text: value.text }
        : null;
    case "assistant_message":
      return isCliAssistantMessage(value.message)
        ? { type: "assistant_message", message: value.message }
        : null;
    case "usage":
      return nonNegativeInteger(value.inputTokens) &&
        nonNegativeInteger(value.outputTokens) &&
        nonNegativeInteger(value.llmCalls)
        ? {
            type: "usage",
            inputTokens: value.inputTokens,
            outputTokens: value.outputTokens,
            llmCalls: value.llmCalls,
          }
        : null;
    default:
      return null;
  }
};

export const parseCliTurnEventsForward = (
  value: unknown,
): CloudCliTurnEventsForward | null => {
  const identity = parseCliTurnIdentity(value);
  if (!identity || !isRecord(value)) return null;
  const { batchSeq } = value;
  if (
    !nonNegativeInteger(batchSeq) ||
    batchSeq < 1 ||
    !Array.isArray(value.events)
  ) {
    return null;
  }
  const events: CloudOrchestratorEvent[] = [];
  for (const raw of value.events) {
    const event = parseCliEvent(raw);
    if (!event) return null;
    events.push(event);
  }
  return { ...identity, batchSeq, events };
};

export const parseCliTurnTerminal = (
  value: unknown,
): CloudCliTurnTerminal | null => {
  const identity = parseCliTurnIdentity(value);
  if (!identity || !isRecord(value)) return null;
  const { outcome, usage } = value;
  if (
    (outcome !== "completed" && outcome !== "failed" && outcome !== "canceled") ||
    typeof value.finalText !== "string" ||
    (value.error !== undefined && typeof value.error !== "string") ||
    !isRecord(usage) ||
    !nonNegativeInteger(usage.inputTokens) ||
    !nonNegativeInteger(usage.outputTokens) ||
    !nonNegativeInteger(usage.llmCalls)
  ) {
    return null;
  }
  return {
    ...identity,
    outcome,
    finalText: value.finalText,
    ...(typeof value.error === "string"
      ? { error: value.error.slice(0, 2_000) }
      : {}),
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      llmCalls: usage.llmCalls,
    },
  };
};

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** The DO's `createTools()` as the catalog the executor advertises. */
export const orchestratorCliToolCatalog = (
  tools: readonly AgentTool[],
): CloudOrchestratorToolDescriptor[] =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // TypeBox schemas are plain JSON Schema objects (their symbol keys drop
    // out on serialization).
    parameters: JSON.parse(JSON.stringify(tool.parameters ?? {})) as Record<
      string,
      unknown
    >,
  }));

/** An `AgentToolResult` as the contract's wire result. */
export const serializeCliToolResult = (
  result: Pick<AgentToolResult<unknown>, "content" | "details" | "isError">,
): CloudOrchestratorToolResult => {
  const content: CloudOrchestratorToolContent[] = [];
  for (const block of result.content ?? []) {
    if (block.type === "text") content.push({ type: "text", text: block.text });
    else if (block.type === "image") {
      content.push({
        type: "image",
        data: block.data,
        mimeType: block.mimeType,
      });
    }
  }
  return {
    content,
    ...(result.details !== undefined ? { details: result.details } : {}),
    ...(result.isError ? { isError: true } : {}),
  };
};

/** The journaled `toolResult` row read back as a wire result (replay). */
export const cliToolResultFromMessage = (
  message: AgentMessage,
): CloudOrchestratorToolResult | null => {
  if (message.role !== "toolResult") return null;
  return serializeCliToolResult({
    content: message.content,
    details: message.details,
    isError: message.isError,
  });
};

// ---------------------------------------------------------------------------
// Prompt composition
// ---------------------------------------------------------------------------

/**
 * Character budget of the conversation context one CLI prompt carries: the
 * seed tail on a conversation the CLI has never seen, or the delta since it
 * last did. Matches the desktop's external-engine delta budget
 * (`EXTERNAL_DELTA_MAX_TOTAL_CHARS`). Older rows past it are named, not sent:
 * the orchestrator can read them through its history tools.
 */
export const ORCHESTRATOR_CLI_CONTEXT_MAX_CHARS = 48_000;
/** One message's share of that budget; the middle is elided past it. */
const CONTEXT_MESSAGE_MAX_CHARS = 8_000;
const TOOL_RESULT_MAX_CHARS = 2_000;
const TOOL_ARGS_MAX_CHARS = 400;

export type OrchestratorCliContextRow = {
  seq: number;
  role: string;
  hidden: boolean;
  /** Null for a row whose payload could not be read (spilled or corrupt). */
  message: AgentMessage | null;
};

const elideMiddle = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - 80);
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return `${text.slice(0, head)}\n[… ${text.length - keep} characters elided …]\n${text.slice(text.length - tail)}`;
};

const blockText = (content: unknown): string[] => {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "image") {
      parts.push("[image]");
    } else if (block.type === "toolCall" && typeof block.name === "string") {
      let args = "";
      try {
        args = JSON.stringify(block.arguments ?? {});
      } catch {
        args = "{}";
      }
      parts.push(
        `[called ${block.name} ${args.length > TOOL_ARGS_MAX_CHARS ? `${args.slice(0, TOOL_ARGS_MAX_CHARS)}…` : args}]`,
      );
    }
  }
  return parts;
};

const renderContextRow = (row: OrchestratorCliContextRow): string | null => {
  const message = row.message;
  let text: string;
  if (!message) {
    text = "[content omitted: too large]";
  } else if (message.role === "toolResult") {
    const result = blockText(message.content).join("\n").trim();
    text = `[${message.toolName} result${message.isError ? " (error)" : ""}]\n${elideMiddle(result, TOOL_RESULT_MAX_CHARS)}`;
  } else {
    text = blockText(message.content).join("\n").trim();
    if (
      message.role === "user" &&
      !row.hidden &&
      text.length > 0
    ) {
      text = `${text}\n\n${formatMessageRefTag(row.seq)}`;
    }
  }
  if (!text.trim()) return null;
  return `<message seq="${row.seq}" role="${row.role}"${row.hidden ? ' hidden="true"' : ""}>\n${elideMiddle(text, CONTEXT_MESSAGE_MAX_CHARS)}\n</message>`;
};

/**
 * Rows (oldest first) as one tagged block, newest kept when the budget runs
 * out. Null when nothing renders.
 */
export const renderOrchestratorCliContextBlock = (args: {
  kind: "history" | "updates";
  rows: readonly OrchestratorCliContextRow[];
  /** Rows older than these that were not even considered. */
  olderOmitted?: boolean;
  maxChars?: number;
}): string | null => {
  const budget = args.maxChars ?? ORCHESTRATOR_CLI_CONTEXT_MAX_CHARS;
  const rendered: string[] = [];
  let used = 0;
  let omitted = 0;
  for (let index = args.rows.length - 1; index >= 0; index -= 1) {
    const entry = renderContextRow(args.rows[index]!);
    if (!entry) continue;
    if (used + entry.length > budget) {
      omitted = index + 1;
      break;
    }
    rendered.push(entry);
    used += entry.length;
  }
  if (rendered.length === 0) return null;
  rendered.reverse();
  const tag =
    args.kind === "history" ? "stella_thread_history" : "stella_thread_updates";
  const note =
    args.kind === "history"
      ? "Earlier messages of this Stella conversation, which your session has not seen. Treat them as the conversation so far."
      : "Messages written to this Stella conversation since your previous turn (turns run on another engine, desktop turns, and other rows your session has not seen). Treat them as delivered context.";
  const older =
    omitted > 0 || args.olderOmitted
      ? `[Older messages were omitted to fit this turn; read them with the conversation history tools if needed.]\n`
      : "";
  return `<${tag} source="stella" note="${note}">\n${older}${rendered.join("\n")}\n</${tag}>`;
};

/**
 * The one prompt string a CLI turn receives: the context block (seed or
 * delta), then the new message exactly as the Stella loop would see it — the
 * clock, the text with its reply-ref tag, and attached Drive paths.
 */
export const composeOrchestratorCliPrompt = (args: {
  context: string | null;
  text: string;
  promptSeq: number;
  hidden: boolean;
  clock: string;
  attachments?: readonly string[];
}): string => {
  const message = args.hidden
    ? args.text
    : `${args.text.replace(/\s+$/u, "")}\n\n${formatMessageRefTag(args.promptSeq)}`;
  return [
    ...(args.context ? [args.context] : []),
    `<current-time>${args.clock}</current-time>`,
    message,
    ...(args.attachments?.length
      ? [
          `<attached-drive-files>\nThe user attached these exact Drive paths to this message. Read these files, and pass these paths to any agent handling the attachments. Do not substitute other files found by searching the Drive.\n${JSON.stringify(args.attachments)}\n</attached-drive-files>`,
        ]
      : []),
  ].join("\n\n");
};

/**
 * Whether the journal still lacks the CLI's final reply: the turn's last
 * model row is not an assistant message carrying text (the last event batch
 * never arrived, or the last message only called tools).
 */
export const cliFinalReplyMissing = (
  lastMessage: AgentMessage | undefined,
  finalText: string,
): boolean => {
  if (!finalText.trim()) return false;
  if (lastMessage?.role !== "assistant") return true;
  return !lastMessage.content.some(
    (block) => block.type === "text" && block.text.trim().length > 0,
  );
};

/** The assistant row repaired from a terminal's `finalText`. */
export const cliFinalReplyMessage = (args: {
  finalText: string;
  model: string;
  now: number;
}): CloudCliAssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: args.finalText.trim() }],
  api: "claude-code",
  provider: "anthropic",
  model: args.model,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: args.now,
});

// ---------------------------------------------------------------------------
// BuildSession calls
// ---------------------------------------------------------------------------

type BuildSessionEnv = Pick<Cloudflare.Env, "BUILD_SESSIONS"> &
  Partial<Pick<Cloudflare.Env, "CLOUD_BUILDER_PUBLIC_URL">>;

const buildSession = (env: BuildSessionEnv, threadId: string) =>
  env.BUILD_SESSIONS.getByName(threadId);

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A dispatch the BuildSession refused for good; retrying cannot help. */
export class OrchestratorCliDispatchRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestratorCliDispatchRefused";
  }
}

/**
 * The session's previous attempt is still running or unwinding (409
 * `previous_turn_recovering`, e.g. a canceled turn's kill ladder). Nothing
 * was admitted; the same dispatch may be sent again shortly.
 */
export class OrchestratorCliPreviousTurnBusy extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestratorCliPreviousTurnBusy";
  }
}

/**
 * Start one CLI attempt. Same transport the DO's spawn tool uses for agent
 * attempts (`POST https://build-session/turn`, parsed by
 * `parseCloudAgentTurnStartRequest`): the trusted broker route headers, and
 * `HEADER_GATE_ADMITTED` because the chat turn already holds the owner gate
 * admission for this exact turn id.
 */
export const dispatchOrchestratorCliTurn = async (args: {
  env: BuildSessionEnv;
  ownerId: string;
  ownerGeneration: string;
  audience: string;
  budgetMicroCents: number;
  identity: CloudCliTurnIdentity;
  execution: Extract<CloudExecutionSelection, { engine: "anthropic" }>;
  prompt: string;
  spec: CloudOrchestratorCliTurnSpec;
  clientMsgId?: string;
  signal?: AbortSignal;
}): Promise<void> => {
  const publicOrigin = (args.env.CLOUD_BUILDER_PUBLIC_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!publicOrigin) {
    throw new Error(
      "Claude Code turns are unavailable: the builder's public origin is not configured.",
    );
  }
  const { identity } = args;
  const payload: CloudAgentTurnStartRequest = {
    protocol: TURN_PLANE_PROTOCOL,
    kind: "agent",
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    conversationId: identity.conversationId,
    threadId: identity.threadId,
    agentDepth: 0,
    attemptGeneration: identity.attemptGeneration,
    turnId: identity.turnId,
    prompt: args.prompt,
    description: "Stella chat turn",
    execution: args.execution,
    audience: args.audience,
    budgetMicroCents: args.budgetMicroCents,
    source: "orchestrator",
    ...(args.clientMsgId ? { clientMsgId: args.clientMsgId } : {}),
    agentRole: "orchestrator",
    orchestratorCli: args.spec,
  };
  let response: Response;
  try {
    response = await buildSession(args.env, identity.threadId).fetch(
      "https://build-session/turn",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stella-build-session-name": identity.threadId,
          "x-stella-turn-broker-endpoint": `${publicOrigin}/sessions/${encodeURIComponent(identity.threadId)}/turn-broker`,
          [HEADER_GATE_ADMITTED]: "1",
        },
        body: JSON.stringify(payload),
        ...(args.signal ? { signal: args.signal } : {}),
      },
    );
  } catch (error) {
    throw new Error(
      `Starting the Claude Code turn failed: ${errorText(error)}`.slice(0, 400),
    );
  }
  const body = (await response.json().catch(() => null)) as
    | (Partial<CloudAgentTurnStartResponse> & {
        error?: unknown;
        message?: unknown;
        reason?: unknown;
      })
    | null;
  if (response.status === 409 && body?.reason === "previous_turn_recovering") {
    throw new OrchestratorCliPreviousTurnBusy(
      "The previous Claude Code turn is still finishing.",
    );
  }
  if (!response.ok) {
    const detail =
      typeof body?.error === "string"
        ? body.error
        : typeof body?.message === "string"
          ? body.message
          : `Starting the Claude Code turn failed (${response.status}).`;
    throw response.status >= 500 || response.status === 429
      ? new Error(detail)
      : new OrchestratorCliDispatchRefused(detail);
  }
  if (
    body &&
    ((typeof body.turnId === "string" && body.turnId !== identity.turnId) ||
      (typeof body.attemptGeneration === "number" &&
        body.attemptGeneration !== identity.attemptGeneration))
  ) {
    throw new Error(
      "The orchestrator session accepted a different attempt than the one dispatched.",
    );
  }
};

/**
 * Stop one CLI attempt through the BuildSession's existing exact
 * cancellation (`POST https://build-session/cancel`): it runs the container
 * kill ladder, delivers the canceled terminal to this conversation's
 * `/internal/cli-turn/terminal`, and only then answers 200 `{ canceled: true,
 * joined: true }`. No checkpoint is taken; the session keeps the native state
 * it had before this attempt. Callers must not hold a lock the terminal route
 * needs across this call.
 */
export const cancelOrchestratorCliTurn = async (args: {
  env: BuildSessionEnv;
  ownerId: string;
  ownerGeneration: string;
  identity: CloudCliTurnIdentity;
  cancelRequestId: string;
}): Promise<{ status: number }> => {
  const response = await buildSession(args.env, args.identity.threadId).fetch(
    "https://build-session/cancel",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        turnId: args.identity.turnId,
        attemptGeneration: args.identity.attemptGeneration,
        cancelRequestId: args.cancelRequestId.slice(0, 128),
      }),
    },
  );
  await response.arrayBuffer().catch(() => undefined);
  return { status: response.status };
};

export type OrchestratorCliTurnStatus =
  | { state: "running" }
  | { state: "terminal"; terminal: CloudCliTurnTerminal }
  /** The BuildSession has no record of this attempt (it never landed). */
  | { state: "unknown" }
  /** The BuildSession cannot answer (route absent, transport error). */
  | { state: "unavailable" };

/**
 * Ask the BuildSession where one CLI attempt stands. The terminal push is the
 * primary channel; this covers a push lost while the DO was evicted.
 * `POST https://build-session/orchestrator-turn/status` `{ threadId, turnId,
 * attemptGeneration }` always answers 200 with `{ state: "running" }`,
 * `{ state: "terminal", terminal }` (which also re-triggers its delivery), or
 * `{ state: "unknown" }` (never admitted, or older than the last 32).
 */
export const pollOrchestratorCliTurn = async (args: {
  env: BuildSessionEnv;
  identity: CloudCliTurnIdentity;
  signal?: AbortSignal;
}): Promise<OrchestratorCliTurnStatus> => {
  try {
    const response = await buildSession(
      args.env,
      args.identity.threadId,
    ).fetch("https://build-session/orchestrator-turn/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: args.identity.threadId,
        turnId: args.identity.turnId,
        attemptGeneration: args.identity.attemptGeneration,
      }),
      ...(args.signal ? { signal: args.signal } : {}),
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (response.status !== 200 || !isRecord(body)) {
      return { state: "unavailable" };
    }
    if (body.state === "running") return { state: "running" };
    if (body.state === "unknown") return { state: "unknown" };
    if (body.state === "terminal") {
      const terminal = parseCliTurnTerminal(body.terminal);
      if (terminal && sameCliTurnIdentity(terminal, args.identity)) {
        return { state: "terminal", terminal };
      }
    }
    return { state: "unavailable" };
  } catch {
    return { state: "unavailable" };
  }
};

/**
 * Warm the owner's world container before a CLI turn needs it (admission,
 * socket connect), so the turn pays only for attach. Best effort; never
 * throws. `POST https://build-session/orchestrator-turn/prewarm` `{ ownerId }`
 * on the conversation's orchestrator session: 200 `{ prewarmed: true,
 * alreadyRunning, startMs? }`, 502 `start_failed`, 409 `owner_mismatch`.
 */
export const prewarmOrchestratorCli = async (args: {
  env: BuildSessionEnv;
  ownerId: string;
  conversationId: string;
}): Promise<{
  ok: boolean;
  status?: number;
  alreadyRunning?: boolean;
  startMs?: number;
}> => {
  const threadId = orchestratorCliThreadId(args.conversationId);
  try {
    const response = await buildSession(args.env, threadId).fetch(
      "https://build-session/orchestrator-turn/prewarm",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stella-build-session-name": threadId,
        },
        body: JSON.stringify({ ownerId: args.ownerId }),
        // A cold container start can take a while; nothing waits on this.
        signal: AbortSignal.timeout(60_000),
      },
    );
    const body = (await response.json().catch(() => null)) as unknown;
    return {
      ok: response.ok,
      status: response.status,
      ...(isRecord(body) && typeof body.alreadyRunning === "boolean"
        ? { alreadyRunning: body.alreadyRunning }
        : {}),
      ...(isRecord(body) && typeof body.startMs === "number"
        ? { startMs: body.startMs }
        : {}),
    };
  } catch {
    return { ok: false };
  }
};
