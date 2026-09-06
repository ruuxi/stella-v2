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
import { executionContextHistoryEntries } from "../agent-runtime/execution-context-history.js";
import {
  resolveAgentModelRoute,
  type BuildAgentContextArgs,
} from "./context.js";
import { isReportedOrchestratorError } from "../agent-runtime/run-completion.js";
import { ensureRunCoordinator } from "./run-coordinator.js";
import type { RunnerContext } from "./types.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import { createRunnerImageDescriptionService } from "./model-selection.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
} from "@stella/contracts/protocol";
import type { PersistedRuntimeThreadPayload } from "../storage/shared.js";
import {
  CloudTranscriptAlreadyAdmittedError,
  type CloudTranscriptBeginAck,
  type CloudTranscriptHistory,
} from "./cloud-transcript-write.js";

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
  const executionContext = prepared.agentContext.executionContext;
  return { ...message, ...(executionContext ? { executionContext } : {}) };
};

export const parseCanonicalCloudHistory = (
  serializedHistory: string[],
): NonNullable<LocalAgentContext["threadHistory"]> => {
  const messages = serializedHistory.map((serialized, index) => {
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
    return payload;
  });
  return executionContextHistoryEntries(messages).map((entry) => {
    const payload =
      entry.kind === "resident"
        ? createRuntimePromptAgentMessage(entry.prompt, entry.timestamp)
        : entry.message;
    return {
      timestamp:
        typeof (payload as { timestamp?: unknown }).timestamp === "number"
          ? (payload as { timestamp: number }).timestamp
          : undefined,
      role: payload.role,
      content: buildThreadMessagePreview(payload),
      ...(payload.role === "runtimeInternal"
        ? {
            customMessage: {
              customType: payload.customType,
              content: payload.content,
              display: false,
            },
          }
        : {}),
      ...(payload.role === "toolResult"
        ? { toolCallId: payload.toolCallId }
        : {}),
      payload,
    };
  });
};

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
  ownerGeneration?: string;
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
};

export const prepareOrchestratorRun = async (args: {
  context: RunnerContext;
  buildAgentContext: BuildAgentContext;
  runId: string;
  conversationId: string;
  agentType: string;
  storageMode?: "cloud" | "local";
  ownerGeneration?: string;
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
  /** Current turn's user-message id; excludes the just-appended display
   * event from the legacy pre-transition history shim. */
  userMessageId?: string;
}): Promise<PreparedOrchestratorRun> => {
  // Run admission is owned by the Effect run coordinator: it claims the
  // lane (throwing the canonical already-running error on a double
  // admission) and is the single writer of the active-run mirror.
  const runCoordinator = ensureRunCoordinator(args.context);
  runCoordinator.beginRun({
    runId: args.runId,
    conversationId: args.conversationId,
    uiVisibility: args.uiVisibility ?? "visible",
  });

  // The controller is the cooperative seam handed to the loop/tools (they
  // take plain AbortSignals); its lifecycle belongs to the run's supervisor
  // scope. Registering the abort at admission makes the pre-launch window
  // (model-route resolution, agent-context build) cancellable through the
  // same keyed fiber structure that owns the launched run — the replacement
  // for the old `activeRunAbortControllers` map entry.
  const abortController = new AbortController();
  args.context.state.supervisor.registerRun(args.runId, (reason) =>
    abortController.abort(reason),
  );

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
      ...(args.userMessageId
        ? { currentUserMessageId: args.userMessageId }
        : {}),
      ...resolvedAgentModel,
    });
    if (abortController.signal.aborted) {
      throw new Error("Run canceled.");
    }
    const prepared: PreparedOrchestratorRun = {
      runId: args.runId,
      conversationId: args.conversationId,
      agentType: args.agentType,
      ...(args.storageMode ? { storageMode: args.storageMode } : {}),
      ...(args.ownerGeneration
        ? { ownerGeneration: args.ownerGeneration }
        : {}),
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
    };
    return prepared;
  } catch (error) {
    runCoordinator.releaseRun(args.runId);
    // Admission failed before any fiber launched: drop the fiberless run
    // scope (and its registered abort) so the entry cannot leak.
    args.context.state.supervisor.discardRun(args.runId);
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
    const cloudOwnerGeneration = isCloudTurn
      ? prepared.ownerGeneration?.trim()
      : null;
    if (
      isCloudTurn &&
      (!cloudOwnerGeneration ||
        cloudOwnerGeneration.length > 512 ||
        /\s/.test(cloudOwnerGeneration))
    ) {
      throw new Error(
        "Cloud conversation owner generation is unavailable for this turn.",
      );
    }
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
        const beginCloudTurn = (): Promise<CloudTranscriptBeginAck> =>
          context.cloudTranscript.begin({
            conversationId: prepared.conversationId,
            ownerGeneration: cloudOwnerGeneration!,
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
        const seedCloudHistory = (window: CloudTranscriptHistory): void => {
          const canonicalHistory = parseCanonicalCloudHistory(window.history);
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
        };
        // A different device can advance the canonical journal while this
        // computer is idle. Acquire its lease and authoritative history before
        // provider output or tools can run; cached history is not an admission
        // fence and speculative work cannot safely be replayed after a conflict.
        if (!context.cloudTranscript.peekHistory(prepared.conversationId)) {
          void context.cloudTranscript.refreshHistory(prepared.conversationId);
        }
        const begin = await beginCloudTurn();
        leaseToken = begin.leaseToken;
        seedCloudHistory(begin);
      }

      const runPromise = runOrchestratorTurn({
        executionHost: "device",
        runId: prepared.runId,
        conversationId: prepared.conversationId,
        storageMode: prepared.storageMode,
        ownerGeneration: cloudOwnerGeneration ?? prepared.ownerGeneration,
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
        describeImages: createRunnerImageDescriptionService(
          context,
          prepared.resolvedLlm,
        ),
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
      });
      await runPromise;
    } catch (error) {
      runError = error;
    } finally {
      try {
        // Cloud terminal callbacks are deferred below, so profile durability
        // joins before transcript completion and the terminal event publish.
        await context.toolHost.endBrowserTurn(prepared.runId, "retain-tabs");
      } catch (browserFinalizationError) {
        // Preserve the original run failure when both paths fail; otherwise a
        // lost browser checkpoint makes this run fail deterministically.
        if (runError === undefined) {
          runError = browserFinalizationError;
        } else {
          console.error(
            "Browser turn finalization also failed after the run error:",
            browserFinalizationError,
          );
        }
      }
    }

    if (isCloudTurn && leaseToken) {
      try {
        const records = !ephemeralCaptureStarted
          ? []
          : context.runtimeStore
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
          ownerGeneration: cloudOwnerGeneration!,
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
        if (ephemeralCaptureStarted) {
          context.runtimeStore.endEphemeralThreadCapture({
            threadKey: orchestratorSession.threadKey,
            captureId: prepared.runId,
          });
        }
      }
    } else if (isCloudTurn && ephemeralCaptureStarted) {
      context.runtimeStore.endEphemeralThreadCapture({
        threadKey: orchestratorSession.threadKey,
        captureId: prepared.runId,
      });
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
  ownerGeneration?: string;
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
  onPrepared?: (prepared: PreparedOrchestratorRun) => void | Promise<void>;
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
    ...(args.ownerGeneration ? { ownerGeneration: args.ownerGeneration } : {}),
    userPrompt: args.userPrompt,
    ...(args.uiVisibility ? { uiVisibility: args.uiVisibility } : {}),
    promptMessages: args.promptMessages,
    ...(args.responseTarget ? { responseTarget: args.responseTarget } : {}),
    attachments: args.attachments,
    ...(args.modelOverride ? { modelOverride: args.modelOverride } : {}),
    ...(args.connectorDeliveryTarget
      ? { connectorDeliveryTarget: args.connectorDeliveryTarget }
      : {}),
    userMessageId: args.userMessageId,
  });

  try {
    await args.onPrepared?.(prepared);
    if (prepared.abortController.signal.aborted) {
      throw new Error("Run canceled before execution.");
    }
  } catch (error) {
    ensureRunCoordinator(args.context).releaseRun(args.runId);
    args.context.state.supervisor.discardRun(args.runId);
    throw error;
  }

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
