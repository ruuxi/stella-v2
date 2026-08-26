import {
  buildAgentContext,
  createRunnerContext,
  getConfiguredModel,
  resolveAgentEngineForRun,
  resolveEffectiveAgentExecutionConfig,
  resolveAgentModelRoute,
  resolveSubscriptionHarnessRouteModel,
  resolveAgent,
  sampleAgentEngineConfig,
} from "./runner/context.js";
import { createConvexSession } from "./runner/convex-session.js";
import { createOrchestratorController } from "./runner/orchestrator.js";
import { createRuntimeInitialization } from "./runner/runtime-initialization.js";
import { createStoreOperations } from "./runner/store-operations.js";
import { createAgentOrchestration } from "./runner/agent-orchestration.js";
import { buildRuntimeSystemPrompt } from "./agent-runtime/run-preparation.js";
import { decorateUserTranscriptContent } from "./agent-runtime/transcript-decoration.js";
import { getRuntimeToolMetadata } from "./agent-runtime/tool-adapters.js";
import { loadGoogleWorkspaceTools } from "./google-workspace/load-google-workspace-tools.js";
import {
  deleteConnectorAccessTokens,
  loadConnectorAccessToken,
} from "./connectors/oauth.js";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import {
  AGENT_ORPHANED_RESTART_CANCEL_REASON,
  AGENT_PAUSE_CANCEL_REASON,
  AGENT_SHUTDOWN_CANCEL_REASON,
} from "./agents/local-agent-manager.js";
import {
  convertRestartShutdownRecordAtBoot,
  fireRestartContinuationTurn,
  readRestartInterruptionState,
} from "./restart-continuation.js";
import type {
  RunnerPublicApi,
  StellaHostRunnerOptions,
} from "./runner/types.js";

export type { StellaHostRunnerOptions } from "./runner/types.js";
export {
  getConvexErrorCode,
  getConvexErrorMessage,
  isConvexDeviceKeyMismatchError,
  isConvexUnauthenticatedError,
  REMOTE_TURN_AUTH_GRACE_MS,
  REMOTE_TURN_MAX_TRANSIENT_UNAUTHENTICATED_ERRORS,
  shouldStopRemoteTurnForAuthFailure,
} from "./runner/remote-turn-auth.js";

import type { ToolResult } from "./tools/types.js";
import type { RuntimeRunCallbacks } from "./agent-runtime/types.js";
import type { RuntimeVoiceHistoryItem } from "@stella/contracts/protocol";
import {
  getAgentRuntimeEngine,
  getReasoningEffort,
  getSubscriptionHarnessEnabled,
} from "./preferences/local-preferences.js";

const VOICE_ORCHESTRATOR_HISTORY_LIMIT = 80;

const buildVoiceHistoryItems = (
  threadHistory:
    | Array<{
        timestamp?: number;
        role: string;
        content: string;
        toolCallId?: string;
      }>
    | undefined,
): RuntimeVoiceHistoryItem[] => {
  const entries = (threadHistory ?? []).slice(
    -VOICE_ORCHESTRATOR_HISTORY_LIMIT,
  );
  const history: RuntimeVoiceHistoryItem[] = [];
  for (const entry of entries) {
    const content = entry.content.trim();
    if (!content) continue;
    history.push({
      role: entry.role,
      content,
      ...(typeof entry.timestamp === "number" &&
      Number.isFinite(entry.timestamp)
        ? { timestamp: entry.timestamp }
        : {}),
      ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
    });
  }
  return history;
};

type GoogleWorkspaceAuthResult = {
  connected: boolean;
  unavailable?: boolean;
  email?: string;
  name?: string;
};

const getGoogleWorkspaceRecord = (
  value: unknown,
): Record<string, unknown> | null =>
  value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

const getGoogleWorkspaceString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const getGoogleWorkspacePrimaryArrayField = (
  value: unknown,
  fieldName: string,
): string | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  for (const entry of value) {
    const record = getGoogleWorkspaceRecord(entry);
    const fieldValue = getGoogleWorkspaceString(record?.[fieldName]);
    if (fieldValue) {
      return fieldValue;
    }
  }

  return undefined;
};

export const parseGoogleWorkspaceProfile = (
  value: unknown,
): { email?: string; name?: string } => {
  const record = getGoogleWorkspaceRecord(value);
  if (!record) {
    return {};
  }

  return {
    email:
      getGoogleWorkspacePrimaryArrayField(record.emailAddresses, "value") ??
      getGoogleWorkspaceString(record.emailAddress) ??
      getGoogleWorkspaceString(record.email),
    name:
      getGoogleWorkspacePrimaryArrayField(record.names, "displayName") ??
      getGoogleWorkspacePrimaryArrayField(record.names, "unstructuredName") ??
      getGoogleWorkspaceString(record.displayName),
  };
};

const parseGoogleProfileResult = (
  result: ToolResult,
): GoogleWorkspaceAuthResult => {
  if ("error" in result) return { connected: false };
  const response = result.result;
  if (typeof response === "string") {
    try {
      const data = JSON.parse(response);
      return {
        connected: true,
        ...parseGoogleWorkspaceProfile(data),
      };
    } catch {
      return { connected: false };
    }
  }
  if (!response || typeof response !== "object") {
    return { connected: false };
  }
  return {
    connected: true,
    ...parseGoogleWorkspaceProfile(response),
  };
};

export const createStellaHostRunner = (
  options: StellaHostRunnerOptions,
): RunnerPublicApi => {
  const context = createRunnerContext(options);
  const convexSession = createConvexSession(context);
  if (options.requestRuntimeAuthRefresh) {
    context.requestRuntimeAuthRefresh = async (payload) => {
      const result = await options.requestRuntimeAuthRefresh?.(payload);
      if (result?.token) {
        convexSession.setAuthToken(result.token);
      }
      if (result) {
        convexSession.setHasConnectedAccount(result.hasConnectedAccount);
      }
      return (
        result ?? {
          authenticated: false,
          token: null,
          hasConnectedAccount: false,
        }
      );
    };
  }
  context.state.webSearch = convexSession.webSearch;

  const storeOperations = createStoreOperations(context, {
    ensureStoreClient: convexSession.ensureStoreClient,
  });
  const buildAgentContextWithResolvedRoute = async (
    args:
      | Parameters<typeof buildAgentContext>[1]
      | Omit<Parameters<typeof buildAgentContext>[1], "resolvedLlm">,
  ) => {
    if ("resolvedLlm" in args && args.resolvedLlm) {
      return await buildAgentContext(context, args);
    }
    const configuredModel =
      args.model ??
      getConfiguredModel(
        context,
        args.agentType,
        resolveAgent(context, args.agentType),
      );
    const configuredAgentEngine = getAgentRuntimeEngine(context.stellaDataDir);
    const configuredReasoningEffort = getReasoningEffort(
      context.stellaDataDir,
      args.agentType,
    );
    const selectedEngine =
      args.modelConfigSnapshot?.engine ??
      resolveAgentEngineForRun(configuredAgentEngine, args.spawnEngine);
    const subscriptionHarnessEnabled = args.modelConfigSnapshot
      ? args.modelConfigSnapshot.subscriptionHarnessEnabled === true
      : getSubscriptionHarnessEnabled(context.stellaDataDir, selectedEngine);
    const sampledEngineConfig = args.modelConfigSnapshot
      ? undefined
      : sampleAgentEngineConfig({
          stellaDataDir: context.stellaDataDir,
          engine: selectedEngine,
          configuredModel,
          engineModelOverride: args.spawnEngine?.model,
          reasoningEffort:
            args.spawnReasoningEffort ?? configuredReasoningEffort,
        });
    const sampledSpawnEngine =
      selectedEngine === "default"
        ? args.spawnEngine
        : {
            engine: selectedEngine,
            ...(sampledEngineConfig?.engineModel
              ? { model: sampledEngineConfig.engineModel }
              : {}),
          };
    const harnessRouteModel = resolveSubscriptionHarnessRouteModel({
      stellaDataDir: context.stellaDataDir,
      agentType: args.agentType,
      configuredEngine: configuredAgentEngine,
      subscriptionHarnessEnabled,
      configuredModel,
      ...(sampledSpawnEngine ? { spawnEngine: sampledSpawnEngine } : {}),
      ...(args.modelConfigSnapshot
        ? { modelConfigSnapshot: args.modelConfigSnapshot }
        : {}),
    });
    const resolved = await resolveAgentModelRoute(
      context,
      args.agentType,
      harnessRouteModel ??
        ("modelConfigSnapshot" in args && args.modelConfigSnapshot
          ? args.modelConfigSnapshot.routeModel
          : "model" in args
            ? args.model
            : undefined),
      "modelConfigSnapshot" in args && args.modelConfigSnapshot
        ? AGENT_IDS.ORCHESTRATOR
        : args.agentType,
    );
    return await buildAgentContext(context, {
      ...args,
      ...resolved,
      configuredAgentEngine,
      configuredReasoningEffort,
      ...(sampledEngineConfig ? { sampledEngineConfig } : {}),
      subscriptionHarnessEnabled,
    });
  };
  const orchestratorController = createOrchestratorController(context, {
    buildAgentContext: buildAgentContextWithResolvedRoute,
    resolveAgent: (agentType) => resolveAgent(context, agentType),
    getConfiguredModel: (agentType, agent) =>
      getConfiguredModel(context, agentType, agent as never),
  });
  const taskOrchestration = createAgentOrchestration(context, {
    buildAgentContext: buildAgentContextWithResolvedRoute,
    resolveAgentModelConfig: async (args) => {
      const resolved = await resolveAgentModelRoute(
        context,
        args.agentType,
        args.model,
      );
      const snapshot = resolveEffectiveAgentExecutionConfig(context, {
        agentType: args.agentType,
        ...resolved,
        ...(args.spawnEngine ? { spawnEngine: args.spawnEngine } : {}),
        ...(args.spawnReasoningEffort
          ? { spawnReasoningEffort: args.spawnReasoningEffort }
          : {}),
      }).modelConfigSnapshot;
      if (!snapshot) {
        throw new Error(
          `Unable to resolve a durable model configuration for ${args.agentType}.`,
        );
      }
      return snapshot;
    },
    sendMessage: orchestratorController.sendMessage,
  });
  // Convert restart authorization and pre-cancel thread evidence before any
  // user prompt can be assembled. A previously converted, still-unclaimed
  // state is also eligible: that closes the crash window between the durable
  // state write and scheduling the synthetic recovery turn.
  const restartInterruptionState =
    convertRestartShutdownRecordAtBoot({
      stellaDataDir: context.stellaDataDir,
      env: process.env,
      interruptedThreads:
        context.state.localAgentManager?.getBootInterruptedThreads() ?? [],
      capturedEpisodeId:
        context.state.localAgentManager?.getBootInterruptionEpisodeId() ?? null,
    }) ?? readRestartInterruptionState(context.stellaDataDir);
  if (restartInterruptionState) {
    void (async () => {
      // Park on the boot latch instead of polling for the assignment; the
      // 30s bound mirrors the old deadline and uses one cleared, unref'd
      // timer (no leak on either outcome).
      await context.state.initializationStarted.awaitOpen(30_000);
      try {
        await context.state.initializationPromise;
      } catch {
        // The recovery turn reports readiness/model failures itself. Its
        // durable claim remains unfinished so the user-turn reminder wins.
      }
      await fireRestartContinuationTurn({
        stellaDataDir: context.stellaDataDir,
        env: process.env,
        sentinels: {
          pausedReasons: [AGENT_PAUSE_CANCEL_REASON],
          restartCancelReasons: [
            AGENT_ORPHANED_RESTART_CANCEL_REASON,
            AGENT_SHUTDOWN_CANCEL_REASON,
          ],
        },
        getAgentRecord: (threadId) =>
          context.runtimeStore.getAgentRecord?.(threadId) ?? null,
        listAgentRecordsByStatus: (status) =>
          context.runtimeStore.listAgentRecordsByStatus?.(status) ?? [],
        appendLocalChatEvent: (args) => {
          context.appendLocalChatEvent?.(args);
        },
        runAutomationTurn: (args) =>
          orchestratorController.runAutomationTurn(args),
        log: (message, detail) => {
          console.warn(`[runner] ${message}`, detail ?? {});
        },
      });
    })().catch((error) => {
      console.warn(
        "[runner] restart-continuation boot fire failed",
        error instanceof Error ? error.message : error,
      );
    });
  }
  const warmModelCatalog = async (): Promise<void> => {
    await resolveAgentModelRoute(context, AGENT_IDS.ORCHESTRATOR);
  };

  const noopRuntimeCallbacks: RuntimeRunCallbacks = {
    onStream: () => {},
    onToolStart: () => {},
    onToolEnd: () => {},
    onError: () => {},
    onEnd: () => {},
  };

  const runtimeInitialization = createRuntimeInitialization(context, {
    disposeConvexClient: convexSession.disposeConvexClient,
    shutdownTasks: taskOrchestration.shutdown,
  });

  return {
    deviceId: context.deviceId,
    hookEmitter: context.hookEmitter,
    setConvexUrl: convexSession.setConvexUrl,
    setConvexSiteUrl: convexSession.setConvexSiteUrl,
    setAuthToken: (value) => {
      convexSession.setAuthToken(value);
    },
    setHasConnectedAccount: convexSession.setHasConnectedAccount,
    setModelCatalogUpdatedAt: convexSession.setModelCatalogUpdatedAt,
    start: runtimeInitialization.start,
    stop: runtimeInitialization.stop,
    waitUntilInitialized: async () => {
      if (context.state.initializationPromise) {
        await context.state.initializationPromise;
      }
    },
    subscribeQuery: convexSession.subscribeQuery,
    getConvexUrl: convexSession.getConvexUrl,
    getStellaSiteAuth: convexSession.getStellaSiteAuth,
    killAllShells: () => context.toolHost.killAllShells(),
    killShellsByPort: (port) => context.toolHost.killShellsByPort(port),
    executeTool: (toolName, toolArgs, toolContext, signal, onUpdate) =>
      context.toolHost.executeTool(
        toolName,
        toolArgs,
        toolContext,
        signal,
        onUpdate,
      ),
    agentHealthCheck: orchestratorController.agentHealthCheck,
    warmModelCatalog,
    resolveImageTarget: async (agentType = AGENT_IDS.ORCHESTRATOR) => {
      try {
        const { resolvedLlm } = await resolveAgentModelRoute(
          context,
          agentType,
        );
        return {
          provider: resolvedLlm.model.provider,
          api: resolvedLlm.model.api,
          modelId: resolvedLlm.model.id,
        };
      } catch {
        return null;
      }
    },
    webSearch: convexSession.webSearch,
    listStorePackages: storeOperations.listStorePackages,
    getStorePackage: storeOperations.getStorePackage,
    listStorePackageReleases: storeOperations.listStorePackageReleases,
    getStorePackageRelease: storeOperations.getStorePackageRelease,
    handleLocalChat: orchestratorController.handleLocalChat,
    sendMessage: orchestratorController.sendMessage,
    sendUserMessage: orchestratorController.sendUserMessage,
    runAutomationTurn: orchestratorController.runAutomationTurn,
    runBlockingLocalAgent: taskOrchestration.runBlockingLocalAgent,
    createBackgroundAgent: taskOrchestration.createBackgroundAgent,
    getActiveAgentCount: () =>
      context.state.localAgentManager?.getActiveAgentCount() ?? 0,
    listActiveAgentRuns: () =>
      context.state.localAgentManager?.listActiveAgentRuns() ?? [],
    getLocalAgentSnapshot: async (agentId: string) => {
      const manager = context.state.localAgentManager;
      if (!manager) {
        return null;
      }
      return manager.getAgent(agentId);
    },
    cancelLocalAgent: taskOrchestration.cancelLocalAgent,
    cancelLocalChat: orchestratorController.cancelLocalChat,
    cancelLocalChatByConversation:
      orchestratorController.cancelLocalChatByConversation,
    getActiveOrchestratorRun: orchestratorController.getActiveOrchestratorRun,
    appendThreadMessage: (args) => {
      const timestamp = Date.now();
      // The durable thread store is the single model-context source, so
      // user transcripts persisted directly (realtime voice) get the same
      // metadata the retired local-events projection used to add at read
      // time — see `agent-runtime/transcript-decoration.js`.
      const content =
        args.role === "user" && args.decorateUserTimestampTag
          ? decorateUserTranscriptContent({
              store: context.runtimeStore,
              threadKey: args.threadKey,
              text: args.content,
              timestamp,
              ...(args.timezone ? { timezone: args.timezone } : {}),
            })
          : args.content;
      context.runtimeStore.appendThreadMessage({
        threadKey: args.threadKey,
        role: args.role,
        content,
        timestamp,
      });
    },
    notifyOrchestratorHistoryChanged: (conversationId: string) => {
      context.state.orchestratorSessions
        .get(conversationId)
        ?.notifyHistoryChanged();
    },
    getVoiceOrchestratorConfig: async ({ conversationId }) => {
      const agentType = AGENT_IDS.ORCHESTRATOR;
      const runId = `voice-session:${Date.now()}`;
      const resolved = await resolveAgentModelRoute(context, agentType);
      const agentContext = await buildAgentContext(context, {
        conversationId,
        agentType,
        runId,
        ...resolved,
      });
      const instructions = await buildRuntimeSystemPrompt({
        runId,
        conversationId,
        userMessageId: runId,
        agentType,
        userPrompt: "",
        uiVisibility: "hidden",
        agentContext,
        callbacks: noopRuntimeCallbacks,
        toolExecutor: async () => ({ error: "Voice config has no executor." }),
        // Voice has no node_repl surface: configuration/background demoted
        // tools would be unreachable dead weight in the realtime function
        // list. Map remains eager here as the safe no-REPL fallback.
        toolCatalog: context.toolHost
          .getToolCatalog(agentType, {
            model:
              resolved.resolvedLlm.toolPolicyModel ??
              resolved.resolvedLlm.model,
            agentEngine: agentContext.agentEngine,
          })
          .filter((tool) => !tool.demoted || tool.name === "map"),
        deviceId: context.deviceId,
        stellaDataDir: context.stellaDataDir,
        resolvedLlm: resolved.resolvedLlm,
        store: context.runtimeStore,
        compactionScheduler: context.state.compactionScheduler,
        stellaAppDir: context.stellaAppDir,
        hookEmitter: context.hookEmitter,
      });
      const toolCatalog = context.toolHost
        .getToolCatalog(agentType, {
          model:
            resolved.resolvedLlm.toolPolicyModel ?? resolved.resolvedLlm.model,
          agentEngine: agentContext.agentEngine,
        })
        .filter((tool) => !tool.demoted || tool.name === "map");
      const history = buildVoiceHistoryItems(agentContext.threadHistory);
      return {
        instructions,
        tools: getRuntimeToolMetadata({
          toolsAllowlist: agentContext.toolsAllowlist,
          toolCatalog,
        }).map((tool) => ({
          type: "function" as const,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
        ...(history.length > 0 ? { history } : {}),
      };
    },
    convexAction: async (ref: unknown, args: unknown): Promise<unknown> => {
      const client = convexSession.ensureConvexClient();
      if (!client) {
        throw new Error(
          "Convex client not available — check connection and auth.",
        );
      }
      return (
        client as { action: (ref: unknown, args: unknown) => Promise<unknown> }
      ).action(ref, args);
    },

    googleWorkspaceGetAuthStatus: async () => {
      return {
        connected: Boolean(
          await loadConnectorAccessToken(
            context.stellaDataDir,
            "google-workspace",
          ),
        ),
      };
    },

    googleWorkspaceConnect: async () => {
      const { callTool, disconnect } = await loadGoogleWorkspaceTools({
        stellaAppDir: context.stellaDataDir,
      });
      try {
        if (!callTool) return { connected: false, unavailable: true };
        return parseGoogleProfileResult(await callTool("people.getMe", {}));
      } finally {
        await disconnect().catch(() => undefined);
      }
    },

    googleWorkspaceDisconnect: async () => {
      await deleteConnectorAccessTokens(context.stellaDataDir, [
        "google-workspace",
      ]);
      return { ok: true };
    },
  };
};
