import crypto from "crypto";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import type { RuntimeEndEvent } from "../agent-runtime/types.js";
import {
  createRuntimePromptAgentMessage,
  prepareRuntimeAttachments,
} from "../agent-runtime/run-preparation.js";
import {
  persistThreadCustomMessage,
  persistThreadPayloadMessage,
} from "../agent-runtime/thread-memory.js";
import { decorateUserTranscriptContent } from "../agent-runtime/transcript-decoration.js";
import { buildRuntimeThreadKey } from "../thread-runtime.js";
import { createRuntimeLogger } from "../debug.js";
import type { AgentMessage } from "../agent-core/types.js";
import type { LocalAgentContext } from "../agents/local-agent-manager.js";
import type { BuildAgentContextArgs } from "./context.js";
import type {
  ActiveOrchestratorSession,
  AgentCallbacks,
  ChatPayload,
  RunnerContext,
  RuntimeSendMessageInput,
  RuntimeSendUserMessageInput,
} from "./types.js";
import {
  createAutomationAgentCallbacks,
  createAutomationErrorResult,
  createAutomationFatalErrorHandler,
  createOrchestratorFatalErrorHandler,
  type AutomationTurnResult,
} from "./orchestrator-callbacks.js";
import { createOrchestratorCoordinator } from "./orchestrator-coordinator.js";
import {
  executeOrQueueSystemOrchestratorTurn,
  executeOrQueueUserOrchestratorTurn,
} from "./orchestrator-dispatch.js";
import { startPreparedOrchestratorRun } from "./orchestrator-launch.js";
import {
  prunePendingFollowUpReplies,
  recordPendingFollowUpReplyEntry,
  resolveLiveChatMessageDelivery,
} from "./shared.js";
import {
  getOrchestratorHealth,
  normalizeAutomationRunInput,
  normalizeChatRunInput,
} from "./orchestrator-policy.js";

const logger = createRuntimeLogger("runner.orchestrator");
const UI_VISIBILITY_HIDDEN = "hidden" as const;
const UI_VISIBILITY_VISIBLE = "visible" as const;

const asMetadataRecord = (
  value: unknown,
): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : undefined;

export const matchesSteerableOrchestratorSession = (args: {
  session: ActiveOrchestratorSession | null;
  conversationId: string;
  agentType?: string;
}): boolean => {
  const { session } = args;
  if (!session || !session.agent.state.isStreaming) return false;
  if (session.conversationId !== args.conversationId) return false;
  if (args.agentType && session.agentType !== args.agentType) return false;

  return true;
};

export const buildRuntimeSendPromptMessage = (
  input: Pick<
    RuntimeSendMessageInput,
    "customType" | "display" | "timestamp"
  >,
  text: string,
): NonNullable<ChatPayload["promptMessages"]>[number] => ({
  text,
  messageType: "message",
  customType: input.customType ?? "runtime.send_message",
  ...(input.display !== undefined ? { display: input.display } : {}),
  ...(typeof input.timestamp === "number" && Number.isFinite(input.timestamp)
    ? { timestamp: input.timestamp }
    : {}),
});

export const createOrchestratorController = (
  context: RunnerContext,
  deps: {
    buildAgentContext: (
      args: BuildAgentContextArgs,
    ) => Promise<LocalAgentContext>;
    resolveAgent: (agentType: string) => unknown;
    getConfiguredModel: (
      agentType: string,
      agent?: unknown,
    ) => string | undefined;
  },
) => {
  const coordinator = createOrchestratorCoordinator(context);
  const {
    cleanupRun,
    clearActiveOrchestratorRun,
    createRuntimeCallbacks,
    queueOrchestratorTurn,
    setFollowUpReplyFlusher,
  } = coordinator;
  const preExecutionCanceledRunIds = new Set<string>();
  const preparingRunIds = new Set<string>();

  type StartPreparedRunArgs = Parameters<
    typeof startPreparedOrchestratorRun
  >[0];
  const createSteerableCallbacks = (initialCallbacks: AgentCallbacks) => {
    let currentCallbacks = initialCallbacks;
    const callbackProxy: AgentCallbacks = {
      onRunStarted: (event) => currentCallbacks.onRunStarted?.(event),
      onUserMessage: (event) => currentCallbacks.onUserMessage?.(event),
      onAssistantMessage: (event) =>
        currentCallbacks.onAssistantMessage?.(event),
      onAgentReasoning: (event) => currentCallbacks.onAgentReasoning?.(event),
      onStatus: (event) => currentCallbacks.onStatus?.(event),
      onToolStart: (event) => currentCallbacks.onToolStart(event),
      onToolEnd: (event) => currentCallbacks.onToolEnd(event),
      onError: (event) => currentCallbacks.onError(event),
      onInterrupted: (event) => currentCallbacks.onInterrupted?.(event),
      onEnd: (event) => currentCallbacks.onEnd(event),
    };

    return {
      callbackProxy,
      switchTo(nextCallbacks: AgentCallbacks) {
        currentCallbacks = nextCallbacks;
      },
    };
  };

  const launchOrchestratorRun = async (args: {
    alreadyRunningError: string;
    conversationId: string;
    agentType: string;
    userPrompt: string;
    uiVisibility?: "visible" | "hidden";
    promptMessages?: ChatPayload["promptMessages"];
    attachments: StartPreparedRunArgs["attachments"];
    userMessageId: string;
    responseTarget?: StartPreparedRunArgs["responseTarget"];
    callbacks: AgentCallbacks;
    createRunCallbacks: (
      args: Parameters<StartPreparedRunArgs["createRuntimeCallbacks"]>[0],
      callbacks: AgentCallbacks,
    ) => ReturnType<StartPreparedRunArgs["createRuntimeCallbacks"]>;
    onPrepared?: StartPreparedRunArgs["onPrepared"];
  }): Promise<{ runId: string }> => {
    if (context.state.activeOrchestratorRunId) {
      throw new Error(args.alreadyRunningError);
    }

    const runId = `local:${crypto.randomUUID()}`;
    const steerableCallbacks = createSteerableCallbacks(args.callbacks);
    context.state.runCallbacksByRunId.set(runId, args.callbacks);
    if (args.uiVisibility !== UI_VISIBILITY_HIDDEN) {
      context.state.conversationCallbacks.set(
        args.conversationId,
        args.callbacks,
      );
    }
    args.callbacks.onRunStarted?.({
      runId,
      agentType: args.agentType,
      seq: 0,
      userMessageId: args.userMessageId,
      ...(args.responseTarget ? { responseTarget: args.responseTarget } : {}),
      ...(args.uiVisibility ? { uiVisibility: args.uiVisibility } : {}),
    });

    preparingRunIds.add(runId);
    try {
      await startPreparedOrchestratorRun({
        context,
        buildAgentContext: deps.buildAgentContext,
        runId,
        conversationId: args.conversationId,
        agentType: args.agentType,
        userPrompt: args.userPrompt,
        ...(args.uiVisibility ? { uiVisibility: args.uiVisibility } : {}),
        ...(args.promptMessages?.length
          ? { promptMessages: args.promptMessages }
          : {}),
        attachments: args.attachments,
        userMessageId: args.userMessageId,
        ...(args.responseTarget ? { responseTarget: args.responseTarget } : {}),
        createRuntimeCallbacks: (runArgs) =>
          args.createRunCallbacks(runArgs, steerableCallbacks.callbackProxy),
        cleanupRun,
        onPrepared: (prepared) => {
          args.onPrepared?.(prepared);
        },
        onExecutionSessionCreated: (session) => {
          if (context.state.activeOrchestratorRunId !== runId) {
            return;
          }
          context.state.activeOrchestratorSession = {
            ...session,
            conversationId: args.conversationId,
            agentType: args.agentType,
            uiVisibility: args.uiVisibility ?? UI_VISIBILITY_VISIBLE,
            queueCallbackSwitch: (callbacks) => {
              steerableCallbacks.switchTo(callbacks);
            },
            queueMessage: (
              message: AgentMessage,
              _delivery: "steer" | "followUp",
            ) => {

              session.agent.steer(message);
            },
          } satisfies ActiveOrchestratorSession;
        },
        onFatalError: createOrchestratorFatalErrorHandler({
          runId,
          agentType: args.agentType,
          callbacks: args.callbacks,
        }),
      });
    } catch (error) {
      if (preExecutionCanceledRunIds.delete(runId)) {
        return { runId };
      }
      try {
        args.callbacks.onError({
          runId,
          agentType: args.agentType,
          seq: 0,
          error: error instanceof Error ? error.message : String(error),
          fatal: true,
          ...(args.uiVisibility ? { uiVisibility: args.uiVisibility } : {}),
        });
      } finally {
        cleanupRun(runId);
      }
      throw error;
    } finally {
      preparingRunIds.delete(runId);
    }

    return { runId };
  };

  const startStreamingOrchestratorTurn = async (
    startArgs: {
      conversationId: string;
      userPrompt: string;
      promptMessages?: ChatPayload["promptMessages"];
      agentType: string;
      userMessageId: string;
      uiVisibility?: "visible" | "hidden";
      responseTarget?: StartPreparedRunArgs["responseTarget"];
    },
    callbacks: AgentCallbacks,
  ): Promise<{ runId: string }> => {
    const conversationId = startArgs.conversationId;
    const agentType = startArgs.agentType;
    const userPrompt = startArgs.userPrompt.trim();
    const promptMessages = startArgs.promptMessages;
    const hasPromptMessages = Boolean(
      promptMessages?.some((message) => message.text.trim().length > 0),
    );
    if (!userPrompt && !hasPromptMessages) {
      throw new Error("Missing user prompt");
    }

    return await launchOrchestratorRun({
      alreadyRunningError: "The orchestrator is already running.",
      conversationId,
      agentType,
      userPrompt,
      ...(startArgs.uiVisibility
        ? { uiVisibility: startArgs.uiVisibility }
        : {}),
      ...(promptMessages?.length ? { promptMessages } : {}),
      attachments: [],
      userMessageId: startArgs.userMessageId,
      ...(startArgs.responseTarget
        ? { responseTarget: startArgs.responseTarget }
        : {}),
      callbacks,
      createRunCallbacks: ({ runId }, callbacks) =>
        createRuntimeCallbacks(runId, callbacks),
    });
  };

  const agentHealthCheck = (modelOverride?: string) =>
    getOrchestratorHealth(context, deps, modelOverride);

  const getCallbacksForTarget = (args: {
    conversationId: string;
    callbackRunId?: string;
  }): AgentCallbacks | null => {
    const callbacks =
      (args.callbackRunId
        ? context.state.runCallbacksByRunId.get(args.callbackRunId)
        : null) ??
      context.state.conversationCallbacks.get(args.conversationId) ??
      null;
    if (!callbacks) {
      logger.debug("missing-conversation-callbacks", {
        conversationId: args.conversationId,
        callbackRunId: args.callbackRunId,
      });
    }
    return callbacks;
  };

  const getLiveOrchestratorSession = (
    conversationId: string,
    agentType?: string,
  ): ActiveOrchestratorSession | null => {
    const session = context.state.activeOrchestratorSession;
    return matchesSteerableOrchestratorSession({
      session,
      conversationId,
      ...(agentType ? { agentType } : {}),
    })
      ? session
      : null;
  };

  const persistInjectedUserMessage = (
    session: ActiveOrchestratorSession,
    text: string,
    timestamp: number,
  ): AgentMessage => {
    const payload = createRuntimePromptAgentMessage(
      {
        text,
        messageType: "user",
      },
      timestamp,
    );
    if (payload.role === "user") {
      persistThreadPayloadMessage(context.runtimeStore, {
        threadKey: session.threadKey,
        payload,
        preservePayloadExactly: true,
      });
    }
    return payload;
  };

  const persistAndQueueLiveChatMessages = async (args: {
    session: ActiveOrchestratorSession;
    userMessageId: string;
    userPrompt: string;
    promptMessages?: ChatPayload["promptMessages"];
    attachments: StartPreparedRunArgs["attachments"];
    callbacks: AgentCallbacks;
  }) => {
    const attachments =
      args.session.engine === "native"
        ? await prepareRuntimeAttachments(args.attachments)
        : args.attachments;
    const trimmedUserPrompt = args.userPrompt.trim();
    const promptInputs =
      args.promptMessages && args.promptMessages.length > 0
        ? [
            ...args.promptMessages,
            ...(trimmedUserPrompt
              ? [{ text: trimmedUserPrompt, messageType: "user" as const }]
              : []),
          ]
        : [{ text: trimmedUserPrompt, messageType: "user" as const }];
    const timestamp = Date.now();
    if (promptInputs.some((message) => message.messageType !== "message")) {

      args.session.uiVisibility = UI_VISIBILITY_VISIBLE;
      context.state.activeOrchestratorUiVisibility = UI_VISIBILITY_VISIBLE;
      args.session.queueUserMessageId(
        args.userMessageId,
        () => {
          args.session.queueCallbackSwitch(args.callbacks);

          prunePendingFollowUpReplies(
            context.state.pendingFollowUpReplies,
            args.session.conversationId,
            args.userMessageId,
          );
        },
        UI_VISIBILITY_VISIBLE,
      );
    }
    for (const [index, promptInput] of promptInputs.entries()) {
      const message = createRuntimePromptAgentMessage(
        {
          ...promptInput,
          ...(index === promptInputs.length - 1 && attachments?.length
            ? { attachments }
            : {}),
        },
        timestamp + index,
      );
      if (message.role === "user") {
        persistThreadPayloadMessage(context.runtimeStore, {
          threadKey: args.session.threadKey,
          payload: message,
          preservePayloadExactly: true,
        });
      }

      const delivery = resolveLiveChatMessageDelivery({
        role: message.role,
        engine: args.session.engine,
      });
      if (message.role === "user") {

        recordPendingFollowUpReply(
          args.session.conversationId,
          promptInput.text,
          args.userMessageId,
        );
      }
      args.session.queueMessage(message, delivery);
    }
  };

  const recordPendingFollowUpReply = (
    conversationId: string,
    text: string,
    userMessageId?: string,
  ): void => {
    recordPendingFollowUpReplyEntry(
      context.state.pendingFollowUpReplies,
      conversationId,
      { text, ...(userMessageId ? { userMessageId } : {}) },
    );
  };

  const flushPendingFollowUpReplies = (conversationId: string): void => {
    const pending = context.state.pendingFollowUpReplies.get(conversationId);
    context.state.pendingFollowUpReplies.delete(conversationId);
    if (!pending || pending.length === 0) {
      return;
    }
    const callbacks = getCallbacksForTarget({ conversationId });
    if (!callbacks) {
      return;
    }
    const combinedText = pending.map((entry) => entry.text).join("\n\n");
    queueOrchestratorTurn({
      priority: "user",
      execute: async () => {
        await startStreamingOrchestratorTurn(
          {
            conversationId,
            userPrompt: "",
            promptMessages: [
              {
                text:
                  "The user sent the following message(s) while you were " +
                  "finishing the previous task, and they were never answered " +
                  "because that run ended early. Reply to them now as a " +
                  "direct response to the user:\n\n" +
                  combinedText,
                messageType: "message",
                customType: "runtime.queued_message_reply",
                uiVisibility: UI_VISIBILITY_HIDDEN,
              },
            ],
            agentType: AGENT_IDS.ORCHESTRATOR,
            userMessageId: `message:${crypto.randomUUID()}`,
            uiVisibility: UI_VISIBILITY_VISIBLE,
          },
          callbacks,
        );
      },
    });
  };

  setFollowUpReplyFlusher(flushPendingFollowUpReplies);

  const sendMessage = async (input: RuntimeSendMessageInput): Promise<void> => {
    const text = input.text.trim();
    if (!text) {
      return;
    }
    const callbacks = getCallbacksForTarget({
      conversationId: input.conversationId,
      callbackRunId: input.callbackRunId,
    });
    if (!callbacks) {
      return;
    }
    const health = agentHealthCheck();
    if (!health.ready) {
      throw new Error(health.reason ?? "Stella runtime not ready");
    }
    const delivery = "steer" as const;
    const liveSession = getLiveOrchestratorSession(
      input.conversationId,
      input.agentType,
    );
    if (liveSession) {
      const promptMessage = buildRuntimeSendPromptMessage(input, text);
      const message = createRuntimePromptAgentMessage(
        promptMessage,
        promptMessage.timestamp ?? Date.now(),
      );
      if (
        message.role === "runtimeInternal" &&
        message.customType &&
        message.customType !== "runtime.task_lifecycle"
      ) {
        persistThreadCustomMessage(context.runtimeStore, {
          threadKey: liveSession.threadKey,
          customType: message.customType,
          content: message.content,
          display: message.display === true,
          timestamp: message.timestamp,
          preservePayloadExactly: true,
        });
        context.state.orchestratorSessions
          .get(input.conversationId)
          ?.notifyHistoryChanged();
      }
      liveSession.queueMessage(message, delivery);
      return;
    }

    await executeOrQueueSystemOrchestratorTurn({
      hasActiveRun: Boolean(context.state.activeOrchestratorRunId),
      queueOrchestratorTurn,
      execute: async () => {
        const promptMessages: NonNullable<ChatPayload["promptMessages"]> = [
          buildRuntimeSendPromptMessage(input, text),
        ];
        await startStreamingOrchestratorTurn(
          {
            conversationId: input.conversationId,
            userPrompt: "",
            promptMessages,
            agentType: input.agentType ?? AGENT_IDS.ORCHESTRATOR,
            userMessageId: `message:${crypto.randomUUID()}`,
            uiVisibility: UI_VISIBILITY_VISIBLE,
            ...(input.responseTarget
              ? { responseTarget: input.responseTarget }
              : {}),
          },
          callbacks,
        );
      },
    });
  };

  const sendUserMessage = async (
    input: RuntimeSendUserMessageInput,
  ): Promise<void> => {
    const text = input.text.trim();
    if (!text) {
      return;
    }
    const callbacks = getCallbacksForTarget({
      conversationId: input.conversationId,
    });
    if (!callbacks) {
      return;
    }
    const health = agentHealthCheck();
    if (!health.ready) {
      throw new Error(health.reason ?? "Stella runtime not ready");
    }

    const userMessageId = `local:${crypto.randomUUID()}`;
    const uiVisibility = input.uiVisibility ?? UI_VISIBILITY_VISIBLE;
    const runtimePromptVisibility = UI_VISIBILITY_HIDDEN;
    const delivery = "steer" as const;
    const timestamp = Date.now();
    const metadata = asMetadataRecord(input.metadata);
    const uiMetadata = asMetadataRecord(metadata?.ui);
    const nextMetadata =
      metadata || uiVisibility === UI_VISIBILITY_HIDDEN
        ? {
            ...(metadata ?? {}),
            ui: {
              ...(uiMetadata ?? {}),
              visibility: uiVisibility,
            },
          }
        : undefined;
    if (uiVisibility !== UI_VISIBILITY_HIDDEN) {
      context.appendLocalChatEvent?.({
        conversationId: input.conversationId,
        type: "user_message",
        requestId: userMessageId,
        timestamp,
        payload: {
          text,
          ...(nextMetadata ? { metadata: nextMetadata } : {}),
        },
      });
    }
    const liveSession = getLiveOrchestratorSession(
      input.conversationId,
      input.agentType,
    );
    if (liveSession) {
      if (uiVisibility === UI_VISIBILITY_VISIBLE) {
        liveSession.uiVisibility = UI_VISIBILITY_VISIBLE;
        context.state.activeOrchestratorUiVisibility = UI_VISIBILITY_VISIBLE;
      }
      liveSession.queueUserMessageId(
        userMessageId,
        () => {
          liveSession.queueCallbackSwitch(callbacks);
          prunePendingFollowUpReplies(
            context.state.pendingFollowUpReplies,
            liveSession.conversationId,
            userMessageId,
          );
        },
        uiVisibility,
      );
      const message = persistInjectedUserMessage(liveSession, text, timestamp);
      recordPendingFollowUpReply(
        liveSession.conversationId,
        text,
        userMessageId,
      );
      liveSession.queueMessage(message, delivery);
      return;
    }

    await executeOrQueueUserOrchestratorTurn({
      hasActiveRun: Boolean(context.state.activeOrchestratorRunId),
      queueOrchestratorTurn,
      execute: async () =>
        await startLocalChatTurn(
          {
            conversationId: input.conversationId,
            userMessageId,
            userPrompt: "",
            promptMessages: [
              {
                text,
                uiVisibility: runtimePromptVisibility,
                messageType: "user",
              },
            ],
            agentType: input.agentType,
          },
          callbacks,
        ),
    });
  };

  const startLocalChatTurn = async (
    payload: ChatPayload,
    callbacks: AgentCallbacks,
  ): Promise<{ runId: string }> => {
    const {
      conversationId,
      agentType,
      userPrompt,
      promptMessages,
      attachments,
    } = normalizeChatRunInput(payload);
    const hasPromptMessages = Boolean(
      promptMessages?.some((message) => message.text.trim().length > 0),
    );
    if (!userPrompt && attachments.length === 0 && !hasPromptMessages) {
      throw new Error("Missing user prompt");
    }

    const liveSession = getLiveOrchestratorSession(conversationId, agentType);
    if (liveSession) {
      await persistAndQueueLiveChatMessages({
        session: liveSession,
        userMessageId: payload.userMessageId,
        userPrompt,
        promptMessages,
        attachments,
        callbacks,
      });
      return { runId: liveSession.runId };
    }

    return await launchOrchestratorRun({
      alreadyRunningError:
        "The orchestrator is already running. Wait for it to finish before starting another run.",
      conversationId,
      agentType,
      userPrompt,
      ...(promptMessages?.length ? { promptMessages } : {}),
      attachments,
      userMessageId: payload.userMessageId,
      callbacks,
      createRunCallbacks: ({ runId }, callbacks) =>
        createRuntimeCallbacks(runId, callbacks),
      onPrepared: (prepared) => {
        const runId = prepared.runId;
        logger.debug("handleLocalChat", {
          runId,
          agentType,
          model: prepared.agentContext.model,
          resolvedModel: prepared.resolvedLlm.model.id,
          conversationId,
          tools: prepared.agentContext.toolsAllowlist ?? [],
          threadHistoryCount: prepared.agentContext.threadHistory?.length ?? 0,
        });
      },
    });
  };

  const handleLocalChat = async (
    payload: ChatPayload,
    callbacks: AgentCallbacks,
  ): Promise<{ runId: string }> => {
    const health = agentHealthCheck();
    if (!health.ready) {
      throw new Error(health.reason ?? "Stella runtime not ready");
    }

    const liveSession = getLiveOrchestratorSession(
      payload.conversationId,
      payload.agentType,
    );
    if (liveSession) {
      return await startLocalChatTurn(payload, callbacks);
    }

    return await executeOrQueueUserOrchestratorTurn({
      hasActiveRun: Boolean(context.state.activeOrchestratorRunId),
      queueOrchestratorTurn,
      execute: async () => await startLocalChatTurn(payload, callbacks),
    });
  };

  const startAutomationTurn = async (
    payload: {
      conversationId: string;
      userPrompt: string;
      agentType?: string;
      modelOverride?: string;
      toolWorkspaceRoot?: string;
      attachments?: StartPreparedRunArgs["attachments"];
      connectorDeliveryTarget?: StartPreparedRunArgs["connectorDeliveryTarget"];
      userMessageEventId?: string;
    },
    resolveResult: (value: AutomationTurnResult) => void,
  ): Promise<{ runId: string }> => {
    try {
      if (context.state.activeOrchestratorRunId) {
        throw new Error("The orchestrator is already running.");
      }

      const {
        conversationId,
        userPrompt,
        agentType,
        modelOverride,
        toolWorkspaceRoot,
        attachments,
        connectorDeliveryTarget,
      } = normalizeAutomationRunInput(payload);
      if (!conversationId) {
        resolveResult(createAutomationErrorResult("Missing conversationId"));
        return { runId: "" };
      }
      if (!userPrompt) {
        resolveResult(createAutomationErrorResult("Missing user prompt"));
        return { runId: "" };
      }

      const runId = `local:auto:${crypto.randomUUID()}`;

      const modelUserPrompt = connectorDeliveryTarget
        ? decorateUserTranscriptContent({
            store: context.runtimeStore,
            threadKey: buildRuntimeThreadKey({
              conversationId,
              agentType,
              runId,
            }),
            text: userPrompt,
            timestamp: Date.now(),
          })
        : userPrompt;
      const appendConnectorTerminalNotice = (event: RuntimeEndEvent) => {
        if (!connectorDeliveryTarget) {
          return;
        }
        if (event.responseTarget?.type !== "agent_terminal_notice") {
          return;
        }
        const text = event.finalText.trim();
        if (!text) {
          return;
        }
        context.appendLocalChatEvent?.({
          conversationId,
          type: "assistant_message",
          payload: { text },
        });
      };
      await startPreparedOrchestratorRun({
        context,
        buildAgentContext: deps.buildAgentContext,
        runId,
        conversationId,
        agentType,
        userPrompt: modelUserPrompt,
        ...(modelOverride ? { modelOverride } : {}),
        ...(toolWorkspaceRoot ? { toolWorkspaceRoot } : {}),
        uiVisibility: "hidden",
        attachments,
        ...(connectorDeliveryTarget ? { connectorDeliveryTarget } : {}),

        userMessageId:
          payload.userMessageEventId?.trim() ||
          `automation:${crypto.randomUUID()}`,
        createRuntimeCallbacks: ({ runId }) =>
          createRuntimeCallbacks(
            runId,
            createAutomationAgentCallbacks(resolveResult, {
              onEnd: appendConnectorTerminalNotice,
            }),
          ),
        cleanupRun,
        onFatalError: createAutomationFatalErrorHandler(resolveResult),
      });

      return { runId };
    } catch (error) {

      resolveResult(
        createAutomationErrorResult((error as Error)?.message ?? String(error)),
      );
      return { runId: "" };
    }
  };

  const runAutomationTurn = async (payload: {
    conversationId: string;
    userPrompt: string;
    agentType?: string;
    modelOverride?: string;
    toolWorkspaceRoot?: string;
    attachments?: StartPreparedRunArgs["attachments"];
    connectorDeliveryTarget?: StartPreparedRunArgs["connectorDeliveryTarget"];
    userMessageEventId?: string;
  }): Promise<AutomationTurnResult> => {

    const health = agentHealthCheck(payload.modelOverride);
    if (!health.ready) {
      return createAutomationErrorResult(
        health.reason ?? "Stella runtime not ready",
      );
    }

    return await new Promise<AutomationTurnResult>((resolve) => {
      void executeOrQueueSystemOrchestratorTurn({
        hasActiveRun: Boolean(context.state.activeOrchestratorRunId),
        queueOrchestratorTurn,
        execute: async () => {
          await startAutomationTurn(payload, resolve);
        },
      });
    });
  };

  const cancelLocalChat = (runId: string) => {
    const controller = context.state.activeRunAbortControllers.get(runId);
    if (!controller) return;
    const wasPreExecution = preparingRunIds.has(runId);
    const uiVisibility = context.state.activeOrchestratorUiVisibility;
    const callbacks = context.state.runCallbacksByRunId.get(runId);
    controller.abort();
    if (wasPreExecution) {
      preExecutionCanceledRunIds.add(runId);
      cleanupRun(runId);
      callbacks?.onInterrupted?.({
        runId,
        agentType: AGENT_IDS.ORCHESTRATOR,
        uiVisibility,
        reason: "Canceled",
      });
      return;
    }
    context.state.activeRunAbortControllers.delete(runId);
    clearActiveOrchestratorRun(runId);
  };

  const cancelLocalChatByConversation = (conversationId: string): boolean => {
    const activeConversationId = context.state.activeOrchestratorConversationId;
    const activeRunId = context.state.activeOrchestratorRunId;
    if (!activeRunId || activeConversationId !== conversationId) {
      return false;
    }
    cancelLocalChat(activeRunId);
    return true;
  };

  const getActiveOrchestratorRun = (): {
    runId: string;
    conversationId: string;
    uiVisibility?: "visible" | "hidden";
  } | null => {
    if (
      !context.state.activeOrchestratorRunId ||
      !context.state.activeOrchestratorConversationId
    ) {
      return null;
    }
    return {
      runId: context.state.activeOrchestratorRunId,
      conversationId: context.state.activeOrchestratorConversationId,
      uiVisibility: context.state.activeOrchestratorUiVisibility,
    };
  };

  return {
    agentHealthCheck,
    queueOrchestratorTurn,
    startStreamingOrchestratorTurn,
    handleLocalChat,
    sendMessage,
    sendUserMessage,
    runAutomationTurn,
    cancelLocalChat,
    cancelLocalChatByConversation,
    getActiveOrchestratorRun,
  };
};
