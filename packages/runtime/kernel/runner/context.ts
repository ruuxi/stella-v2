import { loadDeviceExecutionContext, loadMediaAccess } from "./execution-context.js";
import { resolveRuntimeSourceAsset } from "../shared/runtime-paths.js";
import { stripMessageRefTag } from "@stella/contracts/reply-refs";
import {
  createCloudSpawnDispatcher,
  createCloudThreadController,
} from "./cloud-spawn-dispatch.js";
import { createCloudTranscriptWriter } from "./cloud-transcript-write.js";
import { createToolHost } from "../tools/host.js";
import type {
  AgentThreadStatusRead,
  SpawnModelSupport,
} from "../tools/types.js";
import { HookEmitter } from "../extensions/hook-emitter.js";
import {
  getAgentRuntimeEngine,
  loadLocalPreferences,
  getMaxAgentConcurrency,
  getModelOverride,
  getReasoningEffort,
  getSubscriptionHarnessEnabled,
} from "../preferences/local-preferences.js";
import { readOrSeedPersonality } from "../personality/personality.js";
// Deprecated pre-transition compat shim; see `buildOrchestratorThreadHistory`.
import { buildLocalHistoryFromEvents } from "../local-history.js";
import type { LocalContextEvent } from "../storage/shared.js";
import {
  createListedLocalChatEventWindow,
  filterLocalChatEventWindow,
  type LocalChatEventWindowQuery,
} from "../storage/event-window.js";
import {
  formatDateTimeReminder,
  THIRTY_MINUTES_MS,
  TRAILING_TIME_TAG_RE,
} from "@stella/contracts/message-timestamp";
import {
  buildRuntimeThreadKey,
  parseThreadCheckpoint,
} from "../thread-runtime.js";
import {
  buildActiveThreadsPrompt,
  deriveRuntimeThreadLiveState,
  estimateRuntimeTokens,
  formatRuntimeThreadStatusLabel,
} from "../runtime-threads.js";
import type { LocalAgentContext } from "../agents/local-agent-manager.js";
import { loadAgentSystemPrompt } from "../agents/home-agent-prompt.js";
import { renderSkillCatalogBlock } from "../shared/skill-catalog.js";
import type {
  RunnerContext,
  ParsedAgentLike,
  StellaHostRunnerOptions,
} from "./types.js";
import {
  AGENT_IDS,
  agentHasCapability,
  isLocalCliAgentId,
} from "@stella/contracts/agent-runtime";
import type {
  AgentModelConfigSnapshot,
  AgentModelReasoningEffort,
  AgentRuntimeEngine,
  CloudExecutionSelection,
  CodexServiceTier,
  SpawnEngineSelection,
  SpawnReasoningEffort,
} from "@stella/contracts/agent-engine";
import { getCodexSubscriptionPreferences } from "../integrations/codex-subscription.js";
import {
  getClaudeCodeAgentModelId,
  getClaudeCodeRuntimeEffortLevel,
} from "../integrations/claude-code-agent-runtime.js";
import { getSupportedThinkingLevels } from "../../ai/thinking-levels.js";
import type { Model, Api, ModelThinkingLevel } from "../../ai/types.js";
import type {
  PersistedRuntimeThreadPayload,
  RuntimeThreadMessage,
} from "../storage/shared.js";
import { getBundledCoreAgentFallback } from "../agents/agents.js";
import { BackgroundCompactionScheduler } from "../agent-runtime/compaction-scheduler.js";
import {
  createBackgroundExitWake,
  writeBackgroundExitLog,
} from "./background-exit-wake.js";
import { createKernelRunSupervisor } from "./supervision/run-supervisor.js";
import { createReadinessLatch } from "../shared/readiness-latch.js";
import {
  defaultPromptForAgentType,
  DEFAULT_MAX_AGENT_DEPTH,
  LOCAL_CONTEXT_EVENT_TYPES,
  LOCAL_HISTORY_RESERVE_TOKENS,
  MIN_LOCAL_HISTORY_TOKENS,
  readCoreMemory,
  readMemoryIndexDoc,
  readUserProfileDoc,
} from "./shared.js";
import {
  resolveRunnerLlmRoute,
  resolveRunnerLlmRouteWithMetadata,
} from "./model-selection.js";
import {
  captureEffectiveModelConfig,
  normalizeCapturedReasoningEffort,
  resolveAgentEngineForRun,
  restoreSpawnEngineFromModelConfig,
  toCloudExecutionSelection,
} from "./agent-model-config.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import { getResponseLanguageSystemPrompt } from "./locale-prompt.js";
import { createBackendSession, initialBackendUrl } from "./backend-session.js";
import { hostname } from "node:os";
import { resolveJwtOwnerScope } from "./computer-agent-cloud-records.js";
import {
  assistantPayloadText,
  createLinkedFilePublisher,
} from "../device-files/linked-file-publisher.js";
import { raceWithTimeoutError } from "./cloud-effect-runtime.js";
import {
  APPLY_PATCH_TOOL_NAME,
  EDIT_TOOL_NAME,
  WRITE_TOOL_NAME,
  getFileEditToolFamily,
  rewriteFileEditToolNames,
} from "../tools/file-edit-policy.js";

const CODEX_SKILL_CATALOG_OMITTED_IDS = [
  "stella-computer-windows",
  "stella-computer-macos",
  "stella-browser",
  "electron",
  "stella-office",
  "pdf",
] as const;

type ThreadHistoryEntry = {
  timestamp?: number;
  role: string;
  content: string;
  toolCallId?: string;
  payload?: PersistedRuntimeThreadPayload;
  customMessage?: RuntimeThreadMessage["customMessage"];
};

/** Newest chat events the orchestrator context build considers. */
const ORCHESTRATOR_LOCAL_EVENT_WINDOW = 800;
const CONVERSATION_THREAD_LOOKUP_TIMEOUT_MS = 5_000;
const LOCAL_CONTEXT_EVENT_TYPE_LIST = [...LOCAL_CONTEXT_EVENT_TYPES];
/** Newest context events read for the reminders and locale before widening. */
const RECENT_CONTEXT_EVENT_READ = 16;

const getLocalHistoryBudget = (contextWindow: number): number =>
  Math.max(
    MIN_LOCAL_HISTORY_TOKENS,
    contextWindow - LOCAL_HISTORY_RESERVE_TOKENS,
  );

const hasStoredCheckpoint = (messages: ThreadHistoryEntry[]): boolean =>
  messages.some(
    (message) =>
      message.role === "assistant" &&
      Boolean(parseThreadCheckpoint(message.content)),
  );

const getStoredMessagePreview = (
  message: ThreadHistoryEntry | undefined,
): string => message?.content.trim() ?? "";

/**
 * Durable-store user messages may carry a write-time timestamp tag that raw
 * chat events do not. Strip it before comparing a stored preview against
 * event text so the legacy transition dedup keeps matching.
 */
const stripUserTranscriptDecoration = (value: string): string =>
  stripMessageRefTag(value).replace(TRAILING_TIME_TAG_RE, "").trim();

const getLocalEventText = (event: LocalContextEvent): string => {
  if (!event.payload || typeof event.payload !== "object") {
    return "";
  }
  const payload = event.payload as Record<string, unknown>;
  const rawText =
    typeof payload.text === "string" && payload.text.trim()
      ? payload.text
      : typeof payload.contextText === "string"
        ? payload.contextText
        : "";
  return rawText.trim();
};

const getLocalEventTimezone = (
  event: LocalContextEvent | undefined,
): string | undefined => {
  if (!event?.payload || typeof event.payload !== "object") {
    return undefined;
  }
  const payload = event.payload as Record<string, unknown>;
  return typeof payload.timezone === "string" && payload.timezone.trim()
    ? payload.timezone.trim()
    : undefined;
};

/**
 * Picks the user's preferred locale off the most recent `user_message`
 * event payload. Locale is plumbed in alongside `timezone` from the
 * desktop chat send path; the runtime never reads it from local
 * preferences directly.
 */
const getLocalEventLocale = (
  event: LocalContextEvent | undefined,
): string | undefined => {
  if (!event?.payload || typeof event.payload !== "object") {
    return undefined;
  }
  const payload = event.payload as Record<string, unknown>;
  return typeof payload.locale === "string" && payload.locale.trim()
    ? payload.locale.trim()
    : undefined;
};

const findLatestLocale = (events: LocalContextEvent[]): string | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "user_message") continue;
    const locale = getLocalEventLocale(event);
    if (locale) return locale;
  }
  return undefined;
};

/**
 * Detects a "routing surface changed" transition between the latest and
 * the previous user message in a conversation and returns the hidden
 * system-reminder text the orchestrator should see (or `undefined` when
 * nothing changed).
 *
 * "Routing surface" here means whether the user is talking through a
 * connector (the Stella mobile app) or directly from the desktop, and
 * which connector if so. Each `user_message` event carries
 * `payload.source` (either `"connector"` or absent) and, when sourced
 * from a connector, `payload.provider` identifying the channel.
 *
 * The reminder is only injected on the transition turn — once the model
 * has acknowledged the new surface, subsequent same-surface user
 * messages skip the reminder so we don't burn cache or nag the model.
 *
 * - desktop → connector: tell the orchestrator the user is on
 *   `<provider>`, ask it to reply in plain text and skip the
 *   `html` tool (it's a desktop-renderer UI).
 * - connector → desktop: tell the orchestrator the user is back at
 *   their desktop so it stops constraining its format.
 * - connector → different connector: same as desktop → connector with
 *   the new provider name.
 * - same surface: returns `undefined`.
 */
const buildConnectorTransitionReminder = (
  events: LocalContextEvent[],
): string | undefined => {
  const userEvents = events.filter((event) => event.type === "user_message");
  if (userEvents.length === 0) return undefined;

  const latest = userEvents[userEvents.length - 1];
  const previous = userEvents[userEvents.length - 2];

  const sourceOf = (
    event: LocalContextEvent | undefined,
  ): { isConnector: boolean; provider: string | null } => {
    if (!event?.payload || typeof event.payload !== "object") {
      return { isConnector: false, provider: null };
    }
    const payload = event.payload as Record<string, unknown>;
    if (payload.source !== "connector") {
      return { isConnector: false, provider: null };
    }
    const provider =
      typeof payload.provider === "string" && payload.provider.trim()
        ? payload.provider.trim()
        : null;
    return { isConnector: true, provider };
  };

  const currentSurface = sourceOf(latest);
  const previousSurface = sourceOf(previous);

  // No transition: same surface (and same provider when on a connector).
  if (
    currentSurface.isConnector === previousSurface.isConnector &&
    currentSurface.provider === previousSurface.provider
  ) {
    return undefined;
  }

  if (currentSurface.isConnector) {
    const providerLabel =
      currentSurface.provider === "stella_app"
        ? "the Stella mobile app"
        : (currentSurface.provider ?? "an external chat channel");
    const connectorLines = [
      `The user is now messaging you from ${providerLabel}, not the desktop app.`,
      "Reply like a normal text message: plain text only, no markdown, short and conversational.",
      "Do not call the `html` tool — it only renders in the desktop sidebar.",
      "`image_gen` returns the finished artifact in its tool result and it renders directly in chat; do not poll for it or describe the image afterward.",
    ];
    return connectorLines.join(" ");
  }

  // connector → desktop
  return "The user is back at their desktop. Markdown, the `html` tool, and other desktop-only surfaces are fine again.";
};

const buildStaleUserReminder = (
  events: LocalContextEvent[],
): string | undefined => {
  const latestEvent = events[events.length - 1];
  if (!latestEvent || latestEvent.type !== "user_message") {
    return undefined;
  }
  const userEvents = events.filter((event) => event.type === "user_message");
  if (userEvents.length < 2) {
    return undefined;
  }
  const latestUserEvent = userEvents[userEvents.length - 1];
  const previousUserEvent = userEvents[userEvents.length - 2];
  if (!latestUserEvent || !previousUserEvent) {
    return undefined;
  }
  if (
    latestUserEvent.timestamp - previousUserEvent.timestamp <
    THIRTY_MINUTES_MS
  ) {
    return undefined;
  }
  const timezone =
    getLocalEventTimezone(latestUserEvent) ??
    getLocalEventTimezone(previousUserEvent);
  return formatDateTimeReminder(latestUserEvent.timestamp, timezone);
};

const trimDuplicatedTransitionUserEvent = (
  events: LocalContextEvent[],
  storedThreadMessages: ThreadHistoryEntry[],
): LocalContextEvent[] => {
  const leadingStoredUserPreviews: string[] = [];
  for (const message of storedThreadMessages) {
    if (message.role !== "user") {
      break;
    }
    const preview = stripUserTranscriptDecoration(
      getStoredMessagePreview(message),
    );
    if (!preview) {
      break;
    }
    leadingStoredUserPreviews.push(preview);
  }
  if (leadingStoredUserPreviews.length === 0 || events.length === 0) {
    return events;
  }
  const nextEvents = [...events];
  let storedIndex = leadingStoredUserPreviews.length - 1;
  let eventIndex = nextEvents.length - 1;
  let matchedCount = 0;

  while (storedIndex >= 0 && eventIndex >= 0) {
    const event = nextEvents[eventIndex];
    if (!event || event.type !== "user_message") {
      break;
    }
    if (getLocalEventText(event) !== leadingStoredUserPreviews[storedIndex]) {
      break;
    }
    matchedCount += 1;
    storedIndex -= 1;
    eventIndex -= 1;
  }

  if (matchedCount === 0) {
    return events;
  }
  nextEvents.splice(nextEvents.length - matchedCount, matchedCount);
  return nextEvents;
};

/**
 * Orchestrator model-context history.
 *
 * The durable runtime thread store is the single source of conversation
 * history: typed turns, realtime-voice transcripts, and connector messages
 * all persist thread entries at write time (with the timestamp-tag
 * decoration applied by `agent-runtime/transcript-decoration.js`).
 * Ordinarily this function just
 * returns `storedThreadMessages`.
 *
 * LEGACY PRE-TRANSITION COMPAT: conversations whose chat events predate the
 * unification still need those events once. Two shim branches remain, both
 * feeding the deprecated `buildLocalHistoryFromEvents` projection:
 *
 *   1. no durable entries at all — a conversation that only ever wrote
 *      chat events (the current turn's own just-appended user event is
 *      excluded upstream via `currentUserMessageId`); and
 *   2. events strictly older than the thread's first durable entry, merged
 *      ahead of the stored history ("pre-transition head").
 *
 * A stored compaction checkpoint disables both branches, so the shim
 * retires organically per conversation as checkpoints land. Do not extend
 * these branches — new history must go through the durable store.
 */
/**
 * Which chat events `buildOrchestratorThreadHistory` can consume for these
 * stored messages: every event (no durable entries), none (a checkpoint, or
 * no usable transition timestamp), or only events strictly older than the
 * transition cutoff. Callers bound their event read by it.
 */
export type LegacyHistoryEventBound =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "before"; timestamp: number };

export const resolveLegacyHistoryEventBound = (
  storedThreadMessages: ThreadHistoryEntry[],
): LegacyHistoryEventBound => {
  if (storedThreadMessages.length === 0) {
    return { kind: "all" };
  }
  if (hasStoredCheckpoint(storedThreadMessages)) {
    return { kind: "none" };
  }
  const transitionCutoff =
    storedThreadMessages.find((message) => message.role !== "user")
      ?.timestamp ?? storedThreadMessages[0]?.timestamp;
  if (!transitionCutoff || !Number.isFinite(transitionCutoff)) {
    return { kind: "none" };
  }
  return { kind: "before", timestamp: transitionCutoff };
};

export const buildOrchestratorThreadHistory = (args: {
  storedThreadMessages: ThreadHistoryEntry[];
  localEvents?: LocalContextEvent[];
  contextWindow: number;
}): ThreadHistoryEntry[] => {
  const localEvents = args.localEvents ?? [];
  const localHistoryBudget = getLocalHistoryBudget(args.contextWindow);
  const bound = resolveLegacyHistoryEventBound(args.storedThreadMessages);

  if (bound.kind === "all") {
    return buildLocalHistoryFromEvents({
      events: localEvents,
      maxTokens: localHistoryBudget,
    });
  }

  if (localEvents.length === 0 || bound.kind === "none") {
    return args.storedThreadMessages;
  }

  const transitionCutoff = bound.timestamp;

  const preTransitionEvents = trimDuplicatedTransitionUserEvent(
    localEvents.filter((event) => event.timestamp < transitionCutoff),
    args.storedThreadMessages,
  );
  if (preTransitionEvents.length === 0) {
    return args.storedThreadMessages;
  }

  const storedTokenEstimate = args.storedThreadMessages.reduce(
    (total, message) => total + estimateRuntimeTokens(message.content),
    0,
  );
  const preTransitionBudget = Math.max(
    MIN_LOCAL_HISTORY_TOKENS,
    localHistoryBudget - storedTokenEstimate,
  );

  const preTransitionHistory = buildLocalHistoryFromEvents({
    events: preTransitionEvents,
    maxTokens: preTransitionBudget,
  });

  if (preTransitionHistory.length === 0) {
    return args.storedThreadMessages;
  }

  return [...preTransitionHistory, ...args.storedThreadMessages];
};

export const createRunnerContext = ({
  deviceId,
  stellaAppDir,
  stellaDataDir,
  stellaBrowserBinPath,
  stellaOfficeBinPath,
  stellaComputerCliPath,
  stellaMediaCliPath,
  stellaXApiCliPath,
  cliBridgeSocketPath,
  askUser,
  requestSecureInput,
  useSecureValue,
  requestBrowserExtensionConnect,
  requestConnectorConnection,
  switchExecutionDestination,
  requestRuntimeAuthRefresh,
  requestChallengeToken,
  getDeviceSigner,
  scheduleApi,
  runtimeStore,
  listLocalChatEvents,
  openLocalChatEventWindow,
  appendLocalChatEvent,
  notifyThreadActivityUpdated,
  getDefaultConversationId,
}: StellaHostRunnerOptions): RunnerContext => {
  const envAuthToken = process.env.STELLA_LLM_PROXY_TOKEN ?? null;

  const context = {} as RunnerContext;
  const hookEmitter = new HookEmitter();
  const backend = createBackendSession(
    () => context.state,
    async () => {
      const refreshed = await context.requestRuntimeAuthRefresh?.({
        source: "subscription",
      });
      return refreshed?.authenticated ? refreshed.token : null;
    },
  );

  const getCloudOwnerGeneration = async (): Promise<string> => {
    const identity = await backend.ownerIdentity();
    if (!identity.ownerGeneration.trim()) {
      throw new Error("Cloud owner generation is unavailable.");
    }
    return identity.ownerGeneration.trim();
  };

  const cloudAgentBackend = {
    spawn: async (args: Record<string, unknown>) =>
      await backend
        .require()
        .call("agentThreads.spawnFromDesktop", args as never),
    continue: async (args: Record<string, unknown>) =>
      await backend
        .require()
        .call("agentThreads.continueFromDesktop", args as never),
    cancel: async (args: Record<string, unknown>) =>
      await backend.require().call("agentThreads.cancel", args as never),
  };
  const isCloudSignedIn = () =>
    Boolean(
      context.state?.backendUrl &&
        (context.state?.authToken ?? envAuthToken ?? "").trim(),
    );
  const cloudDispatch = createCloudSpawnDispatcher({
    backend: cloudAgentBackend,
    deviceId,
    getOwnerGeneration: getCloudOwnerGeneration,
    store: runtimeStore,
    isSignedIn: isCloudSignedIn,
  });
  const cloudThreadController = createCloudThreadController({
    backend: cloudAgentBackend,
    deviceId,
    getOwnerGeneration: getCloudOwnerGeneration,
    store: runtimeStore,
    isSignedIn: isCloudSignedIn,
  });

  /** The conversation Durable Objects live on the backend worker. */
  const cloudRealtimeBaseUrl = async (): Promise<string | null> =>
    context.state?.backendUrl ?? null;

  const linkedFilePublisher = createLinkedFilePublisher({
    deviceId,
    deviceName: hostname().trim().slice(0, 96) || deviceId,
    getBackendUrl: () => context.state?.backendUrl ?? null,
    getAuthToken: () =>
      (context.state?.authToken ?? envAuthToken ?? "").trim() || null,
    ownerScopeOf: resolveJwtOwnerScope,
    onLog: (event, fields) => {
      console.warn(`[device-files] ${event}`, fields);
    },
  });

  const cloudTranscript = createCloudTranscriptWriter({
    deviceId,
    store: runtimeStore,
    onAssistantRecords: (payloadJsons: string[]) => {
      for (const payloadJson of payloadJsons) {
        linkedFilePublisher.publishText(assistantPayloadText(payloadJson));
      }
    },
    getAuthToken: () =>
      (context.state?.authToken ?? envAuthToken ?? "").trim() || null,
    getBaseUrl: cloudRealtimeBaseUrl,
    getOwnerGeneration: getCloudOwnerGeneration,
    // A turn the runtime resumes this boot replays its own begin.
    isResumableTurn: (localTurnId: string) =>
      runtimeStore.runTasks?.isResumeOwned(localTurnId) ?? false,
    ...(appendLocalChatEvent
      ? {
          onDurableDeliveryFailure: ({
            conversationId,
            localTurnId,
            userMessageId,
            message,
          }: {
            conversationId: string;
            localTurnId: string;
            userMessageId: string;
            message: string;
          }) => {
            appendLocalChatEvent({
              conversationId,
              type: "assistant_message",
              eventId: `cloud-sync-error:${deviceId}:${localTurnId}`,
              timestamp: Date.now(),
              payload: {
                text: message,
                userMessageId,
                source: "cloud-sync-error",
              },
            });
          },
        }
      : {}),
  });

  /**
   * How `spawn_agent` checks and captures a requested model. Shared with the
   * runner so an agent placed on this device from elsewhere can honor the
   * model its requester asked for.
   */
  const spawnModelSupport: SpawnModelSupport = {
    // spawn_agent's `model` parameter: throws the standard route-failure
    // message when a plain model reference can't be resolved, so the spawn
    // fails loudly instead of silently falling back to the default.
    validateSpawnModel: (modelName) => {
      resolveRunnerLlmRoute(context, AGENT_IDS.GENERAL, modelName);
    },
    validateSpawnModelWithMetadata: async (modelName, reasoningEffort) => {
      await resolveRunnerLlmRouteWithMetadata(
        context,
        AGENT_IDS.GENERAL,
        modelName,
        reasoningEffort,
      );
    },
    captureSpawnModelConfig: async ({
      agentType,
      spawnEngine,
      useConfiguredEngine,
      model: spawnModel,
      spawnReasoningEffort,
    }) => {
      const configuredEngine = getAgentRuntimeEngine(stellaDataDir);
      const selectedEngine = useConfiguredEngine
        ? configuredEngine
        : spawnEngine.engine;
      const subscriptionHarnessEnabled = getSubscriptionHarnessEnabled(
        stellaDataDir,
        selectedEngine,
      );
      const agent = resolveAgent(context, agentType);
      const configuredModel =
        spawnModel ?? getConfiguredModel(context, agentType, agent);
      const configuredReasoningEffort = getReasoningEffort(
        stellaDataDir,
        agentType,
      );
      const sampledEngineConfig = sampleAgentEngineConfig({
        stellaDataDir,
        engine: selectedEngine,
        configuredModel,
        engineModelOverride: useConfiguredEngine
          ? undefined
          : spawnEngine.model,
        reasoningEffort: spawnReasoningEffort ?? configuredReasoningEffort,
      });
      const sampledSpawnEngine: SpawnEngineSelection =
        selectedEngine === "default"
          ? { engine: "default" }
          : {
              engine: selectedEngine,
              ...(sampledEngineConfig.engineModel
                ? { model: sampledEngineConfig.engineModel }
                : {}),
            };
      const harnessRouteModel = resolveSubscriptionHarnessRouteModel({
        stellaDataDir,
        agentType,
        configuredEngine,
        subscriptionHarnessEnabled,
        configuredModel,
        spawnEngine: sampledSpawnEngine,
      });
      const model = harnessRouteModel ?? configuredModel;
      const resolvedLlm = await resolveRunnerLlmRouteWithMetadata(
        context,
        agentType,
        model,
        spawnReasoningEffort,
      );
      return captureEffectiveModelConfig({
        stellaDataDir,
        engine: selectedEngine,
        subscriptionHarnessEnabled,
        configuredModel: model,
        engineModelOverride: sampledEngineConfig.engineModel,
        ...(sampledEngineConfig.serviceTier
          ? { serviceTierOverride: sampledEngineConfig.serviceTier }
          : {}),
        engineConfigSampled: true,
        resolvedLlm,
        reasoningEffort: sampledEngineConfig.reasoningEffort,
      });
    },
  };

  const toolHost = createToolHost({
    stellaAppDir,
    stellaDataDir,
    stellaBrowserBinPath,
    stellaOfficeBinPath,
    stellaComputerCliPath,
    stellaMediaCliPath,
    stellaXApiCliPath,
    cliBridgeSocketPath,
    askUser,
    requestSecureInput,
    useSecureValue,
    ...(requestBrowserExtensionConnect
      ? { requestBrowserExtensionConnect }
      : {}),
    ...(requestConnectorConnection ? { requestConnectorConnection } : {}),
    ...(switchExecutionDestination ? { switchExecutionDestination } : {}),
    ...spawnModelSupport,
    resolveCloudExecutionSelection: async ({
      model: modelOverride,
      spawnEngine,
      reasoningEffort,
    }): Promise<CloudExecutionSelection> => {
      const agent = resolveAgent(context, AGENT_IDS.GENERAL);
      const configuredModel = getConfiguredModel(
        context,
        AGENT_IDS.GENERAL,
        agent,
      );
      const model = modelOverride ?? configuredModel;
      const resolvedLlm = await resolveRunnerLlmRouteWithMetadata(
        context,
        AGENT_IDS.GENERAL,
        model,
        reasoningEffort,
      );
      const { modelConfigSnapshot } = resolveEffectiveAgentExecutionConfig(
        context,
        {
          agentType: AGENT_IDS.GENERAL,
          model,
          resolvedLlm,
          ...(spawnEngine ? { spawnEngine } : {}),
          ...(reasoningEffort ? { spawnReasoningEffort: reasoningEffort } : {}),
        },
      );
      if (!modelConfigSnapshot) {
        throw new Error("Could not resolve the General agent's cloud model.");
      }
      return toCloudExecutionSelection(modelConfigSnapshot);
    },
    scheduleApi,
    webSearch: async (query, searchOptions) => {
      const handler = context.state?.webSearch;
      if (!handler) {
        return {
          text: "Web search is not available yet — runtime is still starting up.",
          results: [],
        };
      }
      return await handler(query, searchOptions);
    },
    getCloudBackendAuth: () => {
      const baseUrl = context.state?.backendUrl?.trim();
      const authToken = (context.state?.authToken ?? envAuthToken ?? "").trim();
      return baseUrl && authToken ? { baseUrl, authToken } : null;
    },
    getStellaSiteAuth: () => {
      const baseUrl = context.state?.backendUrl?.trim();
      const authToken = (context.state?.authToken ?? envAuthToken ?? "").trim();
      return baseUrl && authToken ? { baseUrl, authToken } : null;
    },
    agentApi: {
      // Cloud placements never touch LocalAgentManager: the subject lives off
      // this machine, so the spawn leaves the device entirely.
      cloudDispatch,
      cloudContinue: cloudThreadController.continueThread,
      cloudCancel: cloudThreadController.cancelThread,
      lookupConversationAgentThread: async (threadId, conversationId) => {
        const client = backend.client();
        if (
          !client ||
          !isCloudSignedIn() ||
          conversationId.startsWith("local_")
        ) {
          return null;
        }
        const thread = await raceWithTimeoutError(
          client.call("agentThreads.lookup", { conversationId, threadId }),
          CONVERSATION_THREAD_LOOKUP_TIMEOUT_MS,
          () => new Error("Stella's cloud did not answer the thread lookup."),
        ).catch(() => null);
        return thread ? { thread, thisDeviceId: deviceId } : null;
      },
      createAgent: async (request) => {
        if (!context.state.localAgentManager) {
          throw new Error("Local task manager not initialized");
        }
        return await context.state.localAgentManager.createAgent(request);
      },
      getAgent: async (agentId) => {
        if (!context.state.localAgentManager) {
          return null;
        }
        return await context.state.localAgentManager.getAgent(agentId);
      },
      cancelAgent: async (agentId, reason) => {
        if (!context.state.localAgentManager) {
          return { canceled: false };
        }
        const record = context.runtimeStore.getAgentRecord?.(agentId);
        if (record?.conversationId) {
          context.state.backgroundExitWake?.disarm({
            conversationId: record.conversationId,
            agentId,
          });
        } else {
          // Defensive fallback for a still-in-memory attempt whose durable row
          // could not be read. LocalAgentManager itself keys these ids globally.
          context.state.backgroundExitWake?.disarm(agentId);
        }
        return await context.state.localAgentManager.cancelAgent(
          agentId,
          reason,
        );
      },
      sendAgentMessage: async (agentId, message, from, options) => {
        if (
          !context.state.localAgentManager ||
          typeof context.state.localAgentManager.sendAgentMessage !== "function"
        ) {
          return { delivered: false };
        }
        return await context.state.localAgentManager.sendAgentMessage(
          agentId,
          message,
          from,
          options,
        );
      },
      drainAgentMessages: async (agentId, recipient) => {
        if (
          !context.state.localAgentManager ||
          typeof context.state.localAgentManager.drainAgentMessages !==
            "function"
        ) {
          return [];
        }
        return await context.state.localAgentManager.drainAgentMessages(
          agentId,
          recipient,
        );
      },
      // Read-only backing for `agent_status`: durable-store SELECTs only, so
      // checking on a thread can never deliver input to it or resume it. The
      // live-state derivation is the exact signal `other_threads` uses
      // (`runtime_agents.status` via deriveRuntimeThreadLiveState).
      readAgentThreadStatus: async (agentId) => {
        const store = context.runtimeStore;
        if (!store) return null;
        const record = store.getAgentRecord(agentId);
        if (!record) return null;
        const liveStateInput = { agentStatus: record.status };
        const engine = record.modelConfigSnapshot?.engine;
        const delivery =
          context.state.localAgentManager?.describeReportDelivery?.(agentId) as
            | Pick<AgentThreadStatusRead, "owner" | "reportDeliveredTo">
            | undefined;
        return {
          ...(delivery
            ? {
                owner: delivery.owner,
                reportDeliveredTo: delivery.reportDeliveredTo,
              }
            : {}),
          status: deriveRuntimeThreadLiveState(liveStateInput),
          statusLabel: formatRuntimeThreadStatusLabel(liveStateInput),
          agentStatus: record.status,
          ...(record.description ? { description: record.description } : {}),
          ...(engine && engine !== "default" ? { engine } : {}),
          lastActiveAt: record.updatedAt,
          messages: store.loadThreadMessages(agentId, 200),
        };
      },
    },
  });

  Object.assign(context, {
    backend,
    deviceId,
    stellaAppDir,
    stellaDataDir,
    stellaBrowserBinPath,
    stellaOfficeBinPath,
    stellaComputerCliPath,
    askUser,
    requestSecureInput,
    useSecureValue,
    requestRuntimeAuthRefresh,
    requestChallengeToken,
    getDeviceSigner,
    scheduleApi,
    runtimeStore,
    listLocalChatEvents,
    openLocalChatEventWindow,
    appendLocalChatEvent,
    notifyThreadActivityUpdated,
    getDefaultConversationId,
    cloudTranscript,
    linkedFilePublisher,
    loadExecutionContext: async () => {
      const authToken = context.state.authToken;
      return loadDeviceExecutionContext({
        deviceId,
        baseUrl: authToken ? await cloudRealtimeBaseUrl() : null,
        authToken,
        loadMedia: () =>
          loadMediaAccess({
            stellaDataDir,
            hasConnectedAccount: context.state.hasConnectedAccount === true,
            client: context.backend.client(),
          }),
      });
    },
    paths: {
      // The stella-runtime extension (agent definitions, orchestrator hooks)
      // ships in the app bundle and is loaded from there. The data dir has no
      // extensions tier and nothing seeds one — pointing the loader at
      // `<data>/extensions` silently drops every bundled agent, leaving the
      // orchestrator with the fallback prompt and no tools.
      extensionsPath: resolveRuntimeSourceAsset("extensions"),
    },
    state: {
      backendUrl: initialBackendUrl(),
      authToken: envAuthToken,
      hasConnectedAccount: false,
      cloudSyncEnabled: true,
      isRunning: false,
      isInitialized: false,
      initializationPromise: null,
      initializationStarted: createReadinessLatch(),
      localAgentManager: null,
      backgroundExitWake: null,
      activeOrchestratorRunId: null,
      activeOrchestratorConversationId: null,
      activeOrchestratorUiVisibility: "visible",
      activeOrchestratorSession: null,
      orchestratorSessions: new Map(),
      compactionScheduler: new BackgroundCompactionScheduler(),
      queuedOrchestratorTurns: [],
      runCoordinator: null,
      pendingFollowUpReplies: new Map(),
      supervisor: createKernelRunSupervisor(),
      conversationCallbacks: new Map(),
      runCallbacksByRunId: new Map(),
      loadedAgents: [],
      webSearch: null,
    },
    hookEmitter,
    toolHost,
    spawnModelSupport,
  });

  // Needs both halves: the tool host owns the shell sessions, the agent
  // manager owns the threads a wake resumes. Both are reachable now, so the
  // wake is wired here rather than deferred to initialization.
  context.state.backgroundExitWake = createBackgroundExitWake({
    watchShellExit: toolHost.watchShellExit,
    readShellExitSnapshot: toolHost.readShellExitSnapshot,
    getThreadStatus: async (agentId: string, conversationId: string) => {
      const snapshot = await context.state.localAgentManager?.getAgent(agentId);
      // The wake registry is owner-scoped even though LocalAgentManager's
      // historical lookup key is only the globally-minted thread id. Fail
      // closed if an explicit/reused id resolves in another conversation.
      if (!snapshot || snapshot.conversationId !== conversationId) {
        return "canceled";
      }
      return snapshot.status;
    },
    writeExitLog: async (sessionId: string, contents: string) =>
      await writeBackgroundExitLog(stellaDataDir, sessionId, contents),
    deliver: async ({
      conversationId,
      agentId,
      eventId,
      isCurrent,
      text,
    }: Record<string, any>) => {
      const manager = context.state.localAgentManager;
      if (!manager) return false;
      const snapshot = await manager.getAgent(agentId);
      if (!snapshot || snapshot.conversationId !== conversationId) {
        return false;
      }
      // getAgent may cross storage I/O. A new run/cancel/runner teardown can
      // disarm this batch while that await is pending; close that window before
      // the synchronous manager enqueue/resume boundary performs any effect.
      if (typeof isCurrent === "function" && !isCurrent()) {
        return false;
      }
      // Same door as `send_input`: rehydrates an evicted or finished thread
      // with its own history instead of starting a stranger.
      const result = await manager.sendAgentMessage(
        agentId,
        text,
        "orchestrator",
        {
          deliveryKind: "external-input",
          deliveryEventId: eventId,
        },
      );
      if (result.delivered) {
        console.info(
          `[background-wake] resumed thread ${agentId} (conversation ${conversationId}) on background command exit`,
        );
      }
      return result.delivered;
    },
  });

  return context;
};

export const resolveAgent = (
  context: RunnerContext,
  agentType: string,
): ParsedAgentLike | undefined =>
  context.state.loadedAgents.find((entry) =>
    entry.agentTypes.includes(agentType),
  ) ??
  context.state.loadedAgents.find((entry) => entry.id === agentType) ??
  getBundledCoreAgentFallback(agentType);

export const getConfiguredModel = (
  context: RunnerContext,
  agentType: string,
  agent?: ParsedAgentLike,
): string | undefined => {
  const modelFromPrefs = getModelOverride(context.stellaDataDir, agentType);
  return modelFromPrefs ?? agent?.model;
};

export type ResolvedAgentModelRoute = {
  agent?: ParsedAgentLike;
  model?: string;
  resolvedLlm: ResolvedLlmRoute;
};

export const resolveAgentModelRoute = async (
  context: RunnerContext,
  agentType: string,
  modelOverride?: string,
  routeAgentType = agentType,
): Promise<ResolvedAgentModelRoute> => {
  const agent = resolveAgent(context, agentType);
  const configuredModel = getConfiguredModel(context, agentType, agent);
  const model = modelOverride ?? configuredModel;
  const resolvedLlm = await resolveRunnerLlmRouteWithMetadata(
    context,
    routeAgentType,
    model,
  );
  return {
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    resolvedLlm,
  };
};

export type BuildAgentContextArgs = {
  conversationId: string;
  agentType: string;
  runId: string;
  threadId?: string;
  /**
   * Per-spawn engine selection (spawn_agent's `model` parameter). Plain model
   * references carry `default`; explicit engine references carry the chosen
   * external engine. Overrides the preference-configured engine for this run.
   */
  spawnEngine?: SpawnEngineSelection;
  /** Per-spawn reasoning override from spawn_agent's model suffix. */
  spawnReasoningEffort?: SpawnReasoningEffort;
  /** Effective Orchestrator route inherited by a durable Manager thread. */
  modelConfigSnapshot?: AgentModelConfigSnapshot;
  /** One-shot configured-engine sample paired with route resolution. */
  configuredAgentEngine?: AgentRuntimeEngine;
  /** One-shot generic agent effort sample paired with route resolution. */
  configuredReasoningEffort?: string;
  /** Engine model/effort/tier sampled before route resolution. */
  sampledEngineConfig?: SampledAgentEngineConfig;
  /** Preference sample taken before async route resolution. */
  subscriptionHarnessEnabled?: boolean;
  toolWorkspaceRoot?: string;
  /**
   * The current turn's user-message id. The chat-events log receives the
   * user message before the run prepares its context, and the same message
   * arrives via the prompt, so the matching event (by eventId or requestId)
   * is excluded from the legacy pre-transition history shim to avoid
   * duplication. Reminders still see the full event list.
   */
  currentUserMessageId?: string;
} & ResolvedAgentModelRoute;

export { captureEffectiveModelConfig, resolveAgentEngineForRun };

export type SampledAgentEngineConfig = {
  engineModel?: string;
  reasoningEffort?: AgentModelReasoningEffort;
  serviceTier?: CodexServiceTier;
};

/** Freeze every engine-owned picker value before any async route lookup. */
export const sampleAgentEngineConfig = (args: {
  stellaDataDir: string;
  engine: AgentRuntimeEngine;
  configuredModel?: string;
  engineModelOverride?: string;
  reasoningEffort?: string;
}): SampledAgentEngineConfig => {
  const explicitEffort = normalizeCapturedReasoningEffort(args.reasoningEffort);
  if (args.engine === "codex_cli") {
    const codex = getCodexSubscriptionPreferences(
      args.stellaDataDir,
      args.configuredModel,
      args.engineModelOverride,
    );
    const effort =
      explicitEffort ?? normalizeCapturedReasoningEffort(codex.reasoningEffort);
    return {
      engineModel: codex.model,
      ...(effort ? { reasoningEffort: effort } : {}),
      serviceTier: codex.serviceTier,
    };
  }
  if (args.engine === "claude_code_local") {
    const model = getClaudeCodeAgentModelId(
      args.stellaDataDir,
      args.configuredModel,
      AGENT_IDS.ORCHESTRATOR,
      args.engineModelOverride,
    ).replace(/^claude-code\//, "");
    const effort =
      explicitEffort ??
      normalizeCapturedReasoningEffort(
        getClaudeCodeRuntimeEffortLevel(args.stellaDataDir),
      );
    return {
      engineModel: model,
      ...(effort ? { reasoningEffort: effort } : {}),
    };
  }
  return explicitEffort ? { reasoningEffort: explicitEffort } : {};
};

/**
 * Resolve the provider route used when a General Codex run executes through
 * Stella's Pi harness. Root Orchestrator routing remains unchanged.
 */
export const resolveSubscriptionHarnessRouteModel = (args: {
  stellaDataDir: string;
  agentType: string;
  configuredEngine: AgentRuntimeEngine;
  subscriptionHarnessEnabled: boolean;
  configuredModel?: string;
  spawnEngine?: SpawnEngineSelection;
  modelConfigSnapshot?: AgentModelConfigSnapshot;
}): string | undefined => {
  if (args.agentType === AGENT_IDS.ORCHESTRATOR) return undefined;
  const engine =
    args.modelConfigSnapshot?.engine ??
    resolveAgentEngineForRun(args.configuredEngine, args.spawnEngine);
  if (engine !== "codex_cli") return undefined;
  if (args.modelConfigSnapshot) {
    const snapshotModel = args.modelConfigSnapshot.engineModel?.trim();
    return snapshotModel
      ? `chatgpt/${snapshotModel}`
      : args.modelConfigSnapshot.routeModel.startsWith("chatgpt/")
        ? args.modelConfigSnapshot.routeModel
        : `chatgpt/${getCodexSubscriptionPreferences(args.stellaDataDir).model}`;
  }
  const codex = getCodexSubscriptionPreferences(
    args.stellaDataDir,
    args.configuredModel,
    args.spawnEngine?.engine === "codex_cli"
      ? args.spawnEngine.model
      : undefined,
  );
  return `chatgpt/${codex.model}`;
};

export const resolveSpawnReasoningEffortForModel = (
  model: Model<Api>,
  requested: SpawnReasoningEffort,
): Exclude<ModelThinkingLevel, "off"> | undefined => {
  const effortOrder: readonly ModelThinkingLevel[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ];
  const requestedIndex = effortOrder.indexOf(requested);
  const supported = getSupportedThinkingLevels(model);
  let nearest: ModelThinkingLevel | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of supported) {
    const candidateIndex = effortOrder.indexOf(candidate);
    if (candidateIndex === -1) continue;
    const distance = Math.abs(candidateIndex - requestedIndex);
    const nearestIndex = nearest ? effortOrder.indexOf(nearest) : -1;
    if (
      distance < nearestDistance ||
      (distance === nearestDistance && candidateIndex > nearestIndex)
    ) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return nearest === "off" ? undefined : nearest;
};

export const resolveEffectiveAgentExecutionConfig = (
  context: RunnerContext,
  args: Pick<
    BuildAgentContextArgs,
    | "agentType"
    | "model"
    | "resolvedLlm"
    | "spawnEngine"
    | "spawnReasoningEffort"
    | "modelConfigSnapshot"
    | "configuredAgentEngine"
    | "configuredReasoningEffort"
    | "sampledEngineConfig"
    | "subscriptionHarnessEnabled"
  >,
) => {
  // A per-spawn engine selection wins over the preference-configured engine
  // for this run only; saved preferences are never touched. Persisted
  // snapshots restore the exact spawn-time selection on resume.
  const restoredSpawnEngine =
    args.spawnEngine ??
    restoreSpawnEngineFromModelConfig(args.modelConfigSnapshot);
  const configuredAgentEngine =
    args.configuredAgentEngine ?? getAgentRuntimeEngine(context.stellaDataDir);
  const agentEngine =
    args.modelConfigSnapshot?.engine ??
    resolveAgentEngineForRun(configuredAgentEngine, restoredSpawnEngine);
  // Codex snapshots from older builds may say native/false. Codex now always
  // uses the in-process subscription transport, including restored runs.
  const subscriptionHarnessEnabled =
    agentEngine === "codex_cli" ||
    (args.modelConfigSnapshot
      ? args.modelConfigSnapshot.subscriptionHarnessEnabled === true
      : (args.subscriptionHarnessEnabled ??
        getSubscriptionHarnessEnabled(context.stellaDataDir, agentEngine)));
  const capturedSubscriptionHarness =
    subscriptionHarnessEnabled &&
    (agentEngine === "codex_cli" || agentEngine === "claude_code_local");
  const usesInProcessSubscriptionHarness =
    args.agentType !== AGENT_IDS.ORCHESTRATOR &&
    capturedSubscriptionHarness &&
    agentEngine === "codex_cli";
  const savedReasoningEffort =
    args.configuredReasoningEffort ??
    getReasoningEffort(context.stellaDataDir, args.agentType);
  const spawnReasoningEffort = args.spawnReasoningEffort;
  const inheritedReasoningEffort = args.modelConfigSnapshot?.reasoningEffort;
  const sampledEngineReasoningEffort =
    args.sampledEngineConfig?.reasoningEffort === "none"
      ? undefined
      : args.sampledEngineConfig?.reasoningEffort;
  const effectiveReasoningEffort = inheritedReasoningEffort
    ? inheritedReasoningEffort === "none"
      ? undefined
      : inheritedReasoningEffort
    : spawnReasoningEffort &&
        (agentEngine === "default" || usesInProcessSubscriptionHarness)
      ? resolveSpawnReasoningEffortForModel(
          args.resolvedLlm.model,
          spawnReasoningEffort,
        )
      : (spawnReasoningEffort ??
        (savedReasoningEffort !== "default"
          ? savedReasoningEffort
          : (sampledEngineReasoningEffort ?? savedReasoningEffort)));
  if (
    spawnReasoningEffort &&
    (agentEngine === "default" || usesInProcessSubscriptionHarness)
  ) {
    if (!effectiveReasoningEffort) {
      console.debug("[stella:spawn-reasoning] effort dropped", {
        requested: spawnReasoningEffort,
        model: args.resolvedLlm.model.id,
        reason: "resolved model has no reasoning dial",
      });
    } else if (effectiveReasoningEffort !== spawnReasoningEffort) {
      console.debug("[stella:spawn-reasoning] effort clamped", {
        requested: spawnReasoningEffort,
        effective: effectiveReasoningEffort,
        model: args.resolvedLlm.model.id,
      });
    }
  }

  const modelConfigSnapshot = args.modelConfigSnapshot
    ? agentEngine === "codex_cli"
      ? {
          ...args.modelConfigSnapshot,
          subscriptionHarnessEnabled: true,
          routeModel: `chatgpt/${args.modelConfigSnapshot.engineModel}`,
        }
      : args.modelConfigSnapshot
    : captureEffectiveModelConfig({
        stellaDataDir: context.stellaDataDir,
        agentType: args.agentType,
        engine: agentEngine,
        subscriptionHarnessEnabled: capturedSubscriptionHarness,
        configuredModel: args.model,
        engineModelOverride:
          args.sampledEngineConfig?.engineModel ?? restoredSpawnEngine?.model,
        serviceTierOverride: args.sampledEngineConfig?.serviceTier,
        engineConfigSampled: Boolean(args.sampledEngineConfig),
        ...(restoredSpawnEngine ? { spawnEngine: restoredSpawnEngine } : {}),
        resolvedLlm: args.resolvedLlm,
        reasoningEffort: effectiveReasoningEffort,
      });

  return {
    agentEngine,
    effectiveReasoningEffort,
    modelConfigSnapshot,
    restoredSpawnEngine,
  };
};

export const buildAgentContext = async (
  context: RunnerContext,
  args: BuildAgentContextArgs,
): Promise<LocalAgentContext> => {
  const agent = args.agent;
  const model = args.model;
  const resolvedLlm = args.resolvedLlm;
  const memoryEnabled = loadLocalPreferences(
    context.stellaDataDir,
  ).memoryEnabled;
  const threadKey = buildRuntimeThreadKey({
    conversationId: args.conversationId,
    agentType: args.agentType,
    runId: args.runId,
    threadId: args.threadId,
  });
  const storedThreadMessages =
    context.runtimeStore.loadThreadMessages(threadKey);

  const resolvedContextWindow = Number(resolvedLlm.model.contextWindow);
  const contextWindow =
    Number.isFinite(resolvedContextWindow) && resolvedContextWindow > 0
      ? Math.floor(resolvedContextWindow)
      : 128_000;

  let threadHistory: ThreadHistoryEntry[] | undefined;
  let staleUserReminderText: string | undefined;
  let connectorTransitionReminderText: string | undefined;
  // Locale is plumbed onto user-message payloads alongside `timezone`, so
  // we read whatever was most recently sent. The orchestrator path
  // already loads recent local events to build history; subagent paths
  // make a fresh, smaller fetch since they don't otherwise need the
  // local-events stream.
  let userLocale: string | undefined;
  // The orchestrator-shape thread history (merged stored thread messages +
  // recent local events) and the runtime reminders (stale-user reminder,
  // active-threads prompt) are gated by the `injectsRuntimeReminders`
  // capability rather than a literal `agentType === ORCHESTRATOR` check, so
  // future user-facing agents inherit the shape by data, not code.
  const injectsRuntimeReminders = agentHasCapability(
    args.agentType,
    "injectsRuntimeReminders",
  );
  if (injectsRuntimeReminders && context.listLocalChatEvents) {
    // The reminders, the locale and the legacy history shim all read the
    // newest ORCHESTRATOR_LOCAL_EVENT_WINDOW chat events, but each consumes
    // only a few of them. Query exactly those instead of parsing the whole
    // window every turn; the results are what the full-window filters
    // below would produce (see `event-window.ts`).
    const eventWindow = context.openLocalChatEventWindow
      ? context.openLocalChatEventWindow(
          args.conversationId,
          ORCHESTRATOR_LOCAL_EVENT_WINDOW,
        )
      : createListedLocalChatEventWindow(
          context.listLocalChatEvents(
            args.conversationId,
            ORCHESTRATOR_LOCAL_EVENT_WINDOW,
          ),
        );
    const queryWindow = (query: LocalChatEventWindowQuery) =>
      filterLocalChatEventWindow(eventWindow.query(query), query);
    // Stale-user and connector reminders read the latest context event and
    // the latest two user messages; the locale reads the latest user message
    // that carries one. The newest few context events usually hold all of
    // them, so read those and only widen when they don't.
    const recentContextEvents = queryWindow({
      types: LOCAL_CONTEXT_EVENT_TYPE_LIST,
      limit: RECENT_CONTEXT_EVENT_READ,
    });
    const recentUserEvents = recentContextEvents.filter(
      (event) => event.type === "user_message",
    );
    const latestUserEvents =
      recentUserEvents.length >= 2 ||
      recentContextEvents.length < RECENT_CONTEXT_EVENT_READ
        ? recentUserEvents.slice(-2)
        : queryWindow({ types: ["user_message"], limit: 2 });
    const latestContextEvent = recentContextEvents.at(-1);
    const reminderEvents =
      latestContextEvent && latestContextEvent.type !== "user_message"
        ? [...latestUserEvents, latestContextEvent]
        : latestUserEvents;
    staleUserReminderText = buildStaleUserReminder(reminderEvents);
    connectorTransitionReminderText =
      buildConnectorTransitionReminder(reminderEvents);
    userLocale =
      findLatestLocale(recentUserEvents) ??
      findLatestLocale(latestUserEvents) ??
      (recentContextEvents.length < RECENT_CONTEXT_EVENT_READ
        ? undefined
        : findLatestLocale(
            queryWindow({ types: ["user_message"], payloadKey: "locale" }),
          ));
    const historyBound = resolveLegacyHistoryEventBound(storedThreadMessages);
    const localEvents =
      historyBound.kind === "none"
        ? []
        : queryWindow({
            types: LOCAL_CONTEXT_EVENT_TYPE_LIST,
            ...(historyBound.kind === "before"
              ? { beforeTimestamp: historyBound.timestamp }
              : {}),
          });
    // The current turn's user message rides in via the prompt; its
    // just-appended display event must not double into the legacy
    // pre-transition history shim.
    const historyEvents = args.currentUserMessageId
      ? localEvents.filter(
          (event) =>
            event._id !== args.currentUserMessageId &&
            event.requestId !== args.currentUserMessageId,
        )
      : localEvents;
    threadHistory = buildOrchestratorThreadHistory({
      storedThreadMessages,
      localEvents: historyEvents,
      contextWindow,
    });
  } else {
    threadHistory = storedThreadMessages;
    if (context.listLocalChatEvents) {
      const recent = context
        .listLocalChatEvents(args.conversationId, 32)
        .filter((event) => LOCAL_CONTEXT_EVENT_TYPES.has(event.type));
      userLocale = findLatestLocale(recent);
    }
  }

  const activeThreadsPrompt = injectsRuntimeReminders
    ? buildActiveThreadsPrompt(
        context.runtimeStore.listActiveThreads(args.conversationId),
      )
    : "";
  const dynamicContextSections: Array<{ id: string; text: string }> = [];

  // Inject the user's response-language directive at the top of the
  // dynamic context. It's a single line, comes from the latest
  // `user_message` event's `locale` payload, and is `undefined` for
  // English so we don't waste tokens on a no-op directive.
  const responseLanguageDirective = getResponseLanguageSystemPrompt(userLocale);
  if (responseLanguageDirective) {
    dynamicContextSections.push({
      id: "user-language",
      text: `## User Language\n${responseLanguageDirective}`,
    });
  }

  if (args.toolWorkspaceRoot?.trim()) {
    dynamicContextSections.push({
      id: "workspace",
      text: [
        "## Shared Session Workspace",
        `Workspace root: ${args.toolWorkspaceRoot.trim()}`,
        "Use relative paths unless an absolute path under this workspace is already shown by a tool.",
        "File tools are restricted to this workspace root.",
      ].join("\n"),
    });
  }
  const reminderState =
    injectsRuntimeReminders && activeThreadsPrompt
      ? context.runtimeStore.getOrchestratorReminderState(args.conversationId)
      : {
          shouldInjectDynamicReminder: false,
        };
  // A persisted snapshot is authoritative. New Orchestrator/General turns
  // capture the current selection once; resumed turns restore it without
  // consulting later preference changes.
  const {
    agentEngine,
    effectiveReasoningEffort,
    modelConfigSnapshot,
    restoredSpawnEngine,
  } = resolveEffectiveAgentExecutionConfig(context, args);

  const subscriptionHarnessEnabled =
    agentEngine === "codex_cli" ||
    (args.modelConfigSnapshot
      ? args.modelConfigSnapshot.subscriptionHarnessEnabled === true
      : (args.subscriptionHarnessEnabled ??
        getSubscriptionHarnessEnabled(context.stellaDataDir, agentEngine)));
  const capturedSubscriptionHarness =
    subscriptionHarnessEnabled &&
    (agentEngine === "codex_cli" || agentEngine === "claude_code_local");
  const usesInProcessSubscriptionHarness =
    args.agentType !== AGENT_IDS.ORCHESTRATOR &&
    capturedSubscriptionHarness &&
    agentEngine === "codex_cli";

  const fileEditToolFamily = getFileEditToolFamily({
    agentType: args.agentType,
    model: resolvedLlm.toolPolicyModel ?? resolvedLlm.model,
    agentEngine,
  });
  const toolsAllowlist = rewriteFileEditToolNames(
    agent?.toolsAllowlist,
    fileEditToolFamily,
  );
  if (
    fileEditToolFamily === "write_edit" &&
    (toolsAllowlist?.includes(WRITE_TOOL_NAME) ||
      toolsAllowlist?.includes(EDIT_TOOL_NAME))
  ) {
    dynamicContextSections.push({
      id: "file-editing-tools",
      text: [
        "## File Editing Tools",
        "This run is using a non-OpenAI model. Use `Write` for new or full-file edits and `Edit` for targeted replacements.",
        "`apply_patch` is not available in this run.",
      ].join("\n"),
    });
  } else if (toolsAllowlist?.includes(APPLY_PATCH_TOOL_NAME)) {
    dynamicContextSections.push({
      id: "file-editing-tools",
      text: [
        "## File Editing Tools",
        "Use `apply_patch` for manual code edits. Do not create or edit files with `cat` or other shell write tricks. Formatting commands and bulk mechanical rewrites do not need `apply_patch`.",
        "Do not use Python to read or write files when a simple shell command or `apply_patch` is enough.",
      ].join("\n"),
    });
  }
  // The skill catalog is a message-resident block now, NOT a system-prompt
  // section: rendering it into the system prompt meant any mid-thread skill
  // save rewrote request block #1 and invalidated the whole thread's prompt
  // cache. It rides the agent context into the ResidentBlock registry
  // (`agent-runtime/resident-context.js`), which pins it as a hidden
  // `bootstrap.skills_catalog` message at thread start and appends a fresh
  // copy only when the rendered bytes actually change.
  let skillsCatalog: string | undefined;
  if (agentHasCapability(args.agentType, "injectsSkillCatalog")) {
    const skillCatalogOptions =
      agentEngine === "codex_cli" && !usesInProcessSubscriptionHarness
        ? { omitSkillIds: CODEX_SKILL_CATALOG_OMITTED_IDS }
        : undefined;
    skillsCatalog = await renderSkillCatalogBlock(
      context.stellaDataDir,
      skillCatalogOptions,
    );
    // Connector discovery + connect offers are orchestrator-driven now:
    // a deterministic keyword reminder (connector-availability hook) plus
    // the demoted `connector_status` tool (direct, or via node_repl's
    // tools.connector_status) own the offer flow. Agents just use
    // already-connected integrations via their skills; no standing
    // integration guidance is injected here.
  }
  // Resolve the live prompt body: the user's selected prompt preset when set,
  // else the shipped bundled body (mtime-gated — unchanged files are not
  // re-read). Falls back to the registered prompt for extension agents.
  const bundledSystemPrompt = await loadAgentSystemPrompt(
    agent?.id ?? args.agentType,
    context.stellaDataDir,
  );
  const injectsCoreMemory = agentHasCapability(
    args.agentType,
    "injectsCoreMemory",
  );
  const injectsUserProfile = agentHasCapability(
    args.agentType,
    "injectsUserProfile",
  );
  const injectsPersonality = agentHasCapability(
    args.agentType,
    "injectsPersonality",
  );
  return {
    systemPrompt:
      bundledSystemPrompt ??
      agent?.systemPrompt ??
      defaultPromptForAgentType(args.agentType, context.stellaDataDir),
    dynamicContextSections,
    orchestratorReminderText: activeThreadsPrompt || undefined,
    shouldInjectDynamicReminder: reminderState.shouldInjectDynamicReminder,
    staleUserReminderText,
    connectorTransitionReminderText,
    executionContext: agentHasCapability(
      args.agentType,
      "injectsExecutionContext",
    )
      ? await context.loadExecutionContext?.()
      : undefined,
    toolsAllowlist,
    model,
    resolvedLlm,
    modelConfigSnapshot,
    reasoningEffort: effectiveReasoningEffort,
    maxAgentDepth: agent?.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH,
    memoryEnabled,
    coreMemory:
      memoryEnabled && injectsCoreMemory
        ? readCoreMemory(context.stellaDataDir)
        : undefined,
    userProfile:
      memoryEnabled && injectsUserProfile
        ? readUserProfileDoc(context.stellaDataDir)
        : undefined,
    memoryIndex:
      memoryEnabled && injectsUserProfile
        ? readMemoryIndexDoc(context.stellaDataDir)
        : undefined,
    personality: injectsPersonality
      ? readOrSeedPersonality(context.stellaDataDir)
      : undefined,
    skillsCatalog,
    threadHistory:
      threadHistory && threadHistory.length > 0 ? threadHistory : undefined,
    activeThreadId: threadKey,
    agentEngine,
    ...(restoredSpawnEngine ? { spawnEngine: restoredSpawnEngine } : {}),
    ...(args.spawnReasoningEffort
      ? { spawnReasoningEffort: args.spawnReasoningEffort }
      : {}),
    maxAgentConcurrency: isLocalCliAgentId(args.agentType)
      ? getMaxAgentConcurrency(context.stellaDataDir)
      : undefined,
  };
};
