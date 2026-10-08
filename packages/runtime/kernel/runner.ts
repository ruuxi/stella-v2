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
import { forkDelayedCall } from "./runner/cloud-effect-runtime.js";
import type { WebSearchResult } from "@stella/contracts/backend/search";
import { scheduleRemotePromptRevalidation } from "./prompts/remote-prompts.js";
import { createOrchestratorController } from "./runner/orchestrator.js";
import { createRunnerPiTools } from "./runner/pi-tools.js";
import { createRuntimeInitialization } from "./runner/runtime-initialization.js";
import { createAgentOrchestration } from "./runner/agent-orchestration.js";
import { createCloudAgentLifecycleMonitor } from "./runner/cloud-agent-lifecycle.js";
import { createComputerAgentCloudRecords } from "./runner/computer-agent-cloud-records.js";
import { parseCanonicalCloudHistory } from "./runner/orchestrator-launch.js";
import {
  buildRuntimeSystemPrompt,
  renderSystemPrompt,
} from "./agent-runtime/run-preparation.js";
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
  OrchestratorRunLaunch,
  RunnerPublicApi,
  StellaHostRunnerOptions,
} from "./runner/types.js";

/** How long the boot resume pass waits for the runtime to be able to run. */
const DURABLE_RESUME_READY_TIMEOUT_MS = 60_000;

/** A stored launch record, or null when it is not an orchestrator chat run. */
const parseOrchestratorRunLaunch = (
  value: unknown,
): OrchestratorRunLaunch | null => {
  const launch = value as Partial<OrchestratorRunLaunch> | null | undefined;
  if (
    !launch ||
    launch.kind !== "orchestrator-chat" ||
    typeof launch.conversationId !== "string" ||
    typeof launch.agentType !== "string" ||
    typeof launch.userMessageId !== "string"
  ) {
    return null;
  }
  return launch as OrchestratorRunLaunch;
};

export type { StellaHostRunnerOptions } from "./runner/types.js";

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
  // Nested (`code`, `multi_tool_use_parallel`) and voice calls dispatch
  // through the host, so they need the same extension hooks the runtime
  // adapter applies to model-issued top-level calls.
  context.toolHost.setToolCallHooks(context.hookEmitter);
  let restartCloudAgentLifecycle = () => {};
  let resumeComputerAgentCloudRecords = () => {};
  const setAuthToken = (value: string | null) => {
    if (process.env.STELLA_LLM_PROXY_TOKEN) return;
    const prev = context.state.authToken?.trim() || null;
    const next = value?.trim() || null;
    if (next === prev) return;
    context.state.authToken = value;
    context.backend.noteAuthToken();
    if (next) {
      restartCloudAgentLifecycle();
      resumeComputerAgentCloudRecords();
      context.cloudTranscript.resume();
    }
  };
  const setHasConnectedAccount = (value: boolean) => {
    context.state.hasConnectedAccount = Boolean(value);
    restartCloudAgentLifecycle();
  };
  const webSearch = async (
    query: string,
    searchOptions?: { category?: string },
  ): Promise<WebSearchResult> => {
    try {
      const result = await context.backend.require().call("search.web", {
        query,
        ...(searchOptions?.category ? { category: searchOptions.category } : {}),
      });
      return {
        text: result.text || "WebSearch returned no response.",
        results: result.results,
      };
    } catch (error) {
      return {
        text: `WebSearch failed: ${(error as Error).message}`,
        results: [],
      };
    }
  };
  if (options.requestRuntimeAuthRefresh) {
    context.requestRuntimeAuthRefresh = async (payload) => {
      const result = await options.requestRuntimeAuthRefresh?.(payload);
      if (result?.token) {
        setAuthToken(result.token);
      }
      if (result) {
        setHasConnectedAccount(result.hasConnectedAccount);
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
  context.state.webSearch = webSearch;

  // Local history stays on this device. Authentication and startup must not
  // upload existing transcripts or wait for a history transfer.

  const computerAgentCloudRecords = createComputerAgentCloudRecords({
    deviceId: context.deviceId,
    store: context.runtimeStore,
    getAuthToken: () => context.state.authToken?.trim() || null,
    backend: {
      start: async (args) =>
        await context.backend.require().call("computerThreads.start", args as never),
      complete: async (args) =>
        await context.backend.require().call("computerThreads.complete", args as never),
      cancel: async (args) =>
        await context.backend.require().call("computerThreads.cancel", args as never),
      get: async (args) =>
        await context.backend.require().call("computerThreads.get", args as never),
    },
  });
  resumeComputerAgentCloudRecords = computerAgentCloudRecords.resume;
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
    const subscriptionHarnessEnabled =
      selectedEngine === "codex_cli" ||
      (args.modelConfigSnapshot
        ? args.modelConfigSnapshot.subscriptionHarnessEnabled === true
        : getSubscriptionHarnessEnabled(context.stellaDataDir, selectedEngine));
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
  context.state.sendRuntimeMessage = orchestratorController.sendMessage;
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
    cloudAgentRecords: computerAgentCloudRecords,
  });
  const cloudAgentLifecycle = createCloudAgentLifecycleMonitor({
    deviceId: context.deviceId,
    getOwnerGeneration: async () =>
      (await context.backend.ownerIdentity()).ownerGeneration,
    watchDeviceThreads: (args, onUpdate, onError) => {
      const client = context.backend.client();
      if (!client) return null;
      return client.watch("agentThreads.forDevice", args, onUpdate, onError);
    },
    acknowledge: async (args) =>
      await context.backend
        .require()
        .call("agentThreads.acknowledgeDelivery", args),
    canStart: () =>
      context.state.hasConnectedAccount === true &&
      Boolean(context.state.authToken?.trim()) &&
      Boolean(context.backend.client()),
    hasDurableLifecycleEvent:
      taskOrchestration.hasDurableExternalLifecycleEvent,
    onLifecycleEvent: taskOrchestration.handleExternalAgentLifecycleEvent,
    onControlReceipt: (row) => {
      context.runtimeStore.putCloudAgentThreadControl({
        threadId: row.threadId,
        ownerGeneration: row.ownerGeneration,
        cloudConversationId: row.cloudConversationId,
        originConversationId: row.originConversationId,
        attemptGeneration: row.attemptGeneration,
        threadUpdatedAt: row.updatedAt,
        status:
          row.status === "running" ||
          row.status === "completed" ||
          row.status === "failed" ||
          row.status === "canceled"
            ? row.status
            : (() => {
                throw new Error("Invalid cloud agent control status.");
              })(),
      });
    },
  });
  restartCloudAgentLifecycle = () => {
    if (
      context.state.hasConnectedAccount !== true ||
      !context.state.authToken?.trim()
    ) {
      cloudAgentLifecycle.stop();
      return;
    }
    queueMicrotask(() => cloudAgentLifecycle.start());
  };
  restartCloudAgentLifecycle();
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
    onToolStart: () => {},
    onToolEnd: () => {},
    onError: () => {},
    onEnd: () => {},
  };

  const runtimeInitialization = createRuntimeInitialization(context, {
    disposeBackendClient: () => context.backend.dispose(),
    shutdownTasks: async () => {
      // Stop network delivery first: shutdown still admits every resulting
      // cancel/terminal row synchronously, but it must not wait on a backend
      // client that runtime teardown has already disposed. The next worker
      // resumes those durable rows before constructing its agent manager.
      computerAgentCloudRecords.stop();
      await taskOrchestration.shutdown();
    },
  });

  return {
    deviceId: context.deviceId,
    hookEmitter: context.hookEmitter,
    setBackendUrl: (value) => {
      context.backend.setBackendUrl(value);
      scheduleRemotePromptRevalidation();
      queueMicrotask(() => cloudAgentLifecycle.start());
      computerAgentCloudRecords.resume();
    },
    setAuthToken,
    setHasConnectedAccount,
    setCloudSyncEnabled: (enabled) => {
      context.state.cloudSyncEnabled = Boolean(enabled);
    },
    start: runtimeInitialization.start,
    stop: async () => {
      cloudAgentLifecycle.stop();
      await runtimeInitialization.stop();
    },
    waitUntilInitialized: async () => {
      if (context.state.initializationPromise) {
        await context.state.initializationPromise;
      }
    },
    getStellaSiteAuth: () => {
      const baseUrl = context.state.backendUrl?.trim();
      const authToken = context.state.authToken?.trim();
      return baseUrl && authToken ? { baseUrl, authToken } : null;
    },
    killAllShells: () => context.toolHost.killAllShells(),
    killShellsByPort: (port) => context.toolHost.killShellsByPort(port),
    // Voice tool calls are model-issued; validate and run hooks like any
    // top-level call.
    executeTool: (toolName, toolArgs, toolContext, signal, onUpdate) =>
      context.toolHost.executeToolCall(
        toolName,
        toolArgs,
        toolContext,
        signal,
        onUpdate,
      ),
    piTools: createRunnerPiTools(context),
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
    webSearch,
    handleLocalChat: orchestratorController.handleLocalChat,
    resumeInterruptedOrchestratorRuns: async ({ createCallbacks }) => {
      const resumed: string[] = [];
      const failed: string[] = [];
      const runTasks = context.runtimeStore.runTasks;
      if (!runTasks) return { resumed, failed };
      const pending = runTasks
        .recoveryPlan()
        .resumable.filter((record) => runTasks.isResumable(record.runId));
      if (pending.length > 0) {
        // The account session and model route arrive after initialization
        // (auth refresh, catalog); a resume launched before them fails on
        // "no usable model route". Wait for the same readiness a user send
        // needs, bounded so an unready runtime still settles the runs.
        const deadline = Date.now() + DURABLE_RESUME_READY_TIMEOUT_MS;
        while (
          !orchestratorController.agentHealthCheck().ready &&
          Date.now() < deadline
        ) {
          await new Promise<void>((resolve) => {
            forkDelayedCall(250, resolve);
          });
        }
      }
      for (const record of pending) {
        const launch = parseOrchestratorRunLaunch(record.checkpoint.launch);
        // Agent rows belong to the LocalAgentManager's own resume pass.
        if (!launch) {
          if (record.agentType === AGENT_IDS.ORCHESTRATOR) {
            runTasks.abandon(record.runId);
          }
          continue;
        }
        if (!runTasks.isResumable(record.runId)) continue;
        const resumeCount = runTasks.markResumed(record.runId);
        const intents = runTasks.listIntents(record.runId);
        try {
          await orchestratorController.resumeOrchestratorRun({
            launch,
            runId: record.runId,
            state: { record: { ...record, resumeCount }, intents },
            callbacks: createCallbacks({ ...launch, runId: record.runId }),
          });
          console.warn("[runner] durable orchestrator run resumed", {
            runId: record.runId,
            conversationId: launch.conversationId,
            resumeCount,
            intents: intents.length,
          });
          resumed.push(record.runId);
        } catch (error) {
          // The launch already reported the failure through the callbacks.
          runTasks.abandon(record.runId);
          // A cloud turn's begin is no longer owned: let the writer recover it.
          context.cloudTranscript.resume();
          console.warn("[runner] durable orchestrator run resume failed", {
            runId: record.runId,
            error: error instanceof Error ? error.message : String(error),
          });
          failed.push(record.runId);
        }
      }
      return { resumed, failed };
    },
    getRestartBlockers: () => {
      const runTasks = context.runtimeStore.runTasks;
      const durable = (runId: string | null | undefined): boolean =>
        Boolean(runId) && (runTasks?.isLiveRunResumable(runId!) ?? false);
      let nonDurableRuns = 0;
      const activeRunId = context.state.activeOrchestratorRunId;
      if (activeRunId && !durable(activeRunId)) nonDurableRuns += 1;
      for (const attempt of context.state.localAgentManager?.listActiveAttemptRuns() ??
        []) {
        if (!durable(attempt.runId)) nonDurableRuns += 1;
      }
      return {
        unsafeToolCalls: runTasks?.liveUnsafeIntentCount() ?? 0,
        nonDurableRuns,
      };
    },
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
    cancelBlockingLocalAgent: taskOrchestration.cancelBlockingLocalAgent,
    steerBlockingLocalAgent: taskOrchestration.steerBlockingLocalAgent,
    deliverLocalAgentMessage: taskOrchestration.deliverLocalAgentMessage,
    cancelPlacementAutomation: orchestratorController.cancelPlacementAutomation,
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
    appendCloudJournal: (request) => context.cloudTranscript.append(request),
    cloudJournal: {
      begin: (request) => context.cloudTranscript.begin(request),
      finish: (request) => context.cloudTranscript.finish(request),
      append: (request) => context.cloudTranscript.append(request),
      history: (conversationId) => context.cloudTranscript.history(conversationId),
      ownerGeneration: () => context.cloudOwnerGeneration(),
    },
    beginVoiceToolCallReceipt: (request) =>
      context.runtimeStore.beginVoiceToolCallReceipt(request),
    completeVoiceToolCallReceipt: (request) =>
      context.runtimeStore.completeVoiceToolCallReceipt(request),
    notifyOrchestratorHistoryChanged: (conversationId: string) => {
      context.state.orchestratorSessions
        .get(conversationId)
        ?.notifyHistoryChanged();
    },
    getVoiceOrchestratorConfig: async ({ conversationId }) => {
      const agentType = AGENT_IDS.ORCHESTRATOR;
      const runId = `voice-session:${Date.now()}`;
      const resolved = await resolveAgentModelRoute(context, agentType);
      const cloudHistory = conversationId.startsWith("local_")
        ? null
        : await context.cloudTranscript.history(conversationId);
      const agentContext = {
        ...(await buildAgentContext(context, {
          conversationId,
          agentType,
          runId,
          ...resolved,
        })),
        ...(cloudHistory
          ? { threadHistory: parseCanonicalCloudHistory(cloudHistory.history) }
          : {}),
      };
      const instructionSections = await buildRuntimeSystemPrompt({
        executionHost: "device",
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
      const instructions = renderSystemPrompt(instructionSections);
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
