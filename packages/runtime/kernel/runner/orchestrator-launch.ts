import {
  runOrchestratorTurn,
  type RuntimeEndEvent,
  type RuntimeErrorEvent,
  type RuntimeRunCallbacks,
} from "../agent-runtime.js";
import type { RuntimeInterruptedEvent } from "../agent-runtime/types.js";
import type { LocalAgentContext } from "../agents/local-agent-manager.js";
import { getOrCreateOrchestratorSession } from "../agent-runtime/orchestrator-session.js";
import { createRuntimePromptAgentMessage } from "../agent-runtime/run-preparation.js";
import { buildThreadMessagePreview } from "../agent-runtime/thread-memory.js";
import {
  resolveAgentModelRoute,
  type BuildAgentContextArgs,
} from "./context.js";
import { isReportedOrchestratorError } from "../agent-runtime/run-completion.js";
import { ensureRunCoordinator } from "./run-coordinator.js";
import type { RunnerContext } from "./types.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
} from "@stella/contracts/protocol";
import { agentHasCapability } from "@stella/contracts/agent-runtime";
import type { PersistedRuntimeThreadPayload } from "../storage/shared.js";
import { CloudTranscriptAlreadyAdmittedError } from "./cloud-transcript-write.js";

type BuildAgentContext = (
  args: BuildAgentContextArgs,
) => Promise<LocalAgentContext>;

type DeferredTerminalCallback =
  | { kind: "end"; event: RuntimeEndEvent }
  | { kind: "error"; event: RuntimeErrorEvent }
  | { kind: "interrupted"; event: RuntimeInterruptedEvent };

const buildCloudUserMessage = (
  prepared: PreparedOrchestratorRun,
): PersistedRuntimeThreadPayload => {
  const promptMessages = prepared.promptMessages ?? [];
  let promptInput: RuntimePromptMessage & {
    attachments?: RuntimeAttachmentRef[];
  } = {
    text: prepared.userPrompt,
    attachments: prepared.attachments,
  };
  for (let index = promptMessages.length - 1; index >= 0; index -= 1) {
    const candidate = promptMessages[index]!;
    if ((candidate.messageType ?? "user") !== "user") continue;
    promptInput = {
      ...candidate,
      ...(index === promptMessages.length - 1 && prepared.attachments.length
        ? { attachments: prepared.attachments }
        : {}),
    };
    break;
  }
  const message = createRuntimePromptAgentMessage(promptInput, Date.now());
  if (message.role !== "user") {
    throw new Error("Cloud local turns require a user message.");
  }
  return message;
};

export const parseCanonicalCloudHistory = (
  serializedHistory: string[],
): NonNullable<LocalAgentContext["threadHistory"]> =>
  serializedHistory.map((serialized, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new Error(`Cloud transcript history row ${index} is invalid JSON.`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`Cloud transcript history row ${index} is invalid.`);
    }
    const role = (parsed as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant" && role !== "toolResult") {
      throw new Error(
        `Cloud transcript history row ${index} has an invalid role.`,
      );
    }
    const payload = parsed as PersistedRuntimeThreadPayload;
    return {
      timestamp:
        typeof (payload as { timestamp?: unknown }).timestamp === "number"
          ? (payload as { timestamp: number }).timestamp
          : undefined,
      role,
      content: buildThreadMessagePreview(payload),
      ...(payload.role === "toolResult"
        ? { toolCallId: payload.toolCallId }
        : {}),
      payload,
    };
  });

const cloudFinishPhase = (
  terminal: DeferredTerminalCallback | null,
  error: unknown,
): {
  phase: "completed" | "failed" | "canceled" | "timeout";
  notice?: string;
} => {
  if (terminal?.kind === "interrupted") {
    const timedOut = /time(?:d)?\s*out|timeout/i.test(terminal.event.reason);
    return timedOut
      ? { phase: "timeout", notice: "The local turn timed out." }
      : { phase: "canceled", notice: "The local turn was canceled." };
  }
  if (terminal?.kind === "error" || error !== undefined) {
    return {
      phase: "failed",
      notice: "The local turn did not finish.",
    };
  }
  return { phase: "completed" };
};

const flushDeferredTerminal = (
  callbacks: RuntimeRunCallbacks,
  terminal: DeferredTerminalCallback | null,
): void => {
  if (!terminal) return;
  if (terminal.kind === "end") {
    callbacks.onEnd(terminal.event);
    return;
  }
  if (terminal.kind === "error") {
    callbacks.onError(terminal.event);
    return;
  }
  callbacks.onInterrupted?.(terminal.event);
};

export type PreparedOrchestratorRun = {
  runId: string;
  conversationId: string;
  agentType: string;
  storageMode?: "cloud" | "local";
  userPrompt: string;
  uiVisibility?: "visible" | "hidden";
  promptMessages?: RuntimePromptMessage[];
  responseTarget?: Parameters<typeof runOrchestratorTurn>[0]["responseTarget"];
  attachments: RuntimeAttachmentRef[];
  modelOverride?: string;
  connectorDeliveryTarget?: {
    requestId: string;
    conversationId: string;
    provider?: string;
    externalMessageId?: string;
  };
  toolWorkspaceRoot?: string;
  agentContext: LocalAgentContext;
  resolvedLlm: ResolvedLlmRoute;
  abortController: AbortController;
  /**
   * Memory-review user-turn counter AFTER incrementing for this run.
   * Only set when the run is a real user turn (Orchestrator + uiVisibility !== "hidden").
   * Consumed by finalizeOrchestratorSuccess to decide whether to spawn the review.
   */
  userTurnsSinceMemoryReview?: number;
};

export const prepareOrchestratorRun = async (args: {
  context: RunnerContext;
  buildAgentContext: BuildAgentContext;
  runId: string;
  conversationId: string;
  agentType: string;
  storageMode?: "cloud" | "local";
  userPrompt: string;
  uiVisibility?: "visible" | "hidden";
  promptMessages?: RuntimePromptMessage[];
  responseTarget?: Parameters<typeof runOrchestratorTurn>[0]["responseTarget"];
  attachments: RuntimeAttachmentRef[];
  modelOverride?: string;
  connectorDeliveryTarget?: {
    requestId: string;
    conversationId: string;
    provider?: string;
    externalMessageId?: string;
  };
  toolWorkspaceRoot?: string;
}): Promise<PreparedOrchestratorRun> => {
  const isUserTurn = args.uiVisibility !== "hidden";

  // Run admission is owned by the Effect run coordinator: it claims the
  // lane (throwing the canonical already-running error on a double
  // admission) and is the single writer of the active-run mirror.
  const runCoordinator = ensureRunCoordinator(args.context);
  runCoordinator.beginRun({
    runId: args.runId,
    conversationId: args.conversationId,
    uiVisibility: args.uiVisibility ?? "visible",
  });

  const abortController = new AbortController();
  args.context.state.activeRunAbortControllers.set(args.runId, abortController);

  try {
    const resolvedAgentModel = await resolveAgentModelRoute(
      args.context,
      args.agentType,
      args.modelOverride,
    );
    const resolvedLlm = resolvedAgentModel.resolvedLlm;
    if (abortController.signal.aborted) {
      throw new Error("Run canceled.");
    }
    const agentContext = await args.buildAgentContext({
      conversationId: args.conversationId,
      agentType: args.agentType,
      runId: args.runId,
      ...(args.toolWorkspaceRoot
        ? { toolWorkspaceRoot: args.toolWorkspaceRoot }
        : {}),
      ...resolvedAgentModel,
    });
    if (abortController.signal.aborted) {
      throw new Error("Run canceled.");
    }
    // Increment the memory-review counter only on real user-driven turns
    // for agents that declare the `triggersMemoryReview` capability.
    // Synthetic task-callback turns (uiVisibility === "hidden") and
    // capability-less agents do not count — they would inflate the counter
    // without representing user input.
    let userTurnsSinceMemoryReview: number | undefined;
    if (
      isUserTurn &&
      agentHasCapability(args.agentType, "triggersMemoryReview")
    ) {
      try {
        userTurnsSinceMemoryReview =
          args.context.runtimeStore.incrementUserTurnsSinceMemoryReview(
            args.conversationId,
          );
      } catch {
        // Memory review is best-effort. Counter failure must not block the turn.
      }
    }

    const prepared: PreparedOrchestratorRun = {
      runId: args.runId,
      conversationId: args.conversationId,
      agentType: args.agentType,
      ...(args.storageMode ? { storageMode: args.storageMode } : {}),
      userPrompt: args.userPrompt,
      ...(args.uiVisibility ? { uiVisibility: args.uiVisibility } : {}),
      promptMessages: args.promptMessages,
      ...(args.responseTarget ? { responseTarget: args.responseTarget } : {}),
      attachments: args.attachments,
      ...(args.connectorDeliveryTarget
        ? { connectorDeliveryTarget: args.connectorDeliveryTarget }
        : {}),
      ...(args.toolWorkspaceRoot
        ? { toolWorkspaceRoot: args.toolWorkspaceRoot }
        : {}),
      agentContext,
      resolvedLlm,
      abortController,
      ...(userTurnsSinceMemoryReview != null
        ? { userTurnsSinceMemoryReview }
        : {}),
    };
    return prepared;
  } catch (error) {
    runCoordinator.releaseRun(args.runId);
    args.context.state.activeRunAbortControllers.delete(args.runId);
    throw error;
  }
};

export const launchPreparedOrchestratorRun = (args: {
  context: RunnerContext;
  prepared: PreparedOrchestratorRun;
  userMessageId: string;
  runtimeCallbacks: RuntimeRunCallbacks;
  onExecutionSessionCreated?: NonNullable<
    Parameters<typeof runOrchestratorTurn>[0]["onExecutionSessionCreated"]
  >;
  cleanupRun: (runId: string, onCleanup?: () => void) => void;
  onFatalError: (error: unknown) => void;
}): void => {
  const { prepared, context } = args;

  const orchestratorSession = getOrCreateOrchestratorSession(
    context.state.orchestratorSessions,
    prepared.conversationId,
  );

  // The turn promise still owns run cleanup exactly as before (the catch
  // below is behavior-identical), but it is no longer fire-and-forget: the
  // kernel supervisor forks a root fiber for it whose interruption aborts
  // the run's controller and joins this promise, so user-cancel and worker
  // shutdown deterministically finalize the turn and everything beneath it.
  const settled = (async () => {
    const isCloudTurn = prepared.storageMode === "cloud";
    let leaseToken: string | null = null;
    let ephemeralCaptureStarted = false;
    let deferredTerminal: DeferredTerminalCallback | null = null;
    let runError: unknown;
    const callbacks: RuntimeRunCallbacks = isCloudTurn
      ? {
          ...args.runtimeCallbacks,
          onError: (event) => {
            if (event.fatal) {
              deferredTerminal = { kind: "error", event };
              return;
            }
            args.runtimeCallbacks.onError(event);
          },
          onEnd: (event) => {
            deferredTerminal = { kind: "end", event };
          },
          onInterrupted: (event) => {
            deferredTerminal = { kind: "interrupted", event };
          },
        }
      : args.runtimeCallbacks;

    try {
      if (isCloudTurn) {
        const userMessage = buildCloudUserMessage(prepared);
        const begin = await context.cloudTranscript.begin({
          conversationId: prepared.conversationId,
          localTurnId: prepared.runId,
          clientMsgId: args.userMessageId,
          userMessageJson: JSON.stringify(userMessage),
          onLeaseLost: (reason) => {
            prepared.abortController.abort(
              `Cloud conversation lease ended (${reason}).`,
            );
          },
          signal: prepared.abortController.signal,
        });
        leaseToken = begin.leaseToken;
        const canonicalHistory = parseCanonicalCloudHistory(begin.history);
        prepared.agentContext = {
          ...prepared.agentContext,
          threadHistory: canonicalHistory,
        };
        context.runtimeStore.beginEphemeralThreadCapture({
          threadKey: orchestratorSession.threadKey,
          captureId: prepared.runId,
          seedMessages: canonicalHistory,
        });
        ephemeralCaptureStarted = true;
        // The same long-lived native session may previously have been seeded
        // from local SQLite. Force its next turn to replace that state with
        // the Durable Object's canonical history. External engines read the
        // overwritten agentContext directly.
        orchestratorSession.notifyHistoryChanged();
        // Claude Code and Codex otherwise resume their own locally persisted
        // CLI transcript and skip Stella's supplied history. A cloud turn must
        // instead seed a fresh CLI session from the Durable Object window.
        context.runtimeStore.setThreadExternalSessionId(
          orchestratorSession.threadKey,
          null,
        );
        context.runtimeStore.setThreadExternalDeliveredEntryId(
          orchestratorSession.threadKey,
          null,
        );
      }

      await runOrchestratorTurn({
        runId: prepared.runId,
        conversationId: prepared.conversationId,
        storageMode: prepared.storageMode,
        userMessageId: args.userMessageId,
        agentType: prepared.agentType,
        userPrompt: prepared.userPrompt,
        ...(prepared.uiVisibility
          ? { uiVisibility: prepared.uiVisibility }
          : {}),
        ...(prepared.promptMessages?.length
          ? { promptMessages: prepared.promptMessages }
          : {}),
        ...(prepared.responseTarget
          ? { responseTarget: prepared.responseTarget }
          : {}),
        attachments: prepared.attachments,
        ...(prepared.connectorDeliveryTarget
          ? { connectorDeliveryTarget: prepared.connectorDeliveryTarget }
          : {}),
        agentContext: prepared.agentContext,
        callbacks,
        toolCatalog: context.toolHost.getToolCatalog(prepared.agentType, {
          model:
            prepared.resolvedLlm.toolPolicyModel ?? prepared.resolvedLlm.model,
          agentEngine: prepared.agentContext.agentEngine,
          includeDeferred: true,
        }),
        toolExecutor: async (
          toolName,
          toolArgs,
          toolContext,
          signal,
          onUpdate,
        ) =>
          await context.toolHost.executeTool(
            toolName,
            toolArgs,
            toolContext,
            signal,
            onUpdate,
          ),
        deviceId: context.deviceId,
        stellaDataDir: context.stellaDataDir,
        ...(context.cliBridgeSocketPath
          ? { cliBridgeSocketPath: context.cliBridgeSocketPath }
          : {}),
        resolvedLlm: prepared.resolvedLlm,
        store: context.runtimeStore,
        abortSignal: prepared.abortController.signal,
        stellaAppDir: context.stellaAppDir,
        ...(prepared.toolWorkspaceRoot
          ? { toolWorkspaceRoot: prepared.toolWorkspaceRoot }
          : {}),
        hookEmitter: context.hookEmitter,
        onExecutionSessionCreated: args.onExecutionSessionCreated,
        orchestratorSession,
        // Provider streams and tool calls opened by this turn supervise as
        // child fibers of the run's scope, so cancelRun/shutdown interrupts
        // them and joins their teardown.
        superviseRunResource: (resource) =>
          context.state.supervisor.adoptResource(
            prepared.runId,
            resource.label,
            {
              abort: resource.abort,
              settled: resource.settled,
            },
          ),
        compactionScheduler: context.state.compactionScheduler,
        ...(prepared.userTurnsSinceMemoryReview != null
          ? {
              userTurnsSinceMemoryReview: prepared.userTurnsSinceMemoryReview,
            }
          : {}),
      });
    } catch (error) {
      runError = error;
    }

    if (isCloudTurn && leaseToken && ephemeralCaptureStarted) {
      try {
        const records = context.runtimeStore
          .readEphemeralThreadCapture({
            threadKey: orchestratorSession.threadKey,
            captureId: prepared.runId,
          })
          .filter(
            (message) =>
              message.payload !== undefined &&
              (message.payload.role === "assistant" ||
                message.payload.role === "toolResult"),
          )
          .map((message, ordinal) => ({
            ordinal,
            role: message.payload!.role as "assistant" | "toolResult",
            payloadJson: JSON.stringify(message.payload),
          }));
        const reportCloudSyncFailure = (message: string): void => {
          args.runtimeCallbacks.onError({
            runId: prepared.runId,
            agentType: prepared.agentType,
            seq: Date.now(),
            error: message,
            fatal: false,
            ...(prepared.uiVisibility
              ? { uiVisibility: prepared.uiVisibility }
              : {}),
          });
        };
        const finishStatus = await context.cloudTranscript.finish({
          conversationId: prepared.conversationId,
          localTurnId: prepared.runId,
          leaseToken,
          records,
          ...cloudFinishPhase(deferredTerminal, runError),
          failureNotificationUserMessageId: args.userMessageId,
          onDeliveryFailure: reportCloudSyncFailure,
        });
        if (!finishStatus.queued) {
          reportCloudSyncFailure(
            "This response finished on this device but was too large to sync to your cloud conversation.",
          );
        }
        flushDeferredTerminal(args.runtimeCallbacks, deferredTerminal);
      } finally {
        context.runtimeStore.endEphemeralThreadCapture({
          threadKey: orchestratorSession.threadKey,
          captureId: prepared.runId,
        });
      }
    }
    if (runError !== undefined) throw runError;
  })().catch((error) => {
    if (error instanceof CloudTranscriptAlreadyAdmittedError) {
      // The cloud journal has already accepted this stable client message,
      // usually after an IPC response was lost across a desktop restart. The
      // canonical cloud feed owns reconciliation; emitting a fatal local error
      // here would turn successful deduplication into a false failure card.
      args.cleanupRun(prepared.runId);
      return;
    }
    if (isReportedOrchestratorError(error)) {
      return;
    }
    args.cleanupRun(prepared.runId);
    args.onFatalError(error);
  });

  context.state.supervisor.startRun(prepared.runId, {
    abort: (reason) => prepared.abortController.abort(reason),
    settled,
  });
};

export const startPreparedOrchestratorRun = async (args: {
  context: RunnerContext;
  buildAgentContext: BuildAgentContext;
  createRuntimeCallbacks: (args: {
    runId: string;
    prepared: PreparedOrchestratorRun;
  }) => RuntimeRunCallbacks;
  runId: string;
  conversationId: string;
  agentType: string;
  storageMode?: "cloud" | "local";
  userPrompt: string;
  uiVisibility?: "visible" | "hidden";
  promptMessages?: RuntimePromptMessage[];
  responseTarget?: Parameters<typeof runOrchestratorTurn>[0]["responseTarget"];
  attachments: RuntimeAttachmentRef[];
  modelOverride?: string;
  connectorDeliveryTarget?: {
    requestId: string;
    conversationId: string;
    provider?: string;
    externalMessageId?: string;
  };
  userMessageId: string;
  cleanupRun: (runId: string, onCleanup?: () => void) => void;
  onFatalError: (error: unknown) => void;
  onPrepared?: (prepared: PreparedOrchestratorRun) => void;
  onExecutionSessionCreated?: NonNullable<
    Parameters<typeof runOrchestratorTurn>[0]["onExecutionSessionCreated"]
  >;
}): Promise<{ runId: string; prepared: PreparedOrchestratorRun }> => {
  const prepared = await prepareOrchestratorRun({
    context: args.context,
    buildAgentContext: args.buildAgentContext,
    runId: args.runId,
    conversationId: args.conversationId,
    agentType: args.agentType,
    ...(args.storageMode ? { storageMode: args.storageMode } : {}),
    userPrompt: args.userPrompt,
    ...(args.uiVisibility ? { uiVisibility: args.uiVisibility } : {}),
    promptMessages: args.promptMessages,
    ...(args.responseTarget ? { responseTarget: args.responseTarget } : {}),
    attachments: args.attachments,
    ...(args.modelOverride ? { modelOverride: args.modelOverride } : {}),
    ...(args.connectorDeliveryTarget
      ? { connectorDeliveryTarget: args.connectorDeliveryTarget }
      : {}),
  });

  args.onPrepared?.(prepared);

  launchPreparedOrchestratorRun({
    context: args.context,
    prepared,
    userMessageId: args.userMessageId,
    runtimeCallbacks: args.createRuntimeCallbacks({
      runId: args.runId,
      prepared,
    }),
    onExecutionSessionCreated: args.onExecutionSessionCreated,
    cleanupRun: args.cleanupRun,
    onFatalError: args.onFatalError,
  });

  return { runId: args.runId, prepared };
};
