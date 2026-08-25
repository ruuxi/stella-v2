import crypto from "crypto";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
} from "../../ai/types.js";
import type { AgentMessage } from "../agent-core/types.js";
import type { ToolResult, ToolUpdateCallback } from "../tools/types.js";
import {
  ClaudeCodeSteeringInterruptError,
  runClaudeCodeTurn,
  shutdownClaudeCodeRuntime,
} from "../integrations/claude-code-session-runtime.js";
import {
  getClaudeCodeAgentModelId,
  getClaudeCodeRuntimeEffortLevel,
  shouldUseClaudeCodeAgentRuntime,
} from "../integrations/claude-code-agent-runtime.js";
import {
  buildCodexPromptFromMessages,
  runCodexAgentTurn,
  shutdownCodexAppServerRuntime,
  shouldUseCodexAgentRuntime,
  type CodexCommandExecutionActivity,
} from "../integrations/codex-agent-runtime.js";
import {
  buildRuntimeSystemPrompt,
  buildSubagentSystemPrompt,
  createRuntimePromptAgentMessage,
} from "./run-preparation.js";
import {
  appendDemotedCatalogToNodeRepl,
  collectDemotedToolNames,
  executeRuntimeToolCall,
  extractAttachImageBlocks,
  getRuntimeToolMetadata,
  truncateModelVisibleToolText,
  preserveModelVisibleToolText,
} from "./tool-adapters.js";
import type { ImageCapTarget } from "../../ai/utils/image-caps.js";
import {
  markOrchestratorErrorReported,
  resolveInterruptionReason,
} from "./run-completion.js";
import {
  createExternalOrchestratorRunSession,
  createExternalSubagentRunSession,
  type ExternalOrchestratorRunSession,
  type ExternalSubagentRunSession,
} from "./run-session.js";
import { now, resolveLocalCliCwd, textFromUnknown } from "./shared.js";
import { createExternalAssistantUpdateBuffer } from "./external-assistant-updates.js";
import {
  buildHistorySource,
  buildOrchestratorPromptMessages,
  buildSubagentPromptMessages,
  persistAssistantReply,
  persistThreadCustomMessage,
  persistThreadPayloadMessage,
} from "./thread-memory.js";
import { ORCHESTRATOR_ROSTER_CUSTOM_TYPE } from "../storage/shared.js";
import type {
  BaseRunOptions,
  OrchestratorRunOptions,
  RuntimeRunCallbacks,
  SubagentRunOptions,
  SubagentRunResult,
} from "./types.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
} from "@stella/contracts/protocol";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import { sanitizeSensitiveData } from "@stella/contracts/sensitive-data";

const widenAllowlistWithDemotedTools = (
  toolsAllowlist: string[] | undefined,
  toolCatalog: readonly { name: string }[] | undefined,
  connectorProvider: string | undefined,
): string[] | undefined => {
  if (!toolsAllowlist?.includes("node_repl")) return toolsAllowlist;
  if (!toolCatalog?.some((tool) => tool.name === "node_repl")) {
    return toolsAllowlist;
  }
  const demoted: string[] = collectDemotedToolNames(
    toolCatalog,
    connectorProvider,
  );
  if (demoted.length === 0) return toolsAllowlist;
  return [...new Set([...toolsAllowlist, ...demoted])];
};

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const buildToolCallPayload = (args: {
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}): AssistantMessage => ({
  role: "assistant",
  content: [
    {
      type: "toolCall",
      id: args.toolCallId,
      name: args.toolName,
      arguments: args.toolArgs,
    },
  ],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-code",
  usage: EMPTY_USAGE,
  stopReason: "toolUse",
  timestamp: now(),
});

export const buildPreambleToolBoundaryMessage = (args: {
  preamble: string;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}): AssistantMessage => ({
  role: "assistant",
  content: [
    { type: "text", text: args.preamble },
    {
      type: "toolCall",
      id: args.toolCallId,
      name: args.toolName,
      arguments: args.toolArgs,
    },
  ],
  api: "openai-codex-responses",
  provider: "openai-codex",
  model: "codex",
  usage: EMPTY_USAGE,
  stopReason: "toolUse",
  timestamp: now(),
});

const buildToolResultText = (toolResult: {
  result?: unknown;
  error?: string;
}): string =>
  toolResult.error
    ? `Error: ${toolResult.error}`
    : textFromUnknown(toolResult.result);

const buildToolResultContent = async (
  toolResult: {
    result?: unknown;
    error?: string;
  },
  imageCapTarget: ImageCapTarget = {},
  spillContext?: Readonly<{
    stellaDataDir: string;
    runId: string;
    toolCallId: string;
  }>,
): Promise<(TextContent | ImageContent)[]> => {
  const rawText = buildToolResultText(toolResult);
  const { text, images } = await extractAttachImageBlocks(
    rawText,
    imageCapTarget,
  );
  const truncatedText = spillContext
    ? await preserveModelVisibleToolText(text, spillContext)
    : truncateModelVisibleToolText(text);
  const content: (TextContent | ImageContent)[] = [];
  if (truncatedText.text || images.length === 0) {
    content.push({ type: "text", text: truncatedText.text });
  }
  content.push(...images);
  return content;
};

type ExternalEngineSessionKind =
  | "claude_code_local"
  | "claude_code_local_vanilla"
  | "codex_cli";

type ExternalOrchestratorEngine = "claude_code_local";

export const usesManagedSubscriptionHarness = (
  snapshot: { subscriptionHarnessEnabled?: boolean } | undefined,
): boolean => snapshot?.subscriptionHarnessEnabled === true;

const shouldUseClaudeCodeRuntime = (opts: BaseRunOptions): boolean => {
  const primaryModelId = opts.agentContext.model ?? opts.resolvedLlm.model.id;
  return shouldUseClaudeCodeAgentRuntime({
    stellaAppDir: opts.stellaAppDir,
    agentEngine: opts.agentContext.agentEngine,
    modelId: primaryModelId,
  });
};

export const selectExternalOrchestratorEngine = (
  opts: BaseRunOptions,
): ExternalOrchestratorEngine | null => {
  if (shouldUseClaudeCodeRuntime(opts)) {
    return "claude_code_local";
  }
  return null;
};

const EXTERNAL_ENGINE_SESSION_PREFIXES: readonly string[] = [
  "claude_code_local:",

  "claude_code_local_vanilla:",
  "codex_cli:",
];

export const getExternalEngineSessionId = (args: {
  store: BaseRunOptions["store"];
  threadKey: string;
  engine: ExternalEngineSessionKind;
}): string | undefined => {
  const raw = args.store.getThreadExternalSessionId(args.threadKey);
  if (!raw) return undefined;
  const expectedPrefix = `${args.engine}:`;
  if (raw.startsWith(expectedPrefix)) {
    const sessionId = raw.slice(expectedPrefix.length).trim();
    return sessionId || undefined;
  }
  if (
    EXTERNAL_ENGINE_SESSION_PREFIXES.some((prefix) => raw.startsWith(prefix))
  ) {
    return undefined;
  }

  return args.engine === "claude_code_local" ? raw : undefined;
};

export const setExternalEngineSessionId = (args: {
  store: BaseRunOptions["store"];
  threadKey: string;
  engine: ExternalEngineSessionKind;
  sessionId: string;
}) => {
  args.store.setThreadExternalSessionId(
    args.threadKey,
    `${args.engine}:${args.sessionId}`,
  );
};

const persistExternalPromptMessages = (
  opts: BaseRunOptions,
  threadKey: string,
  promptMessages: RuntimePromptMessage[],
) => {
  const promptInputs: Array<
    RuntimePromptMessage & { attachments?: RuntimeAttachmentRef[] }
  > =
    promptMessages.length > 0
      ? promptMessages
      : [
          {
            text: opts.userPrompt,
            attachments: opts.attachments,
          },
        ];
  const promptTimestamp = now();
  for (const [index, promptInput] of promptInputs.entries()) {
    const promptMessage = createRuntimePromptAgentMessage(
      promptInput,
      promptTimestamp + index,
    );
    const messageType = promptInput.messageType ?? "user";
    if (messageType === "user" && promptMessage.role === "user") {
      persistThreadPayloadMessage(opts.store, {
        threadKey,
        payload: promptMessage,
      });
    }
    if (
      messageType === "message" &&
      promptMessage.role === "runtimeInternal" &&
      promptInput.customType?.trim() &&
      promptInput.customType !== "runtime.queued_message_reply"
    ) {
      persistThreadCustomMessage(opts.store, {
        threadKey,
        customType: promptInput.customType,
        content: promptMessage.content,
        display: promptMessage.display === true,
        timestamp: promptMessage.timestamp,
        ...(promptMessage.eventId ? { eventId: promptMessage.eventId } : {}),
        ...(opts.agentType === "orchestrator"
          ? { preservePayloadExactly: true }
          : {}),
      });
      if (promptInput.customType === ORCHESTRATOR_ROSTER_CUSTOM_TYPE) {
        opts.store.consumeOrchestratorReminder?.(opts.conversationId);
      }
    }
  }
};

const formatClaudePromptMessage = (
  message: RuntimePromptMessage,
  index: number,
): string => {
  const messageType = message.messageType ?? "user";
  const visibility = message.uiVisibility ?? "visible";
  const customType = message.customType?.trim();
  const attrs = [
    `index="${index + 1}"`,
    `type="${messageType}"`,
    `visibility="${visibility}"`,
    ...(customType
      ? [`customType="${customType.replaceAll('"', "&quot;")}"`]
      : []),
  ].join(" ");
  return `<message ${attrs}>\n${message.text.trim()}\n</message>`;
};

export const buildClaudePromptFromMessages = (
  promptMessages: RuntimePromptMessage[],
): string =>
  [
    "Stella is providing this turn as ordered prompt messages.",
    'Messages with visibility="hidden" are runtime context for you only; do not quote or reveal them unless the user explicitly asks about the relevant fact.',
    ...promptMessages.map(formatClaudePromptMessage),
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");

type ExternalQueuedMessage = {
  message: AgentMessage;
  delivery: "steer" | "followUp";
};

export const publishQueuedUserMessageStarts = (args: {
  entries: ExternalQueuedMessage[];
  runEvents:
    | ExternalOrchestratorRunSession["runEvents"]
    | ExternalSubagentRunSession["runEvents"];
  callbacks?: Partial<RuntimeRunCallbacks>;
}): void => {
  for (const entry of args.entries) {
    if (entry.message.role !== "user") continue;
    const queuedStarted = args.runEvents.recordQueuedUserMessageStart();
    if (queuedStarted) {
      args.callbacks?.onRunStarted?.(queuedStarted);
    }
  }
};

const contentToText = (content: AgentMessage["content"]): string => {
  if (typeof content === "string") {
    return content.trim();
  }
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return `[Image: ${block.mimeType}]`;
      if (block.type === "thinking") return block.thinking;
      if (block.type === "toolCall") {
        return `[Tool call] ${block.name}\n${textFromUnknown(block.arguments)}`;
      }
      return "";
    })
    .filter((entry) => entry.trim().length > 0)
    .join("\n\n")
    .trim();
};

export const buildExternalStellaHistoryPromptMessage = (args: {
  opts: BaseRunOptions;
  promptMessages: RuntimePromptMessage[];
}): RuntimePromptMessage | null => {
  const history = buildHistorySource(args.opts.agentContext);
  if (history.length === 0) {
    return null;
  }
  const lastPromptUserText = [...args.promptMessages]
    .reverse()
    .find((message) => (message.messageType ?? "user") === "user")
    ?.text.trim();
  const trimmedHistory = [...history];
  const lastHistory = trimmedHistory[trimmedHistory.length - 1];
  if (
    lastHistory?.role === "user" &&
    lastPromptUserText &&
    contentToText(lastHistory.content) === lastPromptUserText
  ) {
    trimmedHistory.pop();
  }
  const lines = trimmedHistory
    .map((message, index) => {
      const text = contentToText(message.content);
      if (!text) return "";
      return `<history_message index="${index + 1}" role="${message.role}">\n${text}\n</history_message>`;
    })
    .filter((entry) => entry.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }
  return {
    messageType: "message",
    uiVisibility: "hidden",
    customType: "runtime.stella_thread_history",
    text: [
      '<stella_thread_history source="stella" note="Stella chat/runtime history is the source of truth for recall. Use it to answer questions about prior Stella messages, even when external engine session state is unavailable or incomplete.">',
      ...lines,
      "</stella_thread_history>",
    ].join("\n"),
  };
};

export const buildClaudeCodeTurnPrompts = (args: {
  historyPromptMessage: RuntimePromptMessage | null;
  promptMessages: RuntimePromptMessage[];
  hasPersistedSession: boolean;
}): { prompt: string; resumeFallbackPrompt?: string } => {
  const historyPrefixedPrompt = args.historyPromptMessage
    ? buildClaudePromptFromMessages([
        args.historyPromptMessage,
        ...args.promptMessages,
      ])
    : undefined;
  const prompt =
    !args.hasPersistedSession && historyPrefixedPrompt
      ? historyPrefixedPrompt
      : buildClaudePromptFromMessages(args.promptMessages);
  return {
    prompt,
    ...(historyPrefixedPrompt
      ? { resumeFallbackPrompt: historyPrefixedPrompt }
      : {}),
  };
};

const formatQueuedClaudeMessage = (
  entry: ExternalQueuedMessage,
  index: number,
): RuntimePromptMessage => {
  const text = contentToText(entry.message.content);
  if (entry.message.role === "runtimeInternal") {
    return {
      text,
      messageType: "message",
      uiVisibility: "hidden",
      customType: entry.message.customType ?? `runtime.${entry.delivery}`,
      display: entry.message.display,
    };
  }
  return {
    text,
    messageType: "user",
    uiVisibility: "hidden",
    customType: `runtime.queued_${entry.delivery}_${index + 1}`,
  };
};

const attachmentsFromQueuedMessages = (
  entries: ExternalQueuedMessage[],
): RuntimeAttachmentRef[] =>
  entries.flatMap((entry) => {
    if (typeof entry.message.content === "string") {
      return [];
    }
    return entry.message.content.flatMap(
      (block: TextContent | ImageContent | ThinkingContent | ToolCall) =>
        block.type === "image"
          ? [
              {
                url: `data:${block.mimeType};base64,${block.data}`,
                mimeType: block.mimeType,
              },
            ]
          : [],
    );
  });

export const createExternalLiveAgent = () => {
  const queued: ExternalQueuedMessage[] = [];
  const state = { isStreaming: true };
  let notifySteerableTurn: (() => void) | null = null;
  return {
    agent: {
      state,
      steer: (message: AgentMessage) => {
        queued.push({ message, delivery: "steer" });
        notifySteerableTurn?.();
      },
      followUp: (message: AgentMessage) => {
        queued.push({ message, delivery: "followUp" });
      },
      clearAllQueues: () => {
        queued.splice(0, queued.length);
      },
    },
    drain(): ExternalQueuedMessage[] {
      return queued.splice(0, queued.length);
    },
    drainSteering(): ExternalQueuedMessage[] {
      const steering = queued.filter((entry) => entry.delivery === "steer");
      if (steering.length === 0) return [];
      const retained = queued.filter((entry) => entry.delivery !== "steer");
      queued.splice(0, queued.length, ...retained);
      return steering;
    },
    prepend(entries: ExternalQueuedMessage[]): void {
      if (entries.length > 0) queued.unshift(...entries);
    },
    beginSteerableTurn(notify: () => void): () => void {
      notifySteerableTurn = notify;
      if (queued.some((entry) => entry.delivery === "steer")) {
        notify();
      }
      return () => {
        if (notifySteerableTurn === notify) {
          notifySteerableTurn = null;
        }
      };
    },
    finish(): void {
      notifySteerableTurn = null;
      state.isStreaming = false;
    },
  };
};

const runClaudeHostedTurn = async (args: {
  opts: BaseRunOptions;
  session: ExternalOrchestratorRunSession | ExternalSubagentRunSession;
  systemPrompt: string;
  promptMessages: RuntimePromptMessage[];
  callbacks?: Partial<RuntimeRunCallbacks>;
  liveAgent?: ReturnType<typeof createExternalLiveAgent>;
}): Promise<{
  finalText: string;
  sessionId: string;
  fileChanges?: SubagentRunResult["fileChanges"];
}> => {
  const { runId, threadKey, runEvents } = args.session;

  const responseTargetTracker =
    args.session.kind === "orchestrator"
      ? args.session.responseTargetTracker
      : undefined;

  runEvents.recordRunStart();
  persistExternalPromptMessages(args.opts, threadKey, args.promptMessages);

  if (args.opts.abortSignal?.aborted) {
    throw new Error("Aborted");
  }

  const localCliCwd = resolveLocalCliCwd({
    agentType: args.opts.agentType,
    stellaAppDir: args.opts.stellaAppDir,
  });

  const spawnEngine = args.opts.agentContext.spawnEngine;
  const usesSubscriptionHarness =
    args.session.kind === "subagent" &&
    usesManagedSubscriptionHarness(args.opts.agentContext.modelConfigSnapshot);
  const vanilla =
    args.session.kind === "subagent" &&
    !usesSubscriptionHarness &&
    (spawnEngine?.engine === "claude_code_local" ||
      args.opts.agentType === AGENT_IDS.GENERAL);
  const baseSessionKey = args.opts.agentContext.activeThreadId
    ? `${args.opts.conversationId}:${args.opts.agentContext.activeThreadId}`
    : `${args.opts.conversationId}:run:${runId}`;

  const sessionKey = vanilla ? `${baseSessionKey}:vanilla` : baseSessionKey;

  const sessionEngine: "claude_code_local" | "claude_code_local_vanilla" =
    vanilla ? "claude_code_local_vanilla" : "claude_code_local";
  const persistedSessionId = getExternalEngineSessionId({
    store: args.opts.store,
    threadKey,
    engine: sessionEngine,
  });

  const toolMetadata = vanilla
    ? []
    : appendDemotedCatalogToNodeRepl(
        getRuntimeToolMetadata({
          toolsAllowlist: args.opts.agentContext.toolsAllowlist,
          toolCatalog: args.opts.toolCatalog,
        }),
        args.opts.toolCatalog,
        args.opts.connectorDeliveryTarget?.provider,
      );
  const claudeCodeModelId = getClaudeCodeAgentModelId(
    args.opts.stellaAppDir,
    args.opts.agentContext.model,
    args.opts.agentType,
    args.opts.agentContext.modelConfigSnapshot?.engine === "claude_code_local"
      ? args.opts.agentContext.modelConfigSnapshot.engineModel
      : vanilla
        ? spawnEngine?.model
        : undefined,
  );
  const emitToolUpdateStatus = (update: {
    result?: unknown;
    details?: unknown;
    error?: string;
  }) => {
    const details =
      update.details && typeof update.details === "object"
        ? (update.details as { statusText?: unknown })
        : null;
    const statusText =
      typeof details?.statusText === "string" && details.statusText.trim()
        ? details.statusText.trim()
        : buildToolResultText(update).trim();
    if (statusText) {
      args.callbacks?.onStatus?.(runEvents.recordStatus(statusText));
    }
  };

  const attemptGeneration = Reflect.get(
    args.opts.agentContext,
    "attemptGeneration",
  );
  const assistantUpdateBuffer = createExternalAssistantUpdateBuffer({
    store: args.opts.store,
    threadKey,
    engine: "claude_code",
    runId,
    ...(typeof attemptGeneration === "number" ? { attemptGeneration } : {}),
  });
  const flushPreambleBeforeTool = (toolArgs2: {
    toolCallId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
  }) => {
    const preamble = assistantUpdateBuffer.flushBeforeTool();
    if (!preamble) {
      return;
    }
    const preambleEvent = runEvents.recordAssistantMessageEnd(
      buildPreambleToolBoundaryMessage({
        preamble,
        toolCallId: toolArgs2.toolCallId,
        toolName: toolArgs2.toolName,
        toolArgs: toolArgs2.toolArgs,
      }),
    );
    if (preambleEvent) {
      args.callbacks?.onAssistantMessage?.(preambleEvent);
    }
  };
  const executeClaudeTool = async (
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => {

    const imageCapTarget: ImageCapTarget = { provider: "anthropic" };
    flushPreambleBeforeTool({ toolCallId, toolName, toolArgs });
    responseTargetTracker?.noteToolStart(toolName, toolArgs);
    const toolStartEvent = runEvents.recordToolStart({
      toolCallId,
      toolName,
      toolArgs,
    });
    args.callbacks?.onToolStart?.(toolStartEvent);
    persistThreadPayloadMessage(args.opts.store, {
      threadKey,
      payload: buildToolCallPayload({
        toolCallId,
        toolName,
        toolArgs: toolStartEvent.args,
      }),
    });
    const toolResult = await executeRuntimeToolCall({
      toolCallId,
      toolName,
      args: toolArgs,
      runId,
      rootRunId: args.opts.rootRunId ?? runId,
      agentId: args.opts.agentId,
      conversationId: args.opts.conversationId,
      agentType: args.opts.agentType,
      deviceId: args.opts.deviceId,
      stellaAppDir: args.opts.stellaAppDir,
      stellaDataDir: args.opts.stellaDataDir,
      toolWorkspaceRoot: args.opts.toolWorkspaceRoot,
      agentDepth: args.opts.agentContext.agentDepth ?? 0,
      maxAgentDepth: args.opts.agentContext.maxAgentDepth,
      parentAgentId: args.opts.agentContext.parentAgentId,
      modelConfigSnapshot: args.opts.agentContext.modelConfigSnapshot,
      connectorDeliveryTarget: args.opts.connectorDeliveryTarget,
      allowedToolNames: widenAllowlistWithDemotedTools(
        args.opts.agentContext.toolsAllowlist,
        args.opts.toolCatalog,
        args.opts.connectorDeliveryTarget?.provider,
      ),
      deferImageDeliveryAck: toolName === "image_gen",
      store: args.opts.store,
      toolExecutor: args.opts.toolExecutor,
      hookEmitter: args.opts.hookEmitter,
      signal,
      onUpdate,
    });
    responseTargetTracker?.noteToolEnd(toolName, toolResult.details);
    args.callbacks?.onToolEnd?.(
      runEvents.recordToolEnd({
        toolCallId,
        toolName,
        result: toolResult,
        details: toolResult.details,
        isError: Boolean(toolResult.error),
      }),
    );
    const sanitizedToolResult = sanitizeSensitiveData(toolResult) as ToolResult;
    persistThreadPayloadMessage(args.opts.store, {
      threadKey,
      payload: {
        role: "toolResult",
        toolCallId,
        toolName,
        content: await buildToolResultContent(
          sanitizedToolResult,
          imageCapTarget,
          {
            stellaDataDir: args.opts.stellaDataDir,
            runId: args.opts.runId,
            toolCallId,
          },
        ),
        isError: Boolean(toolResult.error),
        timestamp: now(),
      },
    });
    return toolResult;
  };

  const historyPromptMessage = buildExternalStellaHistoryPromptMessage({
    opts: args.opts,
    promptMessages: args.promptMessages,
  });
  const { prompt, resumeFallbackPrompt } = buildClaudeCodeTurnPrompts({
    historyPromptMessage,
    promptMessages: args.promptMessages,
    hasPersistedSession: Boolean(persistedSessionId),
  });
  const claudeCodeEffortLevel = getClaudeCodeRuntimeEffortLevel(
    args.opts.stellaAppDir,
    args.opts.agentContext.modelConfigSnapshot?.engine === "claude_code_local"
      ? args.opts.agentContext.modelConfigSnapshot.reasoningEffort
      : args.opts.agentContext.spawnReasoningEffort,
  );

  const collectedFileChanges: NonNullable<SubagentRunResult["fileChanges"]> =
    [];
  const collectedFileChangeKeys = new Set<string>();
  const collectTurnFileChanges = (
    fileChanges: SubagentRunResult["fileChanges"],
  ) => {
    for (const change of fileChanges ?? []) {
      const key = `${change.kind.type}:${change.path}:${change.kind.type === "update" ? (change.kind.move_path ?? "") : ""}`;
      if (collectedFileChangeKeys.has(key)) continue;
      collectedFileChangeKeys.add(key);
      collectedFileChanges.push(change);
    }
  };

  type ClaudeTurnResult = Awaited<ReturnType<typeof runClaudeCodeTurn>>;
  let finalResult: ClaudeTurnResult | null = null;
  let activeSessionId = persistedSessionId;
  let nextPrompt = prompt;
  let nextResumeFallbackPrompt = resumeFallbackPrompt;
  let nextAttachments = args.opts.attachments;

  for (;;) {
    let wasSteered = false;
    let nativeInterrupt: Promise<void> | null = null;
    let completedThisTurn = false;
    try {
      const result = await runClaudeCodeTurn({
        runId,
        sessionKey,
        ...(activeSessionId ? { persistedSessionId: activeSessionId } : {}),
        modelId: claudeCodeModelId,
        stellaAppDir: args.opts.stellaAppDir,
        ...(args.opts.cliBridgeSocketPath
          ? { cliBridgeSocketPath: args.opts.cliBridgeSocketPath }
          : {}),
        ...(vanilla ? { vanilla } : {}),
        ...(claudeCodeEffortLevel
          ? { effortLevel: claudeCodeEffortLevel }
          : {}),
        prompt: nextPrompt,
        ...(nextResumeFallbackPrompt
          ? { resumeFallbackPrompt: nextResumeFallbackPrompt }
          : {}),
        systemPrompt: args.systemPrompt,
        cwd: localCliCwd,
        attachments: nextAttachments,
        tools: toolMetadata,
        abortSignal: args.opts.abortSignal,
        onTurnControl: ({ interrupt }: { interrupt: () => Promise<void> }) =>
          args.liveAgent?.beginSteerableTurn(() => {
            if (wasSteered) return;
            wasSteered = true;

            nativeInterrupt = interrupt().catch(() => undefined);
          }),
        onSessionId: (sessionId: string) => {
          activeSessionId = sessionId;
        },
        onStatusChange: (status) => {
          args.callbacks?.onStatus?.(
            runEvents.recordStatus(status.text, status.state),
          );
        },
        onStream: (chunk) => {

          assistantUpdateBuffer.append(chunk);
          runEvents.noteAssistantTextChunk(chunk);
        },
        onToolUpdate: ({ update }) => emitToolUpdateStatus(update),
        executeTool: executeClaudeTool,
      });
      assistantUpdateBuffer.discard();
      collectTurnFileChanges(result.fileChanges);
      activeSessionId = result.sessionId;
      finalResult = result;
      completedThisTurn = true;
    } catch (error) {
      if (wasSteered && !args.opts.abortSignal?.aborted) {

        if (error instanceof ClaudeCodeSteeringInterruptError) {
          collectTurnFileChanges(error.fileChanges);
        }
        assistantUpdateBuffer.discard();
      } else {
        assistantUpdateBuffer.flushOnTermination();
        throw error;
      }
    }
    if (nativeInterrupt) {
      await nativeInterrupt;
    }

    const queued = args.liveAgent?.drain() ?? [];
    if (queued.length === 0) {
      if (completedThisTurn && finalResult) {

        args.liveAgent?.finish();
        break;
      }
      throw new Error("External engine steering message was lost.");
    }
    publishQueuedUserMessageStarts({
      entries: queued,
      runEvents,
      callbacks: args.callbacks,
    });
    const queuedPromptMessages = queued.map(formatQueuedClaudeMessage);
    const queuedAttachments = attachmentsFromQueuedMessages(queued);
    const queuedHistoryPromptMessage = buildExternalStellaHistoryPromptMessage({
      opts: args.opts,
      promptMessages: queuedPromptMessages,
    });

    const {
      prompt: queuedPrompt,
      resumeFallbackPrompt: queuedResumeFallbackPrompt,
    } = buildClaudeCodeTurnPrompts({
      historyPromptMessage: queuedHistoryPromptMessage,
      promptMessages: queuedPromptMessages,
      hasPersistedSession: Boolean(activeSessionId),
    });
    nextPrompt = queuedPrompt;
    nextResumeFallbackPrompt = queuedResumeFallbackPrompt;
    nextAttachments = queuedAttachments;
  }

  if (!finalResult) {
    throw new Error("Claude Code completed without a final result.");
  }

  await persistAssistantReply({
    store: args.opts.store,
    threadKey,
    resolvedLlm: args.opts.resolvedLlm,
    agentType: args.opts.agentType,
    content: finalResult.text,
    stellaDataDir: args.opts.stellaDataDir,
  });
  const assistantMessageEvent = runEvents.recordAssistantTextEnd(
    finalResult.text,
  );
  if (assistantMessageEvent) {
    args.callbacks?.onAssistantMessage?.(assistantMessageEvent);
  }
  setExternalEngineSessionId({
    store: args.opts.store,
    threadKey,
    engine: sessionEngine,
    sessionId: finalResult.sessionId,
  });

  return {
    finalText: finalResult.text,
    sessionId: finalResult.sessionId,
    ...(collectedFileChanges.length > 0
      ? { fileChanges: collectedFileChanges }
      : {}),
  };
};

const runCodexHostedTurn = async (args: {
  opts: BaseRunOptions & { onProgress?: (chunk: string) => void };
  session: ExternalOrchestratorRunSession | ExternalSubagentRunSession;
  systemPrompt: string;
  promptMessages: RuntimePromptMessage[];
  callbacks?: Partial<RuntimeRunCallbacks>;
  liveAgent?: ReturnType<typeof createExternalLiveAgent>;
}): Promise<{
  finalText: string;
  sessionId: string;
  fileChanges?: SubagentRunResult["fileChanges"];
}> => {
  const { runId, threadKey, runEvents } = args.session;
  const responseTargetTracker =
    args.session.kind === "orchestrator"
      ? args.session.responseTargetTracker
      : undefined;

  runEvents.recordRunStart();
  persistExternalPromptMessages(args.opts, threadKey, args.promptMessages);

  if (args.opts.abortSignal?.aborted) {
    throw new Error("Aborted");
  }

  const localCliCwd = resolveLocalCliCwd({
    agentType: args.opts.agentType,
    stellaAppDir: args.opts.stellaAppDir,
  });
  const sessionKey = args.opts.agentContext.activeThreadId
    ? `${args.opts.conversationId}:${args.opts.agentContext.activeThreadId}`
    : `${args.opts.conversationId}:run:${runId}`;
  const persistedSessionId = getExternalEngineSessionId({
    store: args.opts.store,
    threadKey,
    engine: "codex_cli",
  });
  const imageToolMetadata = getRuntimeToolMetadata({
    toolsAllowlist: args.opts.agentContext.toolsAllowlist,
    toolCatalog: args.opts.toolCatalog,
  }).filter((tool) => tool.name === "image_gen");
  const persistCodexSessionId = (sessionId: string) => {
    setExternalEngineSessionId({
      store: args.opts.store,
      threadKey,
      engine: "codex_cli",
      sessionId,
    });
  };
  const emitToolUpdateStatus = (update: ToolResult) => {
    const details =
      update.details && typeof update.details === "object"
        ? (update.details as { statusText?: unknown })
        : null;
    const statusText =
      typeof details?.statusText === "string" && details.statusText.trim()
        ? details.statusText.trim()
        : buildToolResultText(update).trim();
    if (statusText) {
      args.callbacks?.onStatus?.(runEvents.recordStatus(statusText));
    }
  };

  const attemptGeneration = Reflect.get(
    args.opts.agentContext,
    "attemptGeneration",
  );
  const assistantUpdateBuffer = createExternalAssistantUpdateBuffer({
    store: args.opts.store,
    threadKey,
    engine: "codex",
    runId,
    ...(typeof attemptGeneration === "number" ? { attemptGeneration } : {}),
  });
  const flushPreambleBeforeTool = (args2: {
    toolCallId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
  }) => {
    const preamble = assistantUpdateBuffer.flushBeforeTool();
    if (!preamble) {
      return;
    }
    const preambleEvent = runEvents.recordAssistantMessageEnd(
      buildPreambleToolBoundaryMessage({
        preamble,
        toolCallId: args2.toolCallId,
        toolName: args2.toolName,
        toolArgs: args2.toolArgs,
      }),
    );
    if (preambleEvent) {
      args.callbacks?.onAssistantMessage?.(preambleEvent);
    }
  };
  const executeCodexTool = async (
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => {

    const imageCapTarget: ImageCapTarget = { provider: "openai" };
    flushPreambleBeforeTool({ toolCallId, toolName, toolArgs });
    responseTargetTracker?.noteToolStart(toolName, toolArgs);
    const toolStartEvent = runEvents.recordToolStart({
      toolCallId,
      toolName,
      toolArgs,
    });
    args.callbacks?.onToolStart?.(toolStartEvent);
    persistThreadPayloadMessage(args.opts.store, {
      threadKey,
      payload: buildToolCallPayload({
        toolCallId,
        toolName,
        toolArgs: toolStartEvent.args,
      }),
    });
    const toolResult = await executeRuntimeToolCall({
      toolCallId,
      toolName,
      args: toolArgs,
      runId,
      rootRunId: args.opts.rootRunId ?? runId,
      agentId: args.opts.agentId,
      conversationId: args.opts.conversationId,
      agentType: args.opts.agentType,
      deviceId: args.opts.deviceId,
      stellaAppDir: args.opts.stellaAppDir,
      stellaDataDir: args.opts.stellaDataDir,
      toolWorkspaceRoot: args.opts.toolWorkspaceRoot,
      agentDepth: args.opts.agentContext.agentDepth ?? 0,
      maxAgentDepth: args.opts.agentContext.maxAgentDepth,
      parentAgentId: args.opts.agentContext.parentAgentId,
      modelConfigSnapshot: args.opts.agentContext.modelConfigSnapshot,
      connectorDeliveryTarget: args.opts.connectorDeliveryTarget,
      allowedToolNames: widenAllowlistWithDemotedTools(
        args.opts.agentContext.toolsAllowlist,
        args.opts.toolCatalog,
        args.opts.connectorDeliveryTarget?.provider,
      ),
      deferImageDeliveryAck: toolName === "image_gen",
      store: args.opts.store,
      toolExecutor: args.opts.toolExecutor,
      hookEmitter: args.opts.hookEmitter,
      signal,
      onUpdate,
    });
    responseTargetTracker?.noteToolEnd(toolName, toolResult.details);
    args.callbacks?.onToolEnd?.(
      runEvents.recordToolEnd({
        toolCallId,
        toolName,
        result: toolResult,
        details: toolResult.details,
        isError: Boolean(toolResult.error),
      }),
    );
    const sanitizedToolResult = sanitizeSensitiveData(toolResult) as ToolResult;
    persistThreadPayloadMessage(args.opts.store, {
      threadKey,
      payload: {
        role: "toolResult",
        toolCallId,
        toolName,
        content: await buildToolResultContent(
          sanitizedToolResult,
          imageCapTarget,
          {
            stellaDataDir: args.opts.stellaDataDir,
            runId: args.opts.runId,
            toolCallId,
          },
        ),
        isError: Boolean(toolResult.error),
        timestamp: now(),
      },
    });
    return toolResult;
  };
  const emitCodexCommandExecution = (
    activity: CodexCommandExecutionActivity,
  ) => {
    const toolName = "exec_command";
    const toolArgs = {
      command: activity.command,
      ...(activity.cwd ? { cwd: activity.cwd } : {}),
      state: activity.status,
    };
    if (activity.status === "inProgress") {
      flushPreambleBeforeTool({
        toolCallId: activity.id,
        toolName,
        toolArgs,
      });
      responseTargetTracker?.noteToolStart(toolName, toolArgs);
      args.callbacks?.onToolStart?.(
        runEvents.recordToolStart({
          toolCallId: activity.id,
          toolName,
          statusText: "Running command",
          toolArgs,
        }),
      );
      return;
    }
    const details = {
      ...toolArgs,
      ...(activity.exitCode !== undefined
        ? { exitCode: activity.exitCode }
        : {}),
      codexBuiltinCommandExecution: true,
    };
    responseTargetTracker?.noteToolEnd(toolName, details);
    args.callbacks?.onToolEnd?.(
      runEvents.recordToolEnd({
        toolCallId: activity.id,
        toolName,
        result: {
          state: activity.status,
          ...(activity.exitCode !== undefined
            ? { exitCode: activity.exitCode }
            : {}),
        },
        details,
        isError:
          activity.status === "failed" ||
          (activity.exitCode !== undefined && activity.exitCode !== 0),
      }),
    );
  };
  const prompt = buildCodexPromptFromMessages({
    promptMessages: args.promptMessages,
  });
  const inheritedCodexConfig =
    args.opts.agentContext.modelConfigSnapshot?.engine === "codex_cli"
      ? args.opts.agentContext.modelConfigSnapshot
      : undefined;
  const codexModelOverride =
    inheritedCodexConfig?.engineModel ??
    (args.opts.agentContext.spawnEngine?.engine === "codex_cli"
      ? args.opts.agentContext.spawnEngine.model
      : undefined);
  const codexReasoningEffort =
    inheritedCodexConfig?.reasoningEffort ??
    args.opts.agentContext.spawnReasoningEffort;
  const codexServiceTier = inheritedCodexConfig?.serviceTier;
  type CodexTurnResult = Awaited<ReturnType<typeof runCodexAgentTurn>>;
  let finalResult: CodexTurnResult | null = null;
  let activeSessionId = persistedSessionId;
  let nextPrompt = prompt;
  let nextAttachments = args.opts.attachments;

  for (;;) {
    let nativeSteerDispatch = Promise.resolve();
    let completedThisTurn = false;
    try {
      const result = await runCodexAgentTurn({
        runId,
        sessionKey,
        ...(activeSessionId ? { persistedSessionId: activeSessionId } : {}),
        prompt: nextPrompt,
        systemPrompt: args.systemPrompt,

        tools: imageToolMetadata,
        cwd: localCliCwd,
        stellaDataDir: args.opts.stellaDataDir,
        stellaAppDir: args.opts.stellaAppDir,
        ...(args.opts.cliBridgeSocketPath
          ? { cliBridgeSocketPath: args.opts.cliBridgeSocketPath }
          : {}),
        stellaModel: args.opts.agentContext.model,
        ...(codexModelOverride ? { modelOverride: codexModelOverride } : {}),
        ...(codexReasoningEffort
          ? {
              reasoningEffort: codexReasoningEffort,
              ...(inheritedCodexConfig
                ? { reasoningEffortResolved: true }
                : {}),
            }
          : {}),
        ...(codexServiceTier ? { serviceTier: codexServiceTier } : {}),
        attachments: nextAttachments,
        abortSignal: args.opts.abortSignal,
        onTurnControl: ({
          steer,
        }: {
          steer: (input: {
            prompt: string;
            attachments?: RuntimeAttachmentRef[];
          }) => Promise<void>;
        }) =>
          args.liveAgent?.beginSteerableTurn(() => {
            nativeSteerDispatch = nativeSteerDispatch.then(async () => {
              const entries = args.liveAgent?.drainSteering() ?? [];
              if (entries.length === 0) return;
              const promptMessages = entries.map(formatQueuedClaudeMessage);
              try {
                await steer({
                  prompt: buildCodexPromptFromMessages({ promptMessages }),
                  attachments: attachmentsFromQueuedMessages(entries),
                });

                publishQueuedUserMessageStarts({
                  entries,
                  runEvents,
                  callbacks: args.callbacks,
                });
              } catch {

                args.liveAgent?.prepend(entries);
              }
            });
          }),
        onStatus: (status) => {
          args.opts.onProgress?.(status);
          args.callbacks?.onStatus?.(runEvents.recordStatus(status));
        },
        onReasoning: (chunk) => {
          args.callbacks?.onReasoning?.(runEvents.recordReasoning(chunk));
        },
        onCommandExecution: emitCodexCommandExecution,
        onStream: (chunk) => {

          assistantUpdateBuffer.append(chunk);
          args.opts.onProgress?.(chunk);
          runEvents.noteAssistantTextChunk(chunk);
        },
        onSessionId: (sessionId) => {
          activeSessionId = sessionId;
          persistCodexSessionId(sessionId);
        },
        onToolUpdate: ({ update }) => emitToolUpdateStatus(update),
        executeTool: executeCodexTool,
        reuseAppServer: true,
        streamFinalAnswer: args.session.kind === "orchestrator",
      });
      assistantUpdateBuffer.discard();
      activeSessionId = result.sessionId;
      finalResult = result;
      completedThisTurn = true;
    } catch (error) {
      assistantUpdateBuffer.flushOnTermination();
      throw error;
    }
    await nativeSteerDispatch;

    const queued = args.liveAgent?.drain() ?? [];
    if (queued.length === 0) {
      if (completedThisTurn && finalResult) {

        args.liveAgent?.finish();
        break;
      }
      throw new Error("External engine steering message was lost.");
    }
    publishQueuedUserMessageStarts({
      entries: queued,
      runEvents,
      callbacks: args.callbacks,
    });
    const queuedPromptMessages = queued.map(formatQueuedClaudeMessage);
    const queuedAttachments = attachmentsFromQueuedMessages(queued);
    nextPrompt = buildCodexPromptFromMessages({
      promptMessages: queuedPromptMessages,
    });
    nextAttachments = queuedAttachments;
  }

  if (!finalResult) {
    throw new Error("Codex completed without a final result.");
  }

  await persistAssistantReply({
    store: args.opts.store,
    threadKey,
    resolvedLlm: args.opts.resolvedLlm,
    agentType: args.opts.agentType,
    content: finalResult.text,
    stellaDataDir: args.opts.stellaDataDir,
  });
  const assistantMessageEvent = runEvents.recordAssistantTextEnd(
    finalResult.text,
  );
  if (assistantMessageEvent) {
    args.callbacks?.onAssistantMessage?.(assistantMessageEvent);
  }
  persistCodexSessionId(finalResult.sessionId);

  return {
    finalText: finalResult.text,
    sessionId: finalResult.sessionId,
    ...(finalResult.fileChanges?.length
      ? { fileChanges: finalResult.fileChanges }
      : {}),
  };
};

export const runExternalOrchestratorTurn = async (
  opts: OrchestratorRunOptions,
): Promise<string | null> => {
  const engine = selectExternalOrchestratorEngine(opts);
  if (!engine) {
    return null;
  }

  const session = createExternalOrchestratorRunSession(opts, {
    runId: opts.runId ?? `local:${crypto.randomUUID()}`,
  });
  const liveAgent = createExternalLiveAgent();

  try {

    const systemPrompt = await buildRuntimeSystemPrompt({
      ...opts,
      runId: session.runId,
    });
    const promptMessages = await buildOrchestratorPromptMessages({
      context: opts.agentContext,
      userPrompt: opts.userPrompt,
      promptMessages: opts.promptMessages,
      stellaDataDir: opts.stellaDataDir,
      stellaAppDir: opts.stellaAppDir,
      agentType: opts.agentType,
      hookContext: {
        ...(opts.hookEmitter ? { hookEmitter: opts.hookEmitter } : {}),
        conversationId: opts.conversationId,
        threadKey: session.threadKey,
        runId: session.runId,
        ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
      },
    });
    opts.onExecutionSessionCreated?.({
      runId: session.runId,
      threadKey: session.threadKey,
      engine: "external",
      queueUserMessageId: session.runEvents.queueUserMessageId,
      agent: liveAgent.agent,
    });
    const result = await runClaudeHostedTurn({
      opts,
      session,
      systemPrompt,
      promptMessages,
      callbacks: opts.callbacks,
      liveAgent,
    });
    return await session.finalizeSuccess(result.finalText);
  } catch (error) {
    const interruptedReason = resolveInterruptionReason({
      abortSignal: opts.abortSignal,
      error,
    });
    if (interruptedReason) {
      return session.finalizeInterrupted(interruptedReason);
    }
    session.finalizeError(error);
    throw markOrchestratorErrorReported(error);
  } finally {
    liveAgent.finish();

    opts.orchestratorSession?.notifyHistoryChanged();
  }
};

export const runExternalSubagentTurn = async (
  opts: SubagentRunOptions,
): Promise<SubagentRunResult | null> => {
  if (!shouldUseClaudeCodeRuntime(opts)) {
    const useCodex =
      !usesManagedSubscriptionHarness(opts.agentContext.modelConfigSnapshot) &&
      shouldUseCodexAgentRuntime({
        agentType: opts.agentType,
        agentEngine: opts.agentContext.agentEngine,
      });
    if (!useCodex) {
      return null;
    }

    const session = createExternalSubagentRunSession(opts, {
      runId: opts.runId ?? `local:sub:${crypto.randomUUID()}`,
    });
    const liveAgent = createExternalLiveAgent();
    const detachLiveAgent = opts.subagentSession?.attachExternalLiveAgent?.(
      liveAgent.agent,
      {
        store: opts.store,
        runId: session.runId,
        ...(typeof opts.agentContext.attemptGeneration === "number"
          ? { attemptGeneration: opts.agentContext.attemptGeneration }
          : {}),
      },
    );

    try {
      const promptMessages = await buildSubagentPromptMessages({
        context: opts.agentContext,
        userPrompt: opts.userPrompt,
        promptMessages: opts.promptMessages,
        stellaDataDir: opts.stellaDataDir,
        stellaAppDir: opts.stellaAppDir,
        agentType: opts.agentType,
        hookContext: {
          ...(opts.hookEmitter ? { hookEmitter: opts.hookEmitter } : {}),
          conversationId: opts.conversationId,
          threadKey: session.threadKey,
          runId: session.runId,
          ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
        },
      });
      const systemPrompt = await buildSubagentSystemPrompt({
        ...opts,
        runId: session.runId,
      });
      const result = await runCodexHostedTurn({
        opts,
        session,
        systemPrompt,
        promptMessages,
        callbacks: opts.callbacks,
        liveAgent,
      });
      const finalized = await session.finalizeSuccess(result.finalText);
      if (result.fileChanges?.length) {
        finalized.fileChanges = result.fileChanges;
      }
      return finalized;
    } catch (error) {
      const interruptedReason = resolveInterruptionReason({
        abortSignal: opts.abortSignal,
        error,
      });
      if (interruptedReason) {
        return session.finalizeInterrupted(interruptedReason);
      }
      return session.finalizeError(error);
    } finally {
      detachLiveAgent?.();
      liveAgent.finish();
    }
  }

  const session = createExternalSubagentRunSession(opts, {
    runId: opts.runId ?? `local:sub:${crypto.randomUUID()}`,
  });
  const liveAgent = createExternalLiveAgent();
  const detachLiveAgent = opts.subagentSession?.attachExternalLiveAgent?.(
    liveAgent.agent,
    {
      store: opts.store,
      runId: session.runId,
      ...(typeof opts.agentContext.attemptGeneration === "number"
        ? { attemptGeneration: opts.agentContext.attemptGeneration }
        : {}),
    },
  );

  try {
    const promptMessages = await buildSubagentPromptMessages({
      context: opts.agentContext,
      userPrompt: opts.userPrompt,
      promptMessages: opts.promptMessages,
      stellaDataDir: opts.stellaDataDir,
      stellaAppDir: opts.stellaAppDir,
      agentType: opts.agentType,
      hookContext: {
        ...(opts.hookEmitter ? { hookEmitter: opts.hookEmitter } : {}),
        conversationId: opts.conversationId,
        threadKey: session.threadKey,
        runId: session.runId,
        ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
      },
    });

    const systemPrompt = await buildSubagentSystemPrompt({
      ...opts,
      runId: session.runId,
    });
    const result = await runClaudeHostedTurn({
      opts,
      session,
      systemPrompt,
      promptMessages,
      callbacks: opts.callbacks,
      liveAgent,
    });
    const finalized = await session.finalizeSuccess(result.finalText);

    if (result.fileChanges?.length) {
      finalized.fileChanges = result.fileChanges;
    }
    return finalized;
  } catch (error) {
    const interruptedReason = resolveInterruptionReason({
      abortSignal: opts.abortSignal,
      error,
    });
    if (interruptedReason) {
      return session.finalizeInterrupted(interruptedReason);
    }
    return session.finalizeError(error);
  } finally {
    detachLiveAgent?.();
    liveAgent.finish();
  }
};

export const shutdownExternalEngineIntegrations = (): void => {
  shutdownClaudeCodeRuntime();
  shutdownCodexAppServerRuntime();
};
