/**
 * Resume a durable run (`run_task`) after its worker process died.
 *
 * The run's context is rebuilt from the thread (plus, for the orchestrator,
 * the checkpointed assistant message its turn had not persisted yet). If that
 * context ends in an assistant message whose tool calls have no results, each
 * open call is answered here before the agent loop continues, by what its
 * `tool_intent` row proves and by its replay policy — the desktop mirror of
 * the cloud's `tool-replay.ts`, with the intent rows replacing the cloud's
 * positional "only the first open call can have started" inference:
 *
 *   - finished with a stored result → that result;
 *   - `safe` / `keyed` → rerun with the original arguments (a keyed tool
 *     finds its first attempt's effect through the tool call id);
 *   - `unsafe` and started (intent row present) → answered as interrupted:
 *     its effect is unknown and the model is told to verify;
 *   - `unsafe` and never started (no intent row) → the model is told nothing
 *     was done and it can call again;
 *   - `unsafe`, finished, result too large to have been stored → reported as
 *     done with its result lost.
 */

import type {
  AgentMessage,
  AgentTool,
  AgentToolResult,
} from "../agent-core/types.js";
import type { ToolCall, ToolResultMessage } from "../../ai/types.js";
import type { ToolIntentRecord } from "../storage/run-task.js";
import type { ToolReplayPolicy } from "../tools/defs/replay-policy.js";

/** Same text the cloud hosts answer an interrupted unsafe call with. */
export const INTERRUPTED_TOOL_CALL_TEXT =
  "This tool call was interrupted before it reported a result. Its effect is unknown; verify before assuming it ran.";

/** Same text the cloud hosts answer a never-started call with. */
export const NOT_STARTED_TOOL_CALL_TEXT =
  "This tool call never started: the turn was interrupted before it could run. Nothing was done; call it again if it is still needed.";

export const LOST_RESULT_TOOL_CALL_TEXT =
  "This tool call finished, but its result was lost when Stella restarted. Verify its effect before relying on it.";

export type OpenToolCallDisposition =
  | "stored"
  | "rerun"
  | "interrupted"
  | "not_started"
  | "result_lost";

export type ResolvedToolCall = {
  call: ToolCall;
  disposition: OpenToolCallDisposition;
  message: ToolResultMessage;
};

type ReplayableAgentTool = AgentTool & { replay?: ToolReplayPolicy };

const mayRerun = (policy: ToolReplayPolicy | undefined): boolean =>
  policy === "safe" || policy === "keyed";

const toolCallsOf = (message: AgentMessage | undefined): ToolCall[] =>
  message?.role === "assistant"
    ? (message.content.filter(
        (block) => block.type === "toolCall",
      ) as ToolCall[])
    : [];

/**
 * The trailing assistant message's tool calls that no later tool result
 * answers. Null when the context does not end inside a tool-call group.
 */
export const findOpenToolCalls = (
  messages: readonly AgentMessage[],
): { assistantIndex: number; calls: ToolCall[] } | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const calls = toolCallsOf(message);
    if (calls.length === 0) return null;
    const answered = new Set(
      messages
        .slice(index + 1)
        .filter((entry) => entry.role === "toolResult")
        .map((entry) => (entry as ToolResultMessage).toolCallId),
    );
    const open = calls.filter((call) => !answered.has(call.id));
    return open.length > 0 ? { assistantIndex: index, calls: open } : null;
  }
  return null;
};

/** The checkpointed assistant is already in context (same tool call ids). */
export const contextHoldsAssistant = (
  messages: readonly AgentMessage[],
  pending: AgentMessage,
): boolean => {
  const ids = toolCallsOf(pending).map((call) => call.id);
  if (ids.length === 0) return true;
  return messages.some((message) => {
    const callIds = new Set(toolCallsOf(message).map((call) => call.id));
    return ids.every((id) => callIds.has(id));
  });
};

/** The context ends in a finished answer: the run only has to settle. */
export const finalAssistantOf = (
  messages: readonly AgentMessage[],
): AgentMessage | null => {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return null;
  if (last.stopReason === "error" || last.stopReason === "aborted") return null;
  return toolCallsOf(last).length === 0 ? last : null;
};

const toResultMessage = (
  call: ToolCall,
  result: Pick<AgentToolResult<unknown>, "content" | "details"> & {
    isError?: boolean;
    modelOutputTokens?: number;
  },
  now: number,
): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: call.id,
  toolName: call.name,
  content: result.content as ToolResultMessage["content"],
  ...(result.details !== undefined && result.details !== null
    ? { details: result.details }
    : {}),
  ...(typeof result.modelOutputTokens === "number"
    ? { modelOutputTokens: result.modelOutputTokens }
    : {}),
  isError: result.isError === true,
  timestamp: now,
});

const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
  isError: true,
});

const storedResultOf = (
  intent: ToolIntentRecord,
):
  | (Pick<AgentToolResult<unknown>, "content" | "details"> & {
      isError?: boolean;
      modelOutputTokens?: number;
    })
  | null => {
  const result = intent.result as {
    content?: unknown;
    details?: unknown;
    isError?: unknown;
    modelOutputTokens?: unknown;
  } | null;
  if (!result || !Array.isArray(result.content)) return null;
  return {
    content: result.content as AgentToolResult<unknown>["content"],
    details: result.details,
    isError: result.isError === true,
    ...(typeof result.modelOutputTokens === "number"
      ? { modelOutputTokens: result.modelOutputTokens }
      : {}),
  };
};

/**
 * Answer every open call, in call order. A rerun the run's own abort
 * interrupts rethrows: the run is being stopped and a result would be a lie.
 */
export const resolveOpenToolCalls = async (args: {
  tools: readonly AgentTool[];
  calls: readonly ToolCall[];
  intents: readonly ToolIntentRecord[];
  signal?: AbortSignal;
  now?: () => number;
}): Promise<ResolvedToolCall[]> => {
  const now = args.now ?? Date.now;
  const intents = new Map(
    args.intents.map((intent) => [intent.toolCallId, intent]),
  );
  const resolved: ResolvedToolCall[] = [];
  for (const call of args.calls) {
    const intent = intents.get(call.id);
    const tool = args.tools.find((candidate) => candidate.name === call.name) as
      | ReplayableAgentTool
      | undefined;
    const replay = tool?.replay ?? intent?.replay ?? "unsafe";
    const stored = intent?.status === "done" ? storedResultOf(intent) : null;
    if (stored) {
      resolved.push({
        call,
        disposition: "stored",
        message: toResultMessage(call, stored, now()),
      });
      continue;
    }
    if (tool && mayRerun(replay)) {
      const params = tool.prepareArguments
        ? tool.prepareArguments(call.arguments)
        : call.arguments;
      try {
        const result = await tool.execute(call.id, params as never, args.signal);
        resolved.push({
          call,
          disposition: "rerun",
          message: toResultMessage(call, result, now()),
        });
      } catch (error) {
        args.signal?.throwIfAborted();
        resolved.push({
          call,
          disposition: "rerun",
          message: toResultMessage(
            call,
            textResult(error instanceof Error ? error.message : String(error)),
            now(),
          ),
        });
      }
      continue;
    }
    const disposition: OpenToolCallDisposition = !intent
      ? "not_started"
      : intent.status === "done"
        ? "result_lost"
        : "interrupted";
    const text =
      disposition === "not_started"
        ? NOT_STARTED_TOOL_CALL_TEXT
        : disposition === "result_lost"
          ? LOST_RESULT_TOOL_CALL_TEXT
          : INTERRUPTED_TOOL_CALL_TEXT;
    resolved.push({
      call,
      disposition,
      message: toResultMessage(call, textResult(text), now()),
    });
  }
  return resolved;
};

export type DurableResumeContext = {
  /** The context the loop continues from (or settles on, see `final`). */
  messages: AgentMessage[];
  /** The context already ends in a finished answer; no request is needed. */
  final: AgentMessage | null;
  /** Checkpointed messages appended because the thread did not hold them. */
  restored: AgentMessage[];
  /** The checkpointed in-flight assistant, when it had to be appended. */
  pendingAssistant: AgentMessage | null;
  /** The open calls answered for this resume, in call order. */
  resolved: ResolvedToolCall[];
};

/**
 * Bring a freshly built context to a continuable state: append what only
 * the checkpoint held (a cloud turn's captured transcript, the orchestrator's
 * in-flight assistant), drop an errored/aborted tail, then answer the open
 * tool calls. Persisting the result is the caller's job (each session
 * persists its own way).
 */
export const prepareDurableResumeContext = async (args: {
  messages: readonly AgentMessage[];
  checkpoint: {
    pending?: { message: unknown };
    captured?: ReadonlyArray<{ payload?: unknown }>;
  };
  intents: readonly ToolIntentRecord[];
  tools: readonly AgentTool[];
  signal?: AbortSignal;
}): Promise<DurableResumeContext> => {
  const messages = args.messages.slice();
  const restored: AgentMessage[] = [];
  for (const captured of args.checkpoint.captured ?? []) {
    const payload = captured.payload as AgentMessage | undefined;
    if (!payload || typeof payload !== "object" || !("role" in payload)) {
      continue;
    }
    messages.push(payload);
    restored.push(payload);
  }
  const pending = args.checkpoint.pending?.message as AgentMessage | undefined;
  let pendingAssistant: AgentMessage | null = null;
  if (
    pending?.role === "assistant" &&
    !contextHoldsAssistant(messages, pending)
  ) {
    messages.push(pending);
    pendingAssistant = pending;
  }
  // An errored/aborted assistant tail carries no usable output; the loop
  // retries from the message before it (the transient-retry rule).
  const last = messages.at(-1);
  if (
    last?.role === "assistant" &&
    (last.stopReason === "error" || last.stopReason === "aborted") &&
    toolCallsOf(last).length === 0
  ) {
    messages.pop();
  }
  const final = finalAssistantOf(messages);
  if (final) {
    return { messages, final, restored, pendingAssistant, resolved: [] };
  }
  const open = findOpenToolCalls(messages);
  const resolved = open
    ? await resolveOpenToolCalls({
        tools: args.tools,
        calls: open.calls,
        intents: args.intents,
        ...(args.signal ? { signal: args.signal } : {}),
      })
    : [];
  messages.push(...resolved.map((entry) => entry.message));
  return { messages, final: null, restored, pendingAssistant, resolved };
};
