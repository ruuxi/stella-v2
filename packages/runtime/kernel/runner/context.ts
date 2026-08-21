import path from "path";
import { resolveRuntimeSourceAsset } from "../shared/runtime-paths.js";
import { createFashionApi } from "./fashion-api.js";
import { createToolHost } from "../tools/host.js";
import { HookEmitter } from "../extensions/hook-emitter.js";
import {
  getAgentRuntimeEngine,
  getDeveloperModeEnabled,
  loadLocalPreferences,
  getAssistantWorkingMode,
  getMaxAgentConcurrency,
  getModelOverride,
  getReasoningEffort,
  getSubscriptionHarnessEnabled,
} from "../preferences/local-preferences.js";
import { readOrSeedPersonality } from "../personality/personality.js";
// Deprecated pre-transition compat shim; see `buildOrchestratorThreadHistory`.
import { buildLocalHistoryFromEvents } from "../local-history.js";
import type { LocalContextEvent } from "../storage/shared.js";
import { ConvexClient } from "convex/browser";
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
  estimateRuntimeTokens,
} from "../runtime-threads.js";
import { anyApi } from "convex/server";
import type { LocalAgentContext } from "../agents/local-agent-manager.js";
import { loadAgentSystemPrompt } from "../agents/home-agent-prompt.js";
import { applyDeveloperModePromptGate } from "../agents/prompt-dev-mode.js";
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
  CodexServiceTier,
  SpawnEngineSelection,
  SpawnReasoningEffort,
} from "@stella/contracts/agent-engine";
import type { AssistantWorkingMode } from "@stella/contracts/local-preferences";
import { getCodexRuntimePreferences } from "../integrations/codex-agent-runtime.js";
import {
  getClaudeCodeAgentModelId,
  getClaudeCodeRuntimeEffortLevel,
} from "../integrations/claude-code-agent-runtime.js";
import { getSupportedThinkingLevels } from "../../ai/models.js";
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
import { ensureDreamMemoryLayout } from "../memory/dream-storage.js";
import {
  isRecallNoMatchBrief,
  RecallRetrievalError,
  routeRecallIntent,
  runRecall,
} from "../agent-runtime/context-lookup.js";
import type { RecallTelemetrySeed } from "../agent-runtime/recall-telemetry.js";
import {
  RecallRunCache,
  type RecallLookupResult,
} from "../agent-runtime/recall-run-cache.js";
import {
  defaultPromptForAgentType,
  DEFAULT_MAX_AGENT_DEPTH,
  LOCAL_CONTEXT_EVENT_TYPES,
  LOCAL_HISTORY_RESERVE_TOKENS,
  MIN_LOCAL_HISTORY_TOKENS,
  readCoreMemory,
  readMemoryMapDoc,
  readUserProfileDoc,
  sanitizeConvexDeploymentUrl,
  sanitizeStellaBase,
} from "./shared.js";
import {
  resolveRunnerLlmRoute,
  resolveRunnerLlmRouteWithMetadata,
  resolveRunnerRecallLlmRoute,
} from "./model-selection.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import { getResponseLanguageSystemPrompt } from "./locale-prompt.js";
import {
  APPLY_PATCH_TOOL_NAME,
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
  value.replace(TRAILING_TIME_TAG_RE, "").trim();

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
export const buildOrchestratorThreadHistory = (args: {
  storedThreadMessages: ThreadHistoryEntry[];
  localEvents?: LocalContextEvent[];
  contextWindow: number;
}): ThreadHistoryEntry[] => {
  const localEvents = args.localEvents ?? [];
  const localHistoryBudget = getLocalHistoryBudget(args.contextWindow);

  if (args.storedThreadMessages.length === 0) {
    return buildLocalHistoryFromEvents({
      events: localEvents,
      maxTokens: localHistoryBudget,
    });
  }

  if (
    localEvents.length === 0 ||
    hasStoredCheckpoint(args.storedThreadMessages)
  ) {
    return args.storedThreadMessages;
  }

  const transitionCutoff =
    args.storedThreadMessages.find((message) => message.role !== "user")
      ?.timestamp ?? args.storedThreadMessages[0]?.timestamp;
  if (!transitionCutoff || !Number.isFinite(transitionCutoff)) {
    return args.storedThreadMessages;
  }

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
  requestCredential,
  requestBrowserExtensionConnect,
  requestConnectorConnection,
  requestRuntimeAuthRefresh,
  scheduleApi,
  fashionApi,
  runtimeStore,
  getAppBrowserContext,
  listLocalChatEvents,
  recallReadQueries,
  appendLocalChatEvent,
  notifyThreadActivityUpdated,
  getDefaultConversationId,
}: StellaHostRunnerOptions): RunnerContext => {
  const envProxyBaseUrl = sanitizeStellaBase(
    process.env.STELLA_LLM_PROXY_URL ?? null,
  );
  const envAuthToken = process.env.STELLA_LLM_PROXY_TOKEN ?? null;
  const envConvexDeploymentUrl = sanitizeConvexDeploymentUrl(
    process.env.STELLA_CONVEX_URL ?? null,
  );

  const context = {} as RunnerContext;
  const hookEmitter = new HookEmitter();
  const recallRunCache = new RecallRunCache();

  const convexAction = async (
    ref: unknown,
    args: unknown,
  ): Promise<unknown> => {
    const deploymentUrl = sanitizeConvexDeploymentUrl(
      context.state?.convexDeploymentUrl ?? envConvexDeploymentUrl,
    );
    const authToken = (context.state?.authToken ?? envAuthToken ?? "").trim();
    if (!deploymentUrl || !authToken) {
      throw new Error("Convex connection and auth are required.");
    }

    const existingClient = context.state?.convexClient;
    if (existingClient && context.state?.convexClientUrl === deploymentUrl) {
      return await (
        existingClient as {
          action: (tool: unknown, params: unknown) => Promise<unknown>;
        }
      ).action(ref, args);
    }

    const client = new ConvexClient(deploymentUrl, {
      logger: false,
      unsavedChangesWarning: false,
    });
    client.setAuth(async () => authToken);
    try {
      return await (
        client as {
          action: (tool: unknown, params: unknown) => Promise<unknown>;
        }
      ).action(ref, args);
    } finally {
      void client.close().catch(() => undefined);
    }
  };

  const resolvedFashionApi =
    fashionApi ?? createFashionApi({ convexAction, convexApi: anyApi });

  const toolHost = createToolHost({
    stellaAppDir,
    stellaDataDir,
    stellaBrowserBinPath,
    stellaOfficeBinPath,
    stellaComputerCliPath,
    stellaMediaCliPath,
    stellaXApiCliPath,
    cliBridgeSocketPath,
    requestCredential,
    ...(requestBrowserExtensionConnect
      ? { requestBrowserExtensionConnect }
      : {}),
    ...(requestConnectorConnection ? { requestConnectorConnection } : {}),
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
    scheduleApi,

    fashionApi: resolvedFashionApi,
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
    getStellaSiteAuth: () => {
      const baseUrl = sanitizeStellaBase(
        context.state?.convexSiteUrl ?? envProxyBaseUrl,
      );
      const authToken = (context.state?.authToken ?? envAuthToken ?? "").trim();
      return baseUrl && authToken ? { baseUrl, authToken } : null;
    },
    actionConvex: async (ref, args) =>
      (await convexAction(ref, args)) as unknown,
    queryConvex: async (ref, args) => {
      const deploymentUrl = sanitizeConvexDeploymentUrl(
        context.state?.convexDeploymentUrl ?? envConvexDeploymentUrl,
      );
      const authToken = (context.state?.authToken ?? envAuthToken ?? "").trim();
      if (!deploymentUrl || !authToken) {
        throw new Error("Convex connection and auth are required.");
      }

      const existingClient = context.state?.convexClient;
      if (existingClient && context.state?.convexClientUrl === deploymentUrl) {
        return await (
          existingClient as {
            query: (tool: unknown, params: unknown) => Promise<unknown>;
          }
        ).query(ref, args);
      }

      const client = new ConvexClient(deploymentUrl, {
        logger: false,
        unsavedChangesWarning: false,
      });
      client.setAuth(async () => authToken);
      try {
        return await (
          client as {
            query: (tool: unknown, params: unknown) => Promise<unknown>;
          }
        ).query(ref, args);
      } finally {
        void client.close().catch(() => undefined);
      }
    },
    contextProvider: async (payload) => {
      const runId = payload.runId ?? `request:${payload.requestId}`;
      return await recallRunCache.getOrCreate(
        runId,
        payload.prompt,
        payload.memorySearchTerms,
        async (): Promise<RecallLookupResult> => {
          try {
            const recallStartedAtMs = performance.now();
            // Resolve the Recall route lazily and memoized. Fast, indexed
            // lookups return evidence with no model call, so they must never
            // resolve — let alone require — a route or its credential.
            // Resolving eagerly here made an unresolvable/ signed-out model
            // selection fail EVERY Recall, including pure lookups.
            let recallRoutePromise:
              | ReturnType<typeof resolveRunnerRecallLlmRoute>
              | undefined;
            const resolveRecallRoute = (): ReturnType<
              typeof resolveRunnerRecallLlmRoute
            > =>
              (recallRoutePromise ??= resolveRunnerRecallLlmRoute(
                context,
                AGENT_IDS.ORCHESTRATOR,
                payload.modelConfigSnapshot,
              ));
            const sourceTimings: NonNullable<
              RecallTelemetrySeed["sourceTimings"]
            > = {};
            const intent = routeRecallIntent(payload.prompt);
            const needsHostContext = intent === "live_context";
            const hostContextStartedAt = performance.now();
            const localEventsStartedAt = performance.now();
            const localEvents =
              needsHostContext && context.listLocalChatEvents
                ? context
                    .listLocalChatEvents(payload.conversationId, 5)
                    .filter((event) =>
                      LOCAL_CONTEXT_EVENT_TYPES.has(event.type),
                    )
                : [];
            sourceTimings["host.localEvents"] = {
              kind: "sql",
              calls: needsHostContext && context.listLocalChatEvents ? 1 : 0,
              ms: performance.now() - localEventsStartedAt,
              chars: 0,
            };
            const appBrowserStartedAt = performance.now();
            const appBrowserContext =
              needsHostContext && getAppBrowserContext
                ? await getAppBrowserContext()
                : undefined;
            sourceTimings["host.appBrowserContext"] = {
              kind: "host",
              calls: needsHostContext && getAppBrowserContext ? 1 : 0,
              ms: performance.now() - appBrowserStartedAt,
              chars: appBrowserContext
                ? JSON.stringify(appBrowserContext).length
                : 0,
            };
            const hostContextMs = performance.now() - hostContextStartedAt;
            let resultMetadata:
              | Pick<RecallLookupResult, "intent" | "fastPath" | "sources">
              | undefined;
            const brief = await runRecall({
              conversationId: payload.conversationId,
              lookupPrompt: payload.prompt,
              ...(payload.memorySearchTerms?.length
                ? { memorySearchTerms: payload.memorySearchTerms }
                : {}),
              stellaAppDir,
              stellaDataDir,
              store: context.runtimeStore,
              localEvents,
              ...(appBrowserContext ? { appBrowserContext } : {}),
              resolveRecallRoute,
              ...(context.recallReadQueries
                ? { recallReadQueries: context.recallReadQueries }
                : {}),
              telemetry: {
                startedAtMs: recallStartedAtMs,
                // Route resolution is deferred to the synthesis fallback, so
                // it is folded into model timing rather than measured here.
                routeMs: 0,
                hostContextMs,
                sourceTimings,
              },
              onResultMetadata: (metadata) => {
                resultMetadata = metadata;
              },
              ...(payload.signal ? { signal: payload.signal } : {}),
            });
            return {
              status: isRecallNoMatchBrief(brief)
                ? "no_match"
                : brief.startsWith("Recall failed:")
                  ? "synthesis_error"
                  : "found",
              brief,
              ...resultMetadata,
            };
          } catch (error) {
            return {
              status:
                error instanceof RecallRetrievalError
                  ? "retrieval_error"
                  : "synthesis_error",
              brief: `Recall failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            };
          }
        },
      );
    },
    ...(runtimeStore?.dreamInboxStore
      ? { dreamInboxStore: runtimeStore.dreamInboxStore }
      : {}),
    agentApi: {
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
    },
  });

  Object.assign(context, {
    convexApi: anyApi,
    deviceId,
    stellaAppDir,
    stellaDataDir,
    stellaBrowserBinPath,
    stellaOfficeBinPath,
    stellaComputerCliPath,
    requestCredential,
    requestRuntimeAuthRefresh,
    scheduleApi,

    fashionApi: resolvedFashionApi,
    runtimeStore,
    listLocalChatEvents,
    recallReadQueries,
    appendLocalChatEvent,
    notifyThreadActivityUpdated,
    getDefaultConversationId,
    paths: {
      extensionsPath: resolveRuntimeSourceAsset("extensions"),
    },
    state: {
      convexSiteUrl: envProxyBaseUrl,
      authToken: envAuthToken,
      convexDeploymentUrl: envConvexDeploymentUrl,
      convexClient: null,
      convexClientUrl: null,
      hasConnectedAccount: false,
      cloudSyncEnabled: false,
      modelCatalogUpdatedAt: null,
      isRunning: false,
      isInitialized: false,
      initializationPromise: null,
      localAgentManager: null,
      backgroundExitWake: null,
      activeOrchestratorRunId: null,
      activeOrchestratorConversationId: null,
      activeOrchestratorUiVisibility: "visible",
      activeOrchestratorSession: null,
      orchestratorSessions: new Map(),
      compactionScheduler: new BackgroundCompactionScheduler(),
      queuedOrchestratorTurns: [],
      pendingFollowUpReplies: new Map(),
      activeRunAbortControllers: new Map(),
      conversationCallbacks: new Map(),
      runCallbacksByRunId: new Map(),
      loadedAgents: [],
      webSearch: null,
    },
    hookEmitter,
    toolHost,
  });

  // Needs both halves: the tool host owns the shell sessions, the agent
  // manager owns the threads a wake resumes. Both are reachable now, so the
  // wake is wired here rather than deferred to initialization.
  context.state.backgroundExitWake = createBackgroundExitWake({
    watchShellExit: toolHost.watchShellExit,
    readShellExitSnapshot: toolHost.readShellExitSnapshot,
    getThreadStatus: async (agentId) =>
      (await context.state.localAgentManager?.getAgent(agentId))?.status,
    writeExitLog: async (sessionId, contents) =>
      await writeBackgroundExitLog(stellaDataDir, sessionId, contents),
    deliver: async ({ conversationId, agentId, text }) => {
      const manager = context.state.localAgentManager;
      if (!manager) return false;
      // Same door as `send_input`: rehydrates an evicted or finished thread
      // with its own history instead of starting a stranger.
      const result = await manager.sendAgentMessage(
        agentId,
        text,
        "orchestrator",
        {
          deliveryKind: "external-input",
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

export const ORCHESTRATED_ORCHESTRATOR_ID = "orchestrator-orchestrated";

export const resolveAgentForWorkingMode = (
  loadedAgents: ParsedAgentLike[],
  agentType: string,
  workingMode: AssistantWorkingMode,
): ParsedAgentLike | undefined => {
  if (agentType === AGENT_IDS.ORCHESTRATOR) {
    const orchestratorId =
      workingMode === "orchestrated"
        ? ORCHESTRATED_ORCHESTRATOR_ID
        : AGENT_IDS.ORCHESTRATOR;
    const selectedOrchestrator = loadedAgents.find(
      (entry) => entry.id === orchestratorId,
    );
    if (selectedOrchestrator) {
      return selectedOrchestrator;
    }
  }

  return (
    loadedAgents.find((entry) => entry.agentTypes.includes(agentType)) ??
    loadedAgents.find((entry) => entry.id === agentType)
  );
};

export const resolveAgent = (
  context: RunnerContext,
  agentType: string,
): ParsedAgentLike | undefined =>
  resolveAgentForWorkingMode(
    context.state.loadedAgents,
    agentType,
    getAssistantWorkingMode(context.stellaDataDir),
  ) ?? getBundledCoreAgentFallback(agentType);

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

const normalizeCapturedReasoningEffort = (
  value: string | undefined,
): AgentModelReasoningEffort | undefined => {
  if (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return undefined;
};

const exactRouteModelReference = (
  resolvedLlm: ResolvedLlmRoute,
  configuredModel: string | undefined,
): string => {
  if (resolvedLlm.route === "stella") {
    const upstreamModel = (
      resolvedLlm.model as ResolvedLlmRoute["model"] & {
        upstreamModelId?: string;
      }
    ).upstreamModelId;
    const resolvedModel =
      resolvedLlm.toolPolicyModel?.id.trim() ||
      upstreamModel?.trim() ||
      resolvedLlm.model.id.trim();
    return `stella/${resolvedModel}`;
  }
  if (configuredModel?.trim()) return configuredModel.trim();
  const id = resolvedLlm.model.id.trim();
  return id.includes("/") ? id : `${resolvedLlm.model.provider}/${id}`;
};

export const captureEffectiveModelConfig = (args: {
  stellaDataDir: string;
  engine: AgentRuntimeEngine;
  subscriptionHarnessEnabled?: boolean;
  configuredModel?: string;
  engineModelOverride?: string;
  serviceTierOverride?: CodexServiceTier;
  /** Engine preferences, including an intentional absent effort, were frozen. */
  engineConfigSampled?: boolean;
  resolvedLlm: ResolvedLlmRoute;
  reasoningEffort?: string;
}): AgentModelConfigSnapshot => {
  if (args.engine === "codex_cli") {
    const codex = getCodexRuntimePreferences(
      args.stellaDataDir,
      args.configuredModel,
      args.engineModelOverride,
    );
    const codexModel =
      args.subscriptionHarnessEnabled &&
      args.resolvedLlm.model.provider === "openai-codex"
        ? args.resolvedLlm.model.id
        : codex.model;
    const routeModel = args.subscriptionHarnessEnabled
      ? `openai-codex/${codexModel}`
      : exactRouteModelReference(args.resolvedLlm, args.configuredModel);
    const effort =
      normalizeCapturedReasoningEffort(args.reasoningEffort) ??
      (args.engineConfigSampled
        ? undefined
        : normalizeCapturedReasoningEffort(codex.reasoningEffort));
    return {
      engine: args.engine,
      subscriptionHarnessEnabled: args.subscriptionHarnessEnabled === true,
      routeModel,
      engineModel: codexModel,
      ...(effort ? { reasoningEffort: effort } : {}),
      serviceTier: args.serviceTierOverride ?? codex.serviceTier,
    };
  }
  const routeModel = exactRouteModelReference(
    args.resolvedLlm,
    args.configuredModel,
  );
  if (args.engine === "claude_code_local") {
    const model = getClaudeCodeAgentModelId(
      args.stellaDataDir,
      args.configuredModel,
      AGENT_IDS.ORCHESTRATOR,
      args.engineModelOverride,
    ).replace(/^claude-code\//, "");
    const effort =
      normalizeCapturedReasoningEffort(args.reasoningEffort) ??
      (args.engineConfigSampled
        ? undefined
        : normalizeCapturedReasoningEffort(
            getClaudeCodeRuntimeEffortLevel(args.stellaDataDir),
          ));
    return {
      engine: args.engine,
      subscriptionHarnessEnabled: args.subscriptionHarnessEnabled === true,
      routeModel,
      engineModel: model,
      ...(effort ? { reasoningEffort: effort } : {}),
    };
  }
  const effort = normalizeCapturedReasoningEffort(args.reasoningEffort);
  return {
    engine: args.engine,
    routeModel,
    ...(effort ? { reasoningEffort: effort } : {}),
  };
};

export const resolveAgentEngineForRun = (
  configuredEngine: AgentRuntimeEngine,
  spawnEngine?: SpawnEngineSelection,
): AgentRuntimeEngine => spawnEngine?.engine ?? configuredEngine;

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
    const codex = getCodexRuntimePreferences(
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
    return args.modelConfigSnapshot.subscriptionHarnessEnabled === true
      ? args.modelConfigSnapshot.routeModel
      : undefined;
  }
  if (!args.subscriptionHarnessEnabled) return undefined;
  const codex = getCodexRuntimePreferences(
    args.stellaDataDir,
    args.configuredModel,
    args.spawnEngine?.engine === "codex_cli"
      ? args.spawnEngine.model
      : undefined,
  );
  return `openai-codex/${codex.model}`;
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
    const localEvents = context
      .listLocalChatEvents(args.conversationId, 800)
      .filter((event) => LOCAL_CONTEXT_EVENT_TYPES.has(event.type));
    staleUserReminderText = buildStaleUserReminder(localEvents);
    connectorTransitionReminderText =
      buildConnectorTransitionReminder(localEvents);
    userLocale = findLatestLocale(localEvents);
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
  const dynamicContextSections: string[] = [];

  // Inject the user's response-language directive at the top of the
  // dynamic context. It's a single line, comes from the latest
  // `user_message` event's `locale` payload, and is `undefined` for
  // English so we don't waste tokens on a no-op directive.
  const responseLanguageDirective = getResponseLanguageSystemPrompt(userLocale);
  if (responseLanguageDirective) {
    dynamicContextSections.push(
      `## User Language\n${responseLanguageDirective}`,
    );
  }

  if (args.toolWorkspaceRoot?.trim()) {
    dynamicContextSections.push(
      [
        "## Shared Session Workspace",
        `Workspace root: ${args.toolWorkspaceRoot.trim()}`,
        "Use relative paths unless an absolute path under this workspace is already shown by a tool.",
        "File tools are restricted to this workspace root.",
      ].join("\n"),
    );
  }
  const reminderState =
    injectsRuntimeReminders && activeThreadsPrompt
      ? context.runtimeStore.getOrchestratorReminderState(args.conversationId)
      : {
          shouldInjectDynamicReminder: false,
          reminderTokensSinceLastInjection: 0,
        };
  // A per-spawn engine selection wins over the preference-configured engine
  // for this run only; saved preferences are never touched.
  const configuredAgentEngine =
    args.configuredAgentEngine ?? getAgentRuntimeEngine(context.stellaDataDir);
  const agentEngine =
    args.modelConfigSnapshot?.engine ??
    resolveAgentEngineForRun(configuredAgentEngine, args.spawnEngine);
  // Persisted snapshots are authoritative. An absent mode field is the
  // backward-compatible native meaning for legacy external-engine runs.
  const subscriptionHarnessEnabled = args.modelConfigSnapshot
    ? args.modelConfigSnapshot.subscriptionHarnessEnabled === true
    : (args.subscriptionHarnessEnabled ??
      getSubscriptionHarnessEnabled(context.stellaDataDir, agentEngine));
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
          resolvedLlm.model,
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
        model: resolvedLlm.model.id,
        reason: "resolved model has no reasoning dial",
      });
    } else if (effectiveReasoningEffort !== spawnReasoningEffort) {
      console.debug("[stella:spawn-reasoning] effort clamped", {
        requested: spawnReasoningEffort,
        effective: effectiveReasoningEffort,
        model: resolvedLlm.model.id,
      });
    }
  }

  const fileEditToolFamily = getFileEditToolFamily({
    agentType: args.agentType,
    model: resolvedLlm.toolPolicyModel ?? resolvedLlm.model,
    agentEngine,
  });
  const toolsAllowlist = rewriteFileEditToolNames(
    agent?.toolsAllowlist,
    fileEditToolFamily,
  );
  if (fileEditToolFamily === "write_edit") {
    dynamicContextSections.push(
      [
        "## File Editing Tools",
        "This run is using a non-OpenAI model. Use `Write` for new or full-file edits and `Edit` for targeted replacements.",
        "`apply_patch` is not available in this run.",
      ].join("\n"),
    );
  } else if (toolsAllowlist?.includes(APPLY_PATCH_TOOL_NAME)) {
    dynamicContextSections.push(
      [
        "## File Editing Tools",
        "Use `apply_patch` for manual code edits. Do not create or edit files with `cat` or other shell write tricks. Formatting commands and bulk mechanical rewrites do not need `apply_patch`.",
        "Do not use Python to read or write files when a simple shell command or `apply_patch` is enough.",
      ].join("\n"),
    );
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
  const injectsResidentMemory = agentHasCapability(
    args.agentType,
    "injectsResidentMemory",
  );
  const injectsPersonality = agentHasCapability(
    args.agentType,
    "injectsPersonality",
  );
  if (injectsResidentMemory) {
    await ensureDreamMemoryLayout(context.stellaDataDir);
  }

  return {
    // Developer-mode gate runs at assembly: with the flag off, the fenced
    // engine-routing guidance in the shipped prompt is omitted from the
    // session context entirely (see prompt-dev-mode.ts).
    systemPrompt: applyDeveloperModePromptGate(
      bundledSystemPrompt ??
        agent?.systemPrompt ??
        defaultPromptForAgentType(args.agentType, context.stellaDataDir),
      getDeveloperModeEnabled(context.stellaDataDir),
    ),
    dynamicContext: dynamicContextSections.join("\n\n"),
    orchestratorReminderText: activeThreadsPrompt || undefined,
    shouldInjectDynamicReminder: reminderState.shouldInjectDynamicReminder,
    staleUserReminderText,
    connectorTransitionReminderText,
    toolsAllowlist,
    model,
    resolvedLlm,
    modelConfigSnapshot:
      args.modelConfigSnapshot ??
      captureEffectiveModelConfig({
        stellaDataDir: context.stellaDataDir,
        engine: agentEngine,
        subscriptionHarnessEnabled: capturedSubscriptionHarness,
        configuredModel: model,
        engineModelOverride:
          args.sampledEngineConfig?.engineModel ?? args.spawnEngine?.model,
        serviceTierOverride: args.sampledEngineConfig?.serviceTier,
        engineConfigSampled: Boolean(args.sampledEngineConfig),
        resolvedLlm,
        reasoningEffort: effectiveReasoningEffort,
      }),
    reasoningEffort: effectiveReasoningEffort,
    maxAgentDepth: agent?.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH,
    memoryEnabled,
    coreMemory:
      memoryEnabled && injectsCoreMemory
        ? readCoreMemory(context.stellaDataDir)
        : undefined,
    memoryMap:
      memoryEnabled && injectsResidentMemory
        ? readMemoryMapDoc(context.stellaDataDir)
        : undefined,
    userProfile:
      memoryEnabled && injectsResidentMemory
        ? readUserProfileDoc(context.stellaDataDir)
        : undefined,
    personality: injectsPersonality
      ? readOrSeedPersonality(context.stellaDataDir)
      : undefined,
    skillsCatalog,
    threadHistory: threadHistory.length > 0 ? threadHistory : undefined,
    activeThreadId: threadKey,
    agentEngine,
    ...(args.spawnEngine ? { spawnEngine: args.spawnEngine } : {}),
    ...(args.spawnReasoningEffort
      ? { spawnReasoningEffort: args.spawnReasoningEffort }
      : {}),
    maxAgentConcurrency: isLocalCliAgentId(args.agentType)
      ? getMaxAgentConcurrency(context.stellaDataDir)
      : undefined,
  };
};
