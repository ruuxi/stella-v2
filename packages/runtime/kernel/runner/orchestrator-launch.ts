import {
  runOrchestratorTurn,
  type RuntimeRunCallbacks,
} from "../agent-runtime.js";
import type { LocalAgentContext } from "../agents/local-agent-manager.js";
import { getOrCreateOrchestratorSession } from "../agent-runtime/orchestrator-session.js";
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

type BuildAgentContext = (
  args: BuildAgentContextArgs,
) => Promise<LocalAgentContext>;

export type PreparedOrchestratorRun = {
  runId: string;
  conversationId: string;
  agentType: string;
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
    try {
      await runOrchestratorTurn({
        runId: prepared.runId,
        conversationId: prepared.conversationId,
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
        callbacks: args.runtimeCallbacks,
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
    } finally {
      context.toolHost.endBrowserTurn(prepared.runId, "retain-tabs");
    }
  })().catch((error) => {
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
