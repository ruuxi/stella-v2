import crypto from "crypto";
import {
  resolveLlmRoute,
  resolveLlmRouteForCatalogEnrichment,
} from "../model-routing.js";
import { withStellaModelCatalogMetadata } from "../stella-model-catalog.js";
import {
  getMaxAgentConcurrency,
  getModelOverride,
} from "../preferences/local-preferences.js";
import { runSubagentTask, shutdownSubagentRuntimes } from "../agent-runtime.js";
import { createAgentLifecycleResponseTarget } from "../agent-runtime/response-target.js";
import { persistThreadCustomMessage } from "../agent-runtime/thread-memory.js";
import { runExplore } from "../agent-runtime/explore.js";
import { resolveOrchestratorThreadKey } from "../thread-runtime.js";
import { shouldUseAutomaticSkillExplore } from "../shared/skill-catalog.js";
import { LocalAgentManager } from "../agents/local-agent-manager.js";
import type { AgentToolRequest } from "../tools/types.js";
import type {
  LocalAgentContext,
  AgentLifecycleEvent,
} from "../agents/local-agent-manager.js";
import { AGENT_IDS, isLocalCliAgentId } from "@stella/contracts/agent-runtime";
import type { RunnerContext } from "./types.js";
import { buildAgentEventPrompt } from "./shared.js";
import type { LocalChatEventRecord } from "../storage/shared.js";
import type { ThreadActivityRecord } from "@stella/contracts/local-chat";
import { createRunnerImageDescriptionService } from "./model-selection.js";

const findPersistedThreadCustomEvent = (
  context: RunnerContext,
  threadKey: string,
  eventId: string | undefined,
): { timestamp: number } | null => {
  if (!eventId) return null;
  const loadThreadMessages =
    context.runtimeStore.loadRawThreadMessages ??
    context.runtimeStore.loadThreadMessages;
  if (typeof loadThreadMessages !== "function") return null;
  return (
    loadThreadMessages.call(context.runtimeStore, threadKey).find((message) => {
      if (message.customMessage?.customType !== "runtime.task_lifecycle") {
        return false;
      }
      return message.customMessage.eventId === eventId;
    }) ?? null
  );
};

const hasPersistedThreadCustomEvent = (
  context: RunnerContext,
  threadKey: string,
  eventId: string | undefined,
): boolean =>
  findPersistedThreadCustomEvent(context, threadKey, eventId) !== null;

const buildLifecycleEventPayload = (
  event: AgentLifecycleEvent,
): Record<string, unknown> => {
  const runFields = event.rootRunId ? { rootRunId: event.rootRunId } : {};
  const groupFields = event.groupKey
    ? {
        groupKey: event.groupKey,
        ...(event.groupLabel ? { groupLabel: event.groupLabel } : {}),
      }
    : {};
  switch (event.type) {
    case "agent-started":
      return {
        agentId: event.agentId,
        ...runFields,
        description: event.description,
        agentType: event.agentType,
        ...(event.parentAgentId ? { parentAgentId: event.parentAgentId } : {}),
        ...(event.statusText ? { statusText: event.statusText } : {}),

        ...(event.isFollowUp ? { isFollowUp: true } : {}),
        ...groupFields,
      };
    case "agent-completed":

      return {
        agentId: event.agentId,
        ...runFields,
        result: event.result ?? "",
        ...groupFields,
      };
    case "agent-message":
      return {
        agentId: event.agentId,
        ...runFields,
        result: event.result ?? "",
        ...(event.description ? { description: event.description } : {}),
      };
    case "agent-failed":
    case "agent-canceled":
      return {
        agentId: event.agentId,
        ...runFields,
        ...(event.error ? { error: event.error } : {}),
        ...groupFields,
      };
    case "agent-progress":
      return {
        agentId: event.agentId,
        ...runFields,
        statusText: event.statusText,
        ...(event.toolActivity ? { toolActivity: event.toolActivity } : {}),
        ...(event.description ? { description: event.description } : {}),
        ...(event.parentAgentId ? { parentAgentId: event.parentAgentId } : {}),
        ...groupFields,
      };
  }
};

const appendAgentLifecycleChatEvent = (
  context: RunnerContext,
  event: AgentLifecycleEvent,
) => {
  if (!context.appendLocalChatEvent) {
    return;
  }
  context.appendLocalChatEvent({
    conversationId: event.conversationId,
    type: event.type,
    payload: buildLifecycleEventPayload(event),
  });
};

const buildThreadLifecycleEvent = (
  event: AgentLifecycleEvent,
  timestamp: number,
): LocalChatEventRecord => {
  const derivedId = `${event.agentId}:${
    event.attemptGeneration ?? timestamp
  }:${event.type}`;
  return {
    _id:
      event.eventId?.trim() ||
      (event.type === "agent-progress"
        ? `${derivedId}:${timestamp}`
        : derivedId),
    timestamp,
    type: event.type,
    payload: buildLifecycleEventPayload(event),
  };
};

export const createAgentOrchestration = (
  context: RunnerContext,
  deps: {
    buildAgentContext: (args: {
      conversationId: string;
      agentType: string;
      runId: string;
      threadId?: string;

      model?: string;

      spawnEngine?: AgentToolRequest["spawnEngine"];

      spawnReasoningEffort?: AgentToolRequest["spawnReasoningEffort"];
    }) => Promise<LocalAgentContext>;
    sendMessage: (input: {
      conversationId: string;
      text: string;
      uiVisibility?: "visible" | "hidden";
      agentType?: string;
      deliverAs?: "steer" | "followUp";
      callbackRunId?: string;
      responseTarget?: import("@stella/contracts/protocol").RuntimeAgentEventPayload["responseTarget"];
      customType?: string;
      eventId?: string;
      display?: boolean;
      timestamp?: number;
    }) => Promise<void>;

    attemptTeardownTimeoutMs?: number;
  },
) => {
  const inFlightLifecycleEventIds = new Set<string>();
  const handleAgentLifecycleEvent = async (event) => {
    const installedManager = context.state.localAgentManager;
    const parentOwner = installedManager
      ? installedManager.resolveOwningParentThread(
          event.agentId,
          event.parentAgentId,
        )
      : event.parentAgentId;
    const parentThreadId =
      typeof parentOwner === "string" ? parentOwner : undefined;
    const isParentOwned = parentThreadId !== undefined;
    const hasUnresolvedParentAncestry = parentOwner === null;

    if (
      event.audience !== "orchestrator-only" &&
      !isParentOwned &&
      !hasUnresolvedParentAncestry
    ) {

      if (event.type !== "agent-progress") {
        appendAgentLifecycleChatEvent(context, event);
      }
      if (event.rootRunId) {
        context.state.runCallbacksByRunId
          .get(event.rootRunId)
          ?.onAgentEvent?.(event);
      }
    }
    if (parentThreadId && event.audience !== "orchestrator-only") {

      const lifecycleEvent = buildThreadLifecycleEvent(event, Date.now());
      if (
        !context.runtimeStore.hasThreadLifecycleEvent(
          parentThreadId,
          lifecycleEvent._id,
        )
      ) {
        context.runtimeStore.appendThreadLifecycleEvent({
          threadKey: parentThreadId,
          event: lifecycleEvent,
        });
      }
    }
    if (event.audience === "display-only") {
      return;
    }

    if (hasUnresolvedParentAncestry) return;
    const userPrompt = buildAgentEventPrompt(event, {
      recipient: isParentOwned ? "parent_agent" : "orchestrator",
    });
    if (!userPrompt) {
      return;
    }
    const deliveryEventId = event.eventId?.trim();
    if (deliveryEventId) {
      if (inFlightLifecycleEventIds.has(deliveryEventId)) return;
      inFlightLifecycleEventIds.add(deliveryEventId);
    }
    if (parentThreadId) {
      try {
        if (
          hasPersistedThreadCustomEvent(context, parentThreadId, event.eventId)
        ) {
          return;
        }
        persistThreadCustomMessage(context.runtimeStore, {
          threadKey: parentThreadId,
          customType: "runtime.task_lifecycle",
          content: [{ type: "text", text: userPrompt }],
          display: false,
          timestamp: Date.now(),
          ...(deliveryEventId ? { eventId: deliveryEventId } : {}),
        });
        await context.state.localAgentManager?.sendAgentMessage(
          parentThreadId,
          userPrompt,
          "orchestrator",
          {
            deliveryKind: "child-report",
            ...(deliveryEventId ? { deliveryEventId } : {}),
          },
        );
      } finally {
        if (deliveryEventId) inFlightLifecycleEventIds.delete(deliveryEventId);
      }
      return;
    }
    const orchestratorThreadKey = resolveOrchestratorThreadKey(
      event.conversationId,
    );
    try {
      if (
        hasPersistedThreadCustomEvent(
          context,
          orchestratorThreadKey,
          event.eventId,
        )
      ) {
        return;
      }
      await deps.sendMessage({
        conversationId: event.conversationId,
        text: userPrompt,
        uiVisibility: "hidden",
        agentType: AGENT_IDS.ORCHESTRATOR,
        deliverAs: "steer",
        callbackRunId: event.rootRunId,
        customType: "runtime.task_lifecycle",
        ...(deliveryEventId ? { eventId: deliveryEventId } : {}),
        display: false,
        responseTarget: createAgentLifecycleResponseTarget({
          agentId: event.agentId,
          eventType: event.type,
          ...(event.type === "agent-completed" && event.eventId
            ? { completionEventId: event.eventId }
            : {}),
        }),
      });
    } finally {
      if (deliveryEventId) inFlightLifecycleEventIds.delete(deliveryEventId);
    }
    if (event.type === "agent-completed" && event.result?.trim()) {
      try {
        const summaries = context.runtimeStore.threadSummaryStore;
        if (
          summaries &&
          typeof summaries.promoteThreadSummaryConversation === "function"
        ) {
          summaries.promoteThreadSummaryConversation({
            threadId: event.agentId,
            conversationId: event.conversationId,
            rolloutSummary: event.result,
          });
        }
      } catch {
      }
    }
  };
  context.state.localAgentManager = new LocalAgentManager({
    maxConcurrent: 24,
    ...(deps.attemptTeardownTimeoutMs !== undefined
      ? { attemptTeardownTimeoutMs: deps.attemptTeardownTimeoutMs }
      : {}),
    getMaxConcurrent: () => getMaxAgentConcurrency(context.stellaDataDir),
    resolveTaskThread: ({ conversationId, agentType, threadId, nameHint }) => {
      if (!isLocalCliAgentId(agentType)) {
        return null;
      }
      return context.runtimeStore.resolveOrCreateActiveThread({
        conversationId,
        agentType,
        threadId,
        ...(nameHint ? { nameHint } : {}),
      });
    },
    listActiveThreads: (conversationId) =>
      context.runtimeStore.listActiveThreads(conversationId),
    onAgentEvent: (event) => {
      void handleAgentLifecycleEvent(event).catch(() => undefined);
    },
    fetchAgentContext: deps.buildAgentContext,
    runSubagent: async ({
      conversationId,
      userMessageId,
      agentType,
      agentId,
      rootRunId,
      toolWorkspaceRoot,
      agentContext,
      taskDescription,
      taskPrompt,
      abortSignal,
      subagentSession,
      onProgress,
      onToolStart,
      onToolEnd,
      toolExecutor,
    }) => {
      const runId = `local:sub:${crypto.randomUUID()}`;
      const site = {
        baseUrl: context.state.convexSiteUrl,
        getAuthToken: () => context.state.authToken?.trim(),
        hasConnectedAccount: () => context.state.hasConnectedAccount,
        refreshAuthToken: async () => {
          const result = await context.requestRuntimeAuthRefresh?.({
            source: "stella_provider",
          });
          return result?.authenticated ? result.token : null;
        },
      };
      const resolvedLlm =
        agentContext.resolvedLlm ??
        (await withStellaModelCatalogMetadata({
          route: resolveLlmRouteForCatalogEnrichment({

            stellaAppDir: context.stellaDataDir,
            modelName: agentContext.model,
            agentType,
            site,
          }),
          agentType,
          site,
          deviceId: context.deviceId,
          modelCatalogUpdatedAt: context.state.modelCatalogUpdatedAt,
          stellaDataDir: context.stellaDataDir,
          ...(context.cliBridgeSocketPath
            ? { cliBridgeSocketPath: context.cliBridgeSocketPath }
            : {}),
        }));
      const runnerCallbacks =
        (rootRunId ? context.state.runCallbacksByRunId.get(rootRunId) : null) ??
        context.state.conversationCallbacks.get(conversationId) ??
        null;

      let exploreFindingsBlock = "";
      if (
        agentType === AGENT_IDS.GENERAL &&
        (await shouldUseAutomaticSkillExplore(context.stellaDataDir))
      ) {
        exploreFindingsBlock = await runExplore({
          context,
          conversationId,
          taskDescription,
          taskPrompt,
          signal: abortSignal,
        });
      }

      const composedUserPrompt = exploreFindingsBlock
        ? `${exploreFindingsBlock}\n\n${taskDescription}\n\n${taskPrompt}`
        : `${taskDescription}\n\n${taskPrompt}`;

      const result = await runSubagentTask({
        conversationId,
        userMessageId,
        runId,
        agentId,
        rootRunId,
        agentType,
        userPrompt: composedUserPrompt,
        agentContext,
        toolCatalog: context.toolHost.getToolCatalog(agentType, {
          model: resolvedLlm.toolPolicyModel ?? resolvedLlm.model,
          agentEngine: agentContext.agentEngine,
        }),
        toolExecutor,
        deviceId: context.deviceId,
        stellaDataDir: context.stellaDataDir,
        resolvedLlm,
        describeImages: createRunnerImageDescriptionService(
          context,
          resolvedLlm,
        ),
        store: context.runtimeStore,
        abortSignal,
        stellaAppDir: context.stellaAppDir,
        ...(toolWorkspaceRoot ? { toolWorkspaceRoot } : {}),
        ...(subagentSession ? { subagentSession } : {}),
        compactionScheduler: context.state.compactionScheduler,
        onProgress,
        ...(context.appendLocalChatEvent
          ? { appendLocalChatEvent: context.appendLocalChatEvent }
          : {}),
        ...(context.listLocalChatEvents
          ? { listLocalChatEvents: context.listLocalChatEvents }
          : {}),
        resolveSubsidiaryLlmRoute: (subsidiaryAgentType: string) =>
          resolveLlmRoute({
            stellaAppDir: context.stellaDataDir,

            modelName: getModelOverride(
              context.stellaDataDir,
              subsidiaryAgentType,
            ),
            agentType: subsidiaryAgentType,
            site: {
              baseUrl: context.state.convexSiteUrl,
              getAuthToken: () => context.state.authToken?.trim(),
              hasConnectedAccount: () => context.state.hasConnectedAccount,
              refreshAuthToken: async () => {
                const result = await context.requestRuntimeAuthRefresh?.({
                  source: "stella_provider",
                });
                return result?.authenticated ? result.token : null;
              },
            },
          }),
        callbacks: {
          ...(runnerCallbacks
            ? {
                onReasoning: (event) => {
                  if (!agentId) {
                    return;
                  }
                  runnerCallbacks.onAgentReasoning?.({
                    ...event,
                    agentId,
                    ...(rootRunId ? { rootRunId } : {}),
                    ...(taskDescription
                      ? { description: taskDescription }
                      : {}),
                  });
                },
                onError: (event) => runnerCallbacks.onError(event),
                onInterrupted: (event) =>
                  runnerCallbacks.onInterrupted?.(event),
                onEnd: (event) => runnerCallbacks.onEnd(event),
              }
            : {}),
          onToolStart: (event) => {
            onToolStart?.(event);
            runnerCallbacks?.onToolStart(event);
          },
          onToolEnd: (event) => {
            onToolEnd?.(event);
            runnerCallbacks?.onToolEnd(agentId ? { ...event, agentId } : event);
          },
        },
        hookEmitter: context.hookEmitter,
      }).finally(() => context.toolHost.endBrowserTurn(runId, "close-tabs"));

      return result;
    },
    toolExecutor: (toolName, args, toolContext, signal, onUpdate) =>
      context.toolHost.executeTool(
        toolName,
        args,
        toolContext,
        signal,
        onUpdate,
      ),
    saveAgentRecord: (record) => {
      const recordRevision = context.runtimeStore.saveAgentRecord?.(record);
      if (recordRevision === null) return;
      const threadMetadata =
        context.runtimeStore.getThreadActivityMetadata?.(record.threadId);
      const activityRecord: ThreadActivityRecord = {
        source: "stella",
        threadId: record.threadId,
        conversationId: record.conversationId,
        agentType: record.agentType,
        description: record.description,
        status: record.status,
        attemptGeneration: record.attemptGeneration ?? 0,
        ...(typeof recordRevision === "number" ? { recordRevision } : {}),
        ...(record.rootRunId ? { rootRunId: record.rootRunId } : {}),
        ...(record.parentAgentId
          ? { parentAgentId: record.parentAgentId }
          : {}),
        ...(record.modelConfigSnapshot
          ? { modelConfigSnapshot: record.modelConfigSnapshot }
          : {}),
        ...(threadMetadata ?? {}),
        startedAt: record.startedAt,
        ...(record.completedAt == null
          ? {}
          : { completedAt: record.completedAt }),
        ...(record.result ? { result: record.result.slice(0, 2_000) } : {}),
        ...(record.error ? { error: record.error.slice(0, 2_000) } : {}),
        updatedAt: record.updatedAt,
      };
      context.notifyThreadActivityUpdated?.({
        conversationId: record.conversationId,
        record: activityRecord,
      });
    },
    getAgentRecord: (threadId) =>
      context.runtimeStore.getAgentRecord?.(threadId) ?? null,
    listAgentRecordsByStatus: (status) =>
      context.runtimeStore.listAgentRecordsByStatus?.(status) ?? [],
  });

  const runBlockingLocalAgent = async (
    request: Omit<AgentToolRequest, "storageMode">,
  ): Promise<
    | { status: "ok"; finalText: string; threadId: string }
    | { status: "error"; finalText: ""; error: string; threadId?: string }
  > => {
    if (!context.state.localAgentManager) {
      return {
        status: "error",
        finalText: "",
        error: "Local agent manager is unavailable.",
      };
    }
    const { threadId } = await context.state.localAgentManager.createAgent({
      ...request,
      storageMode: "local",
    });
    while (true) {
      const snapshot = await context.state.localAgentManager.getAgent(threadId);
      if (!snapshot) {
        return {
          status: "error",
          finalText: "",
          error: "Agent record disappeared before completion.",
          threadId,
        };
      }
      if (snapshot.status === "completed") {
        return {
          status: "ok",
          finalText: snapshot.result ?? "",
          threadId,
        };
      }
      if (snapshot.status === "error" || snapshot.status === "canceled") {
        return {
          status: "error",
          finalText: "",
          error: snapshot.error ?? "Agent run failed",
          threadId,
        };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  };

  const createBackgroundAgent = async (
    request: Omit<AgentToolRequest, "storageMode">,
  ): Promise<{ threadId: string }> => {
    if (!context.state.localAgentManager) {
      throw new Error("Local agent manager is unavailable.");
    }
    const { threadId } = await context.state.localAgentManager.createAgent({
      ...request,
      storageMode: "local",
    });
    return { threadId };
  };

  const cancelLocalAgent = async (
    agentId: string,
    reason?: string,
  ): Promise<{ canceled: boolean }> => {
    if (!context.state.localAgentManager) {
      return { canceled: false };
    }
    return await context.state.localAgentManager.cancelAgent(agentId, reason);
  };

  const shutdown = () => {
    context.state.localAgentManager?.shutdown();
    shutdownSubagentRuntimes();
  };

  return {
    runBlockingLocalAgent,
    createBackgroundAgent,
    cancelLocalAgent,
    shutdown,
  };
};
