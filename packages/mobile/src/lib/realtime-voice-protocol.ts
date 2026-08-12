import type { ChatMessage, MobileTask } from "../types";
import type { ChatThreadId } from "./offline-chat-storage";

const LOCAL_CHAT_THREAD_IDS: ReadonlySet<string> = new Set<ChatThreadId>([
  "cloud",
  "computer",
  "carplay",
  "carplay-computer",
]);

/**
 * Local transcript keys are not Convex conversation IDs. Keep them out of
 * managed voice requests while preserving a real cloud/desktop conversation
 * ID when one is available.
 */
export const managedVoiceConversationId = (
  conversationId: string,
): string | undefined => {
  const normalized = conversationId.trim();
  if (!normalized || LOCAL_CHAT_THREAD_IDS.has(normalized)) return undefined;
  return normalized;
};

export type RealtimeVoicePhase =
  | "connecting"
  | "listening"
  | "user-speaking"
  | "assistant-speaking"
  | "error";

export type RealtimeToolDefinition = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type RealtimeVoiceHistoryItem = {
  role: string;
  content: string;
  timestamp?: number;
  toolCallId?: string;
};

export type RealtimeVoiceOrchestratorConfig = {
  instructions: string;
  tools: RealtimeToolDefinition[];
  history?: RealtimeVoiceHistoryItem[];
};

export type RealtimeVoiceToolCall = {
  requestId: string;
  conversationId: string;
  callId: string;
  name: string;
  args: Record<string, unknown>;
};

export type RealtimeVoiceToolResult = {
  output: string;
  details?: unknown;
  fileChanges?: unknown[];
  producedFiles?: unknown[];
  error?: string;
};

const UNSUPPORTED_REALTIME_ROOT_SCHEMA_KEYS = [
  "oneOf",
  "anyOf",
  "allOf",
  "enum",
  "const",
  "not",
] as const;

/** Match the desktop/backend Realtime contract before tools reach OpenAI. */
export const toRealtimeProviderTool = (
  tool: RealtimeToolDefinition,
): RealtimeToolDefinition => {
  const parameters = { ...tool.parameters };
  for (const key of UNSUPPORTED_REALTIME_ROOT_SCHEMA_KEYS) {
    delete parameters[key];
  }
  return {
    ...tool,
    parameters: {
      ...parameters,
      type: "object",
      properties:
        typeof parameters.properties === "object" &&
        parameters.properties !== null &&
        !Array.isArray(parameters.properties)
          ? parameters.properties
          : {},
    },
  };
};

export type RealtimeVoiceActionDispatch = {
  userMessageId: string;
} | null;

export type RealtimeVoiceActionCompletion = {
  text: string;
  failed: boolean;
};

export const REALTIME_CONTROL_TOOLS: RealtimeToolDefinition[] = [
  {
    type: "function",
    name: "no_response",
    description:
      "Stay silent when the audio is background noise, filler, thinking aloud, or an unfinished sentence.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "goodbye",
    description:
      "End the voice conversation after one short goodbye when the user says bye, goodbye, see you later, or goodnight.",
    parameters: { type: "object", properties: {} },
  },
];

const normalizeText = (value: unknown): string =>
  typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";

const recentChatContext = (messages: ChatMessage[]): string => {
  const rows = messages
    .filter((message) => normalizeText(message.text))
    .slice(-16)
    .map((message) => {
      const speaker = message.role === "user" ? "User" : "Stella";
      return `${speaker}: ${normalizeText(message.text).slice(0, 1_200)}`;
    });
  if (!rows.length) return "";
  return [
    "<text_chat_context>",
    "Recent messages from the attached chat, oldest to newest:",
    ...rows,
    "</text_chat_context>",
  ].join("\n");
};

const spokenVoiceInstructions = [
  "You are Stella, the World's best Personal AI Assistant and Secretary.",
  "This is a realtime spoken conversation. Sound warm, natural, direct, and concise.",
  "Do not use markdown or read visual formatting, file paths, URLs, or technical identifiers aloud unless the user asks.",
  "Keep most spoken turns to one to three short sentences.",
].join("\n");

export const buildNormalChatVoiceInstructions = (
  messages: ChatMessage[],
): string => {
  const context = recentChatContext(messages);
  return [
    spokenVoiceInstructions,
    "The attached normal Stella chat owns every user turn, every tool call, and every answer.",
    "Automatic replies are disabled. When the app supplies a completed attached-chat answer, speak that answer faithfully and naturally. Do not invent work or answer a pending user request independently.",
    context,
  ]
    .filter(Boolean)
    .join("\n\n");
};

const formatHistoryRole = (role: string): string => {
  if (role === "assistant") return "Stella";
  if (role === "user") return "User";
  if (role === "tool") return "Tool result";
  return role || "Context";
};

const desktopHistoryContext = (
  history: RealtimeVoiceHistoryItem[] | undefined,
): string => {
  const rows = (history ?? [])
    .map((item) => {
      const content = normalizeText(item.content);
      return content ? `[${formatHistoryRole(item.role)}]\n${content}` : "";
    })
    .filter(Boolean);
  if (!rows.length) return "";
  return [
    '<conversation_history source="stella-chat" newest_last="true">',
    "These are prior messages and tool results in the connected computer's current Stella conversation. Treat them as already-known history, not a new request.",
    ...rows,
    "</conversation_history>",
  ].join("\n\n");
};

export const buildComputerVoiceInstructions = (
  config: RealtimeVoiceOrchestratorConfig,
): string =>
  [
    spokenVoiceInstructions,
    "Use the connected computer's Stella tools directly whenever the user wants current information or an action. Speak one brief preamble before a tool call, then report completion only after its result arrives.",
    "Use no_response for background noise, filler, or unfinished thoughts. Use goodbye only when the user clearly ends the conversation.",
    config.instructions.trim()
      ? [
          "<text_orchestrator_context>",
          config.instructions.trim(),
          "</text_orchestrator_context>",
        ].join("\n")
      : "",
    desktopHistoryContext(config.history),
  ]
    .filter(Boolean)
    .join("\n\n");

export const mergeComputerVoiceTools = (
  tools: readonly RealtimeToolDefinition[],
): RealtimeToolDefinition[] => {
  const merged = new Map<string, RealtimeToolDefinition>();
  for (const tool of [...tools, ...REALTIME_CONTROL_TOOLS]) {
    if (tool?.name) merged.set(tool.name, toRealtimeProviderTool(tool));
  }
  return [...merged.values()];
};

export const buildMobileRealtimeSessionUpdate = (options: {
  eventId: string;
  execution: "phone" | "computer";
  instructions: string;
  tools: RealtimeToolDefinition[];
}): Record<string, unknown> => ({
  type: "session.update",
  event_id: options.eventId,
  session: {
    type: "realtime",
    instructions: options.instructions,
    tools: options.tools,
    tool_choice: options.execution === "computer" ? "auto" : "none",
    // The model cannot be changed by session.update, and the output voice was
    // already selected when the backend minted the client secret. Resending
    // either risks rejecting the whole update instead of applying its tools.
    audio: {
      input: {
        turn_detection: {
          type: "server_vad",
          create_response: options.execution === "computer",
          interrupt_response: options.execution === "computer",
        },
      },
    },
  },
});

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
      (name === "send_input" || name === "pause_agent")
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
  const error =
    event.error && typeof event.error === "object"
      ? (event.error as Record<string, unknown>)
      : null;
  return (
    normalizeText(error?.message) ||
    normalizeText(event.message) ||
    "The voice connection was interrupted. Try again."
  );
};
