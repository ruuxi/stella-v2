/**
 * GPT-Live client-delegation protocol helpers for mobile voice.
 *
 * The voice model owns the spoken conversation and delegates every piece of
 * reasoning or tool use to Stella's text orchestrator. Instructions, voice and
 * startup history are set once when the backend creates the session, so this
 * module only builds the startup payload plus the data-channel events the
 * phone is allowed to send afterwards: `session.*.append`, microphone control
 * and `session.close`.
 */

import {
  VOICE_APPEND_MAX_CHARS,
  VOICE_HISTORY_MAX_CHARS,
  VOICE_HISTORY_MAX_MESSAGES,
  VOICE_INSTRUCTIONS_MAX_CHARS,
  type VoiceHistoryMessage,
} from "@stella/contracts/backend/voice";
import type { ChatMessage, MobileTask } from "../types";

export type RealtimeVoicePhase =
  "connecting" | "listening" | "user-speaking" | "assistant-speaking" | "error";

export type RealtimeVoiceHistoryItem = {
  role: string;
  content: string;
  timestamp?: number;
  toolCallId?: string;
};

/** What the connected computer reports about its current conversation. */
export type RealtimeVoiceOrchestratorConfig = {
  instructions: string;
  history?: RealtimeVoiceHistoryItem[];
};

export type RealtimeVoiceActionDispatch = {
  userMessageId: string;
} | null;

export type RealtimeVoiceActionCompletion = {
  text: string;
  failed: boolean;
};

/** One delegation the voice model opened; it carries no task text by design. */
export type VoiceDelegation = {
  id: string;
  target: string;
  offsetMs: number | null;
};

export type VoiceAppendKind = "commentary" | "thinking" | "instructions";

export type VoiceAppendAck = {
  clientEventId: string;
  error: string | null;
};

export type VoiceTranscriptRole = "user" | "assistant";

export type VoiceTranscriptFragment = {
  role: VoiceTranscriptRole;
  delta: string;
  startMs: number | null;
  endMs: number | null;
};

const MAX_HISTORY_MESSAGE_CHARS = 1_200;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const normalizeText = (value: unknown): string =>
  typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";

const spokenConversationBrief = [
  "You are Stella's voice, the spoken half of the World's best Personal AI Assistant and Secretary.",
  "You own this conversation end to end: listen, answer, and keep it flowing naturally. Sound warm, direct and concise, and keep most turns to one to three short sentences.",
  "Speak plainly. Never read markdown, file paths, URLs or technical identifiers aloud unless the user asks for them.",
  "Stella's text orchestrator does all reasoning, tool use and actions. Delegate anything that needs current information, the user's data, or a change in the world, then say one short line so the user knows you are on it.",
  "Never invent a result or claim work is finished. Only report work that has come back to you.",
  "Stay quiet for background noise, filler and unfinished sentences.",
  "When the user clearly says goodbye, give one short farewell and stop.",
];

export const clampVoiceInstructions = (instructions: string): string =>
  instructions.trim().slice(0, VOICE_INSTRUCTIONS_MAX_CHARS);

/** The startup conversation-and-delegation brief, not Stella's system prompt. */
export const buildVoiceSessionInstructions = (
  execution: "phone" | "computer",
): string =>
  clampVoiceInstructions(
    [
      ...spokenConversationBrief,
      execution === "computer"
        ? "Delegated work runs on the user's connected computer, with its files, apps and tools."
        : "Delegated work runs in Stella's cloud, attached to the chat the user opened this call from.",
    ].join("\n"),
  );

/** Trim startup history to the newest turns inside the contract's bounds. */
export const boundVoiceHistory = (
  history: readonly VoiceHistoryMessage[],
): VoiceHistoryMessage[] => {
  const kept: VoiceHistoryMessage[] = [];
  let chars = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index]!;
    const text = normalizeText(entry.text).slice(0, MAX_HISTORY_MESSAGE_CHARS);
    if (!text) continue;
    if (
      kept.length >= VOICE_HISTORY_MAX_MESSAGES ||
      chars + text.length > VOICE_HISTORY_MAX_CHARS
    ) {
      break;
    }
    chars += text.length;
    kept.push({ role: entry.role, text });
  }
  return kept.reverse();
};

/** Startup history for the attached mobile chat. */
export const buildAttachedChatVoiceHistory = (
  messages: readonly ChatMessage[],
): VoiceHistoryMessage[] =>
  boundVoiceHistory(
    messages.map((message) => ({
      role:
        message.role === "user" ? ("user" as const) : ("assistant" as const),
      text: message.text ?? "",
    })),
  );

/** Startup history for the connected computer's current conversation. */
export const buildComputerVoiceHistory = (
  config: RealtimeVoiceOrchestratorConfig,
): VoiceHistoryMessage[] =>
  boundVoiceHistory(
    (config.history ?? []).map((item) => {
      if (item.role === "user")
        return { role: "user" as const, text: item.content };
      if (item.role === "assistant") {
        return { role: "assistant" as const, text: item.content };
      }
      return {
        role: "developer" as const,
        text: `Earlier ${item.role || "context"} from the computer's chat: ${item.content}`,
      };
    }),
  );

/** Appends are capped per event, so longer text is split across appends. */
export const splitVoiceAppendContent = (content: string): string[] => {
  const text = content.trim();
  if (!text) return [];
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += VOICE_APPEND_MAX_CHARS) {
    chunks.push(text.slice(index, index + VOICE_APPEND_MAX_CHARS));
  }
  return chunks;
};

/**
 * `commentary` is said aloud (paraphrased), `thinking` is known but not
 * announced, `instructions` changes behaviour. `delegationId` is the task the
 * update belongs to, or null for session-wide context.
 */
export const buildVoiceAppendEvent = (options: {
  kind: VoiceAppendKind;
  eventId: string;
  delegationId: string | null;
  content: string;
}): Record<string, unknown> => ({
  type: `session.${options.kind}.append`,
  event_id: options.eventId,
  delegation_id: options.delegationId,
  content: options.content,
});

export const buildVoiceMicrophoneEvent = (options: {
  eventId: string;
  muted: boolean;
}): Record<string, unknown> => ({
  type: options.muted
    ? "session.input_audio.mute"
    : "session.input_audio.unmute",
  event_id: options.eventId,
});

export const buildVoiceCloseEvent = (
  eventId: string,
): Record<string, unknown> => ({
  type: "session.close",
  event_id: eventId,
});

export const parseVoiceDelegationCreated = (
  event: Record<string, unknown>,
): VoiceDelegation | null => {
  const delegation = asRecord(event.delegation);
  const id = asString(delegation?.id);
  if (!id) return null;
  return {
    id,
    target: asString(delegation?.target),
    offsetMs: asNumber(event.offset_ms) ?? asNumber(delegation?.offset_ms),
  };
};

const TRANSCRIPT_DELTA_ROLES: Record<string, VoiceTranscriptRole> = {
  "session.input_transcript.delta": "user",
  "session.output_transcript.delta": "assistant",
};

export const parseVoiceTranscriptDelta = (
  event: Record<string, unknown>,
): VoiceTranscriptFragment | null => {
  const role = TRANSCRIPT_DELTA_ROLES[asString(event.type)];
  if (!role) return null;
  const delta = asString(event.delta);
  if (!delta) return null;
  return {
    role,
    delta,
    startMs: asNumber(event.start_ms),
    endMs: asNumber(event.end_ms),
  };
};

const APPEND_ACK_TYPES = new Set([
  "session.commentary.appended",
  "session.thinking.appended",
  "session.instructions.appended",
]);

/** Acks and their error variants, matched back to the outgoing `event_id`. */
export const parseVoiceAppendAck = (
  event: Record<string, unknown>,
): VoiceAppendAck | null => {
  const type = asString(event.type);
  const clientEventId =
    asString(event.client_event_id) ||
    asString(asRecord(event.error)?.client_event_id) ||
    asString(asRecord(event.error)?.event_id);
  if (!clientEventId) return null;
  const failed =
    !APPEND_ACK_TYPES.has(type) &&
    (type === "error" || type.endsWith(".error") || type.endsWith(".failed"));
  if (!failed && !APPEND_ACK_TYPES.has(type)) return null;
  return {
    clientEventId,
    error: failed ? realtimeErrorMessage(event) : null,
  };
};

/**
 * A transcript fragment is not a complete turn, so deltas accumulate until the
 * turn is consumed. A fragment that starts before the last one ended belongs
 * to a new utterance, which resets the buffer.
 */
export class VoiceTranscriptAccumulator {
  private buffer = "";
  private lastEndMs: number | null = null;

  append(fragment: VoiceTranscriptFragment): string {
    if (
      fragment.startMs !== null &&
      this.lastEndMs !== null &&
      fragment.startMs < this.lastEndMs
    ) {
      this.buffer = "";
    }
    this.buffer += fragment.delta;
    if (fragment.endMs !== null) this.lastEndMs = fragment.endMs;
    return this.text;
  }

  get text(): string {
    return this.buffer.trim().replace(/\s+/g, " ");
  }

  take(): string {
    const text = this.text;
    this.reset();
    return text;
  }

  reset(): void {
    this.buffer = "";
    this.lastEndMs = null;
  }
}

export const findVoiceActionCompletion = (
  messages: ChatMessage[],
  userMessageId: string,
  tasks: readonly MobileTask[] = [],
): RealtimeVoiceActionCompletion | null => {
  const reply = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" && message.requestId === userMessageId,
    );
  if (!reply) return null;
  const relatedReplies = messages.filter(
    (message) =>
      message.role === "assistant" && message.requestId === userMessageId,
  );
  const normalizedToolName = (toolName: string) =>
    toolName.split("__").at(-1)?.toLowerCase() ?? toolName.toLowerCase();
  const toolSteps = relatedReplies.flatMap(
    (message) => message.toolSteps ?? [],
  );
  const completedSpawnCount = toolSteps.filter(
    (step) =>
      step.status === "completed" &&
      normalizedToolName(step.toolName) === "spawn_agent",
  ).length;
  const completedTaskControlSteps = toolSteps.filter((step) => {
    const name = normalizedToolName(step.toolName);
    return (
      step.status === "completed" &&
      (name === "send_message" || name === "pause_agent")
    );
  });
  const referencedTaskIds = new Set(
    completedTaskControlSteps.flatMap((step) => {
      const id = step.args?.thread_id ?? step.args?.threadId;
      return id ? [id] : [];
    }),
  );
  const successfullyPausedTaskIds = new Set(
    completedTaskControlSteps.flatMap((step) => {
      const id = step.args?.thread_id ?? step.args?.threadId;
      return normalizedToolName(step.toolName) === "pause_agent" && id
        ? [id]
        : [];
    }),
  );
  const spawnedTasks = [
    ...new Map((reply.tasks ?? []).map((task) => [task.id, task])).values(),
  ];
  const referencedTasks = tasks.filter((task) =>
    referencedTaskIds.has(task.id),
  );
  const ownedTasks = [
    ...new Map(
      [...spawnedTasks, ...referencedTasks].map((task) => [task.id, task]),
    ).values(),
  ];
  // The journal and the separate canonical task query can arrive in either
  // order. A completed spawn tool is proof that a task row is expected, so do
  // not permanently consume the voice request during that propagation gap.
  if (completedSpawnCount > spawnedTasks.length) return null;
  if (
    referencedTaskIds.size > 0 &&
    referencedTasks.length < referencedTaskIds.size
  ) {
    return null;
  }
  const actionMessage = messages.find(
    (message) =>
      message.role === "user" &&
      (message.id === userMessageId || message.canonicalId === userMessageId),
  );
  const actionStartedAt =
    actionMessage?.canonicalCreatedAt ?? actionMessage?.createdAt;
  if (
    actionStartedAt !== undefined &&
    referencedTasks.some(
      (task) =>
        task.updatedAt !== undefined && task.updatedAt < actionStartedAt,
    )
  ) {
    return null;
  }
  if (ownedTasks.some((task) => task.status === "running")) return null;
  const text = normalizeText(reply.text);
  const artifactCount = reply.artifacts?.length ?? 0;
  const taskFailed = ownedTasks.some(
    (task) =>
      task.status === "error" ||
      (task.status === "canceled" && !successfullyPausedTaskIds.has(task.id)),
  );
  const taskSummary = ownedTasks.length
    ? ownedTasks
        .map((task) => {
          const successfullyPaused =
            task.status === "canceled" &&
            successfullyPausedTaskIds.has(task.id);
          const detail =
            task.status === "error" ||
            (task.status === "canceled" && !successfullyPaused)
              ? task.errorMessage
              : task.resultText;
          return `${task.title}: ${
            detail?.trim() || (successfullyPaused ? "paused" : task.status)
          }`;
        })
        .join("; ")
    : "";
  return {
    text:
      taskSummary ||
      text ||
      (artifactCount > 0
        ? `The task completed and produced ${artifactCount === 1 ? "a file" : `${artifactCount} files`} in the attached chat.`
        : "The task completed in the attached chat."),
    failed: reply.stopped === true || taskFailed,
  };
};

export const realtimeErrorMessage = (
  event: Record<string, unknown>,
): string => {
  const error = asRecord(event.error);
  return (
    normalizeText(error?.message) ||
    normalizeText(event.message) ||
    "The voice connection was interrupted. Try again."
  );
};
