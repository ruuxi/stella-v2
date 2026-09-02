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
import { writeRestartInterruptedSnapshot } from "../restart-continuation.js";
import type {
  AgentToolRequest,
  ToolContext,
  ToolResult,
} from "../tools/types.js";
import type {
  LocalAgentContext,
  AgentLifecycleEvent,
} from "../agents/local-agent-manager.js";
import { AGENT_IDS, isLocalCliAgentId } from "@stella/contracts/agent-runtime";
import type { RunnerContext } from "./types.js";
import { buildAgentEventPrompt } from "./shared.js";
import type { LocalChatEventRecord } from "../storage/shared.js";
import type { ThreadActivityRecord } from "@stella/contracts/local-chat";
import {
  createRunnerImageDescriptionService,
  createRunnerSiteConfig,
} from "./model-selection.js";
import { RUNTIME_PRIVATE_TASK_LIFECYCLE_CUSTOM_TYPE } from "../storage/shared.js";
import type { ComputerAgentCloudRecords } from "./computer-agent-cloud-records.js";
import {
  getPlacementCancellation,
  persistPlacementCancellation,
} from "./execution-placement-local-ownership.js";

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

// stella-cloud-side callers use the shorter name for the same check.
const hasPersistedThreadEvent = hasPersistedThreadCustomEvent;

const resolveLifecycleParentOwner = (
  context: RunnerContext,
  event: AgentLifecycleEvent,
): string | null | undefined => {
  const installedManager = context.state.localAgentManager;
  return installedManager
    ? installedManager.resolveOwningParentThread(
        event.agentId,
        event.parentAgentId,
      )
    : event.parentAgentId;
};

export const hasDurableAgentLifecycleEvent = (
  context: RunnerContext,
  event: AgentLifecycleEvent,
): boolean => {
  const eventId = event.eventId?.trim();
  if (!eventId) return false;
  const parentOwner = resolveLifecycleParentOwner(context, event);
  if (parentOwner === null) return false;
  if (typeof parentOwner === "string") {
    const parent = context.runtimeStore.getAgentRecord?.(parentOwner);
    const wakeAccepted =
      parent?.descendantBoundaryState?.consumedEventIds.includes(eventId) ===
      true;
    return (
      wakeAccepted && hasPersistedThreadEvent(context, parentOwner, eventId)
    );
  }
  const orchestratorThreadKey = resolveOrchestratorThreadKey(
    event.conversationId,
  );
  if (event.audience === "orchestrator-only") {
    return hasPersistedThreadEvent(context, orchestratorThreadKey, eventId);
  }
  return (
    context.runtimeStore.hasEvent(event.conversationId, eventId, event.type) &&
    hasPersistedThreadEvent(context, orchestratorThreadKey, eventId)
  );
};

/**
 * Keep automatic background-shell wakes aligned with the manager's actual
 * attempt lifecycle. A start means the thread can poll its own leftovers;
 * a true terminal event means it is safe to sleep on any owned sessions.
 */
const reconcileBackgroundExitWake = (
  context: RunnerContext,
  event: AgentLifecycleEvent,
): void => {
  const wake = context.state.backgroundExitWake;
  if (!wake) return;
  const identity = {
    conversationId: event.conversationId,
    agentId: event.agentId,
  };
  try {
    if (event.type === "agent-started") {
      // Invalidate pending timers and a flush that may currently be awaiting
      // status/log I/O; a live attempt must never receive its predecessor's
      // stale wake.
      wake.disarm(identity);
      return;
    }
    if (event.type === "agent-canceled") {
      // User/runtime interruption is authoritative. Calling arm with the
      // interruption marker also replaces any prior arm for this owner.
      wake.arm({
        ...identity,
        runningSessionIds: [],
        interrupted: true,
      });
      return;
    }
    if (event.type !== "agent-completed" && event.type !== "agent-failed") {
      return;
    }
    if (!context.state.isRunning) {
      wake.disarm(identity);
      return;
    }
    // The complete authorization key finds work deliberately left running by
    // an older turn without trusting raw session ids from model-visible data.
    const runningSessionIds =
      context.toolHost.listRunningShellSessionsOwnedBy(identity);
    wake.arm({
      ...identity,
      runningSessionIds,
      interrupted: false,
    });
  } catch (error) {
    // Best-effort wake bookkeeping must never change the attempt's terminal
    // result or block the ordinary lifecycle handler below.
    console.warn(
      `[background-wake] failed to reconcile ${event.type} for ${event.agentId}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
};

const buildLifecycleEventPayload = (
  event: AgentLifecycleEvent,
): Record<string, unknown> => {
  const runFields = event.rootRunId ? { rootRunId: event.rootRunId } : {};
  const attemptFields =
    typeof event.attemptGeneration === "number"
      ? { attemptGeneration: event.attemptGeneration }
      : {};
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
        ...attemptFields,
        description: event.description,
        agentType: event.agentType,
        ...(event.parentAgentId ? { parentAgentId: event.parentAgentId } : {}),
        ...(event.statusText ? { statusText: event.statusText } : {}),
        // Persist the spawn-vs-follow-up discriminator so the inline
        // background-work card can pick its follow-up variant on reload.
        ...(event.isFollowUp ? { isFollowUp: true } : {}),
        ...groupFields,
      };
    case "agent-completed":
      // `result` is always persisted (even if empty) so the
      // orchestrator's hidden `[Agent completed]` reminder always
      // carries a `result:` line. `finalizeSubagentSuccess`
      // substitutes a sentinel for empty/whitespace outputs upstream;
      // this guard catches any other emitter that forgets.
      return {
        agentId: event.agentId,
        ...runFields,
        ...attemptFields,
        result: event.result ?? "",
        ...groupFields,
      };
    case "agent-message":
      return {
        agentId: event.agentId,
        ...runFields,
        ...attemptFields,
        result: event.result ?? "",
        ...(event.description ? { description: event.description } : {}),
      };
    case "agent-failed":
    case "agent-canceled":
      return {
        agentId: event.agentId,
        ...runFields,
        ...attemptFields,
        ...(event.error ? { error: event.error } : {}),
        ...groupFields,
      };
    case "agent-progress":
      return {
        agentId: event.agentId,
        ...runFields,
        ...attemptFields,
        statusText: event.statusText,
        ...(event.toolActivity ? { toolActivity: event.toolActivity } : {}),
        ...(event.description ? { description: event.description } : {}),
        ...(event.parentAgentId ? { parentAgentId: event.parentAgentId } : {}),
        ...groupFields,
      };
  }
  return {};
};

export const appendAgentLifecycleChatEvent = (
  context: RunnerContext,
  event: AgentLifecycleEvent,
) => {
  if (!context.appendLocalChatEvent) {
    return;
  }
  // runtime_agents remains the local operational ledger for both placements,
  // but a cloud-owned conversation's lifecycle transcript belongs only to the
  // canonical cloud journal/agent-thread rows.
  if (
    context.runtimeStore.getAgentRecord?.(event.agentId)?.storageMode ===
    "cloud"
  ) {
    return;
  }
  context.appendLocalChatEvent({
    conversationId: event.conversationId,
    type: event.type,
    payload: buildLifecycleEventPayload(event),
    ...(event.eventId ? { eventId: event.eventId } : {}),
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
      /** Per-spawn model override from spawn_agent's `model` parameter. */
      model?: string;
      /** Per-spawn engine selection from spawn_agent's `model` parameter. */
      spawnEngine?: AgentToolRequest["spawnEngine"];
      /** Per-spawn reasoning override from spawn_agent's model suffix. */
      spawnReasoningEffort?: AgentToolRequest["spawnReasoningEffort"];
    }) => Promise<LocalAgentContext>;
    resolveAgentModelConfig?: (args: {
      agentType: string;
      model?: string;
      spawnEngine?: AgentToolRequest["spawnEngine"];
      spawnReasoningEffort?: AgentToolRequest["spawnReasoningEffort"];
    }) => Promise<NonNullable<LocalAgentContext["modelConfigSnapshot"]>>;
    sendMessage: (input: {
      conversationId: string;
      text: string;
      uiVisibility?: "visible" | "hidden";
      agentType?: string;
      ownerGeneration?: string;
      deliverAs?: "steer" | "followUp";
      callbackRunId?: string;
      responseTarget?: import("@stella/contracts/protocol").RuntimeAgentEventPayload["responseTarget"];
      customType?: string;
      eventId?: string;
      display?: boolean;
      timestamp?: number;
    }) => Promise<void>;
    cloudAgentRecords?: ComputerAgentCloudRecords;
    /** Test/embedding override; production uses the manager's bounded default. */
    attemptTeardownTimeoutMs?: number;
  },
) => {
  const inFlightLifecycleEventIds = new Set<string>();
  const handleAgentLifecycleEvent = async (event: AgentLifecycleEvent) => {
    const installedManager = context.state.localAgentManager;
    const parentOwner = resolveLifecycleParentOwner(context, event);
    const parentThreadId =
      typeof parentOwner === "string" ? parentOwner : undefined;
    const isParentOwned = parentThreadId !== undefined;
    const hasUnresolvedParentAncestry = parentOwner === null;
    // Some lifecycle transitions are control-plane-only (see
    // `AgentLifecycleEvent.audience`): `orchestrator-only` skips every
    // display surface (persisted chat event, renderer/run callbacks,
    // OS notification). Interjection completions use it before their deferred
    // `display-only` replay; internal owner wake-ups use it so reviewing a
    // privately routed child report does not create a root-chat card.
    if (
      event.audience !== "orchestrator-only" &&
      !isParentOwned &&
      !hasUnresolvedParentAncestry
    ) {
      // Progress ticks are ephemeral decoration: they stream to the renderer
      // below but are never persisted — thread state lives in
      // `runtime_agents` (see `listThreadActivity`), and persisting every
      // tick grew the message table without bound.
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
      // Subagents stay out of the root event table, but the parent's own
      // read-only thread viewer still needs the canonical lifecycle semantics
      // so spawns and completions render as cards there. Store a display-only
      // structured entry beside (not inside) the model-visible terminal
      // reminder. Starts/progress have no reminder at all, and this entry type
      // is never replayed into the parent's model context.
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
    // A legacy/malformed parent link or ancestry cycle cannot be attributed
    // safely. Keep the task in Activity, but never guess that it belongs in
    // root chat or let it finalize the root turn.
    if (hasUnresolvedParentAncestry) return;
    const userPrompt = buildAgentEventPrompt(event, {
      recipient: isParentOwned ? "parent_agent" : "orchestrator",
    });
    if (!userPrompt) {
      // Desktop-originated cloud pauses deliberately suppress a synthetic
      // orchestrator follow-up so it cannot overwrite the user's visible
      // pause response. The Convex lifecycle monitor still needs a durable
      // event marker before it may ACK the terminal row; otherwise that row
      // remains subscribed forever and is replayed on every restart.
      if (
        event.type === "agent-canceled" &&
        event.audience === "orchestrator-only" &&
        event.eventId
      ) {
        const orchestratorThreadId = resolveOrchestratorThreadKey(
          event.conversationId,
        );
        if (
          !hasPersistedThreadEvent(context, orchestratorThreadId, event.eventId)
        ) {
          persistThreadCustomMessage(context.runtimeStore, {
            threadKey: orchestratorThreadId,
            customType: "runtime.task_lifecycle",
            content: [],
            display: false,
            timestamp: Date.now(),
            eventId: event.eventId,
            lifecycleEvent: {
              type: event.type,
              payload: buildLifecycleEventPayload(event),
            },
          });
        }
      }
      return;
    }
    const deliveryEventId = event.eventId?.trim();
    if (deliveryEventId) {
      if (inFlightLifecycleEventIds.has(deliveryEventId)) return;
      inFlightLifecycleEventIds.add(deliveryEventId);
    }
    if (parentThreadId) {
      // Subagent reports live in the parent agent's durable thread and wake
      // that parent directly. They never enter the top-level orchestrator's
      // history, callbacks, or hidden steering stream — so a nested
      // completion produces no root card and no OS notification.
      try {
        if (
          !hasPersistedThreadCustomEvent(context, parentThreadId, event.eventId)
        ) {
          persistThreadCustomMessage(context.runtimeStore, {
            threadKey: parentThreadId,
            customType: "runtime.task_lifecycle",
            content: [{ type: "text", text: userPrompt }],
            display: false,
            timestamp: Date.now(),
            ...(deliveryEventId ? { eventId: deliveryEventId } : {}),
          });
        }
        const wake = await context.state.localAgentManager?.sendAgentMessage(
          parentThreadId,
          userPrompt,
          "orchestrator",
          {
            deliveryKind: "child-report",
            ...(deliveryEventId ? { deliveryEventId } : {}),
          },
        );
        if (wake?.delivered !== true) {
          throw new Error(
            `Unable to durably admit terminal wake for parent ${parentThreadId}.`,
          );
        }
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
        ...(event.ownerGeneration
          ? { ownerGeneration: event.ownerGeneration }
          : {}),
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
    // Two-phase summary stamp, phase 2 (persist-time invariant): the
    // terminal report is now durably in this conversation's orchestrator
    // thread, so associate the matching summary with that conversation.
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
        // Promotion is best-effort bookkeeping for transcript association.
      }
    }
  };
  context.state.localAgentManager = new LocalAgentManager({
    maxConcurrent: 24,
    ...(deps.attemptTeardownTimeoutMs !== undefined
      ? { attemptTeardownTimeoutMs: deps.attemptTeardownTimeoutMs }
      : {}),
    getMaxConcurrent: () => getMaxAgentConcurrency(context.stellaDataDir),
    resolveTaskThread: ({
      conversationId,
      agentType,
      threadId,
      nameHint,
    }: Record<string, any>) => {
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
    listActiveThreads: (conversationId: string) =>
      context.runtimeStore.listActiveThreads(conversationId),
    onAgentEvent: (event: AgentLifecycleEvent) => {
      reconcileBackgroundExitWake(context, event);
      const delivery = handleAgentLifecycleEvent(event);
      if (
        event.type === "agent-completed" ||
        event.type === "agent-failed" ||
        event.type === "agent-canceled"
      ) {
        // Terminal callers await this promise. Their durable local/cloud receipt
        // remains unacknowledged until this exact lifecycle event is persisted.
        return delivery;
      }
      void delivery.catch((error) => {
        console.warn(
          "[runner] non-terminal agent lifecycle delivery failed",
          error instanceof Error ? error.message : error,
        );
      });
    },
    fetchAgentContext: deps.buildAgentContext,
    ...(deps.resolveAgentModelConfig
      ? { resolveAgentModelConfig: deps.resolveAgentModelConfig }
      : {}),
    superviseAttempt: (attempt: any) =>
      context.state.supervisor.adoptChild(attempt.rootRunId, attempt.threadId, {
        abort: attempt.abort,
        settled: attempt.settled,
      }),
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
      persistToConvex,
      ownerGeneration,
      abortSignal,
      subagentSession,
      onProgress,
      onStatus,
      onToolStart,
      onToolEnd,
      toolExecutor,
    }: Record<string, any>) => {
      const runId = `local:sub:${crypto.randomUUID()}`;
      const site = createRunnerSiteConfig(context);
      const resolvedLlm =
        agentContext.resolvedLlm ??
        (await withStellaModelCatalogMetadata({
          route: resolveLlmRouteForCatalogEnrichment({
            // `resolveLlmRoute`'s `stellaAppDir` arg is the directory it reads
            // BYOK/local provider credentials from, which live under the data
            // dir (~/.stella), not the install/code tree. Every other runner
            // call site (model-selection.ts, resolveSubsidiaryLlmRoute below)
            // passes `stellaDataDir`; this fallback previously passed
            // `stellaAppDir`, so if a subagent ever hit this branch it would
            // look for credentials in the wrong place and diverge from the
            // orchestrator's resolution — surfacing as a spurious
            // missing-credential/provider error after a provider switch.
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
        storageMode: persistToConvex ? "cloud" : "local",
        ownerGeneration,
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
        // Subagent provider streams / tool calls supervise under the root
        // run's scope (or detached when the child has no live root), same
        // structure as the attempt fiber itself.
        superviseRunResource: (resource) =>
          context.state.supervisor.adoptResource(rootRunId, resource.label, {
            abort: resource.abort,
            settled: resource.settled,
          }),
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
            // Honor any per-agent override the user set for this
            // subsidiary agent (or our Assistant-tab propagation would
            // silently hit Stella even when the user moved Assistant
            // onto BYOK).
            modelName: getModelOverride(
              context.stellaDataDir,
              subsidiaryAgentType,
            ),
            agentType: subsidiaryAgentType,
            site: createRunnerSiteConfig(context),
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
          onStatus: (event) => {
            onStatus?.(event.statusText);
            if (event.statusState !== "provider-retry") {
              runnerCallbacks?.onStatus?.(event);
            }
          },
          onToolEnd: (event) => {
            onToolEnd?.(event);
            // Stamp durable thread + attempt provenance onto live tool-file
            // events. `details` is flattened into the persisted tool_result
            // payload by the worker, so the renderer can fence a write to the
            // exact Activity attempt instead of replaying it on every later
            // follow-up that reuses this agent id.
            const eventDetails =
              event.details &&
              typeof event.details === "object" &&
              !Array.isArray(event.details)
                ? event.details
                : event.details === undefined
                  ? {}
                  : { result: event.details };
            runnerCallbacks?.onToolEnd(
              agentId
                ? {
                    ...event,
                    agentId,
                    details: {
                      ...eventDetails,
                      attemptGeneration: agentContext.attemptGeneration,
                      ...(rootRunId ? { rootRunId } : {}),
                    },
                  }
                : event,
            );
          },
        },
        hookEmitter: context.hookEmitter,
      }).finally(() => context.toolHost.endBrowserTurn(runId, "close-tabs"));
      return result;
    },
    toolExecutor: (
      toolName: any,
      args: any,
      toolContext: any,
      signal: any,
      onUpdate: any,
    ) =>
      context.toolHost.executeTool(
        toolName,
        args,
        toolContext,
        signal,
        onUpdate,
      ),
    ...(deps.cloudAgentRecords
      ? {
          createCloudAgentRecord: deps.cloudAgentRecords.create,
          completeCloudAgentRecord: deps.cloudAgentRecords.complete,
          getCloudAgentRecord: deps.cloudAgentRecords.get,
          cancelCloudAgentRecord: deps.cloudAgentRecords.cancel,
        }
      : {}),
    saveAgentRecord: (record: any) => {
      const recordRevision = context.runtimeStore.saveAgentRecord?.(record);
      if (recordRevision === null) return;
      // Project the just-persisted row so consumers patch one keyed record
      // instead of refetching every thread in the conversation.
      const threadMetadata = context.runtimeStore.getThreadActivityMetadata?.(
        record.threadId,
      );
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
    getAgentRecord: (threadId: string) =>
      context.runtimeStore.getAgentRecord?.(threadId) ?? null,
    listAgentRecordsByStatus: (status: any) =>
      context.runtimeStore.listAgentRecordsByStatus?.(status) ?? [],
    persistBootInterruptionSnapshot: (threads: any) =>
      writeRestartInterruptedSnapshot(context.stellaDataDir, threads),
    hasAgentLifecycleEvent: (
      conversationId: string,
      eventId: string,
      type: string,
    ) => {
      const hasActivityEvent = context.runtimeStore.hasEvent(
        conversationId,
        eventId,
        type,
      );
      const hasOrchestratorReminder = hasPersistedThreadEvent(
        context,
        resolveOrchestratorThreadKey(conversationId),
        eventId,
      );
      if (
        type === "agent-completed" ||
        type === "agent-failed" ||
        type === "agent-canceled"
      ) {
        // A wake-bearing terminal is delivered only when both durable artifacts
        // exist. Recovery re-enters the idempotent lifecycle handler to repair
        // either half of an interrupted two-write delivery. This must cover
        // failures and cancellations too: their Activity row is written before
        // the hidden reminder, so treating that row alone as a receipt can lose
        // the orchestrator wake forever after a crash. Cancellation paths that
        // deliberately suppress a wake safely return false here until their
        // exact-generation receipt is stamped after idempotent handler re-entry.
        return hasActivityEvent && hasOrchestratorReminder;
      }
      return (
        hasActivityEvent ||
        (type === "agent-message" && hasOrchestratorReminder)
      );
    },
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
    const requestedThreadId = request.threadId?.trim();
    const cancellationReason = requestedThreadId
      ? getPlacementCancellation({
          store: context.runtimeStore,
          kind: "agent",
          executionId: requestedThreadId,
        })
      : null;
    if (requestedThreadId && cancellationReason) {
      return {
        status: "error",
        finalText: "",
        error: cancellationReason,
        threadId: requestedThreadId,
      };
    }
    const { threadId } = await context.state.localAgentManager.createAgent({
      ...request,
      ...(requestedThreadId ? { threadId: requestedThreadId } : {}),
      storageMode: "local",
    });
    // Effect-native settlement (replaces the historical poll-until-terminal
    // loop): the manager's settlement latch wakes the wait on terminal
    // transitions, with the same 2s fallback re-read for rehydrated records
    // and out-of-band writers — SQLite stays the only truth. Cancellation
    // pairing: abandoning this wait never cancels the child; the parent
    // run's supervisor scope owns that (adoptChild's abort → cancelAgent,
    // joined on cancelRun/shutdown).
    const settlement =
      await context.state.localAgentManager.awaitAgentSettled(threadId);
    if (!settlement) {
      return {
        status: "error",
        finalText: "",
        error: "Agent record disappeared before completion.",
        threadId,
      };
    }
    if (settlement.status === "completed") {
      return {
        status: "ok",
        finalText: settlement.result ?? "",
        threadId,
      };
    }
    return {
      status: "error",
      finalText: "",
      error: settlement.error ?? "Agent run failed",
      threadId,
    };
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
    const record = context.runtimeStore.getAgentRecord?.(agentId);
    if (record?.conversationId) {
      context.state.backgroundExitWake?.disarm({
        conversationId: record.conversationId,
        agentId,
      });
    } else {
      context.state.backgroundExitWake?.disarm(agentId);
    }
    return await context.state.localAgentManager.cancelAgent(agentId, reason);
  };

  const cancelBlockingLocalAgent = async (
    agentId: string,
    reason?: string,
  ): Promise<{ canceled: boolean }> => {
    const exactAgentId = agentId.trim();
    if (!exactAgentId) return { canceled: false };
    // This SQLite write is deliberately synchronous and precedes every
    // lookup/await. The ACK therefore survives a worker restart in the gap
    // before a delayed runBlockingLocalAgent RPC is delivered.
    persistPlacementCancellation({
      store: context.runtimeStore,
      kind: "agent",
      executionId: exactAgentId,
      reason,
    });

    const manager = context.state.localAgentManager;
    if (!manager) {
      // The tombstone still acknowledges that no later blocking create in this
      // runner instance can resurrect the exact ID.
      return { canceled: true };
    }
    const record = context.runtimeStore.getAgentRecord?.(exactAgentId);
    const hasActiveLocalOwner = manager
      .listActiveAgentRuns()
      .some((run) => run.runId === exactAgentId);
    if ((!record || record.storageMode === "cloud") && !hasActiveLocalOwner) {
      // Unknown IDs are pre-canceled locally. Never delegate to
      // LocalAgentManager.cancelAgent's cloud-record fallback.
      return { canceled: true };
    }
    if (record?.conversationId) {
      context.state.backgroundExitWake?.disarm({
        conversationId: record.conversationId,
        agentId: exactAgentId,
      });
    } else {
      context.state.backgroundExitWake?.disarm(exactAgentId);
    }
    return await manager.cancelAgentAndJoin(exactAgentId, reason);
  };

  const shutdown = async (): Promise<void> => {
    await context.state.localAgentManager?.shutdown();
    shutdownSubagentRuntimes();
  };

  return {
    runBlockingLocalAgent,
    createBackgroundAgent,
    cancelLocalAgent,
    cancelBlockingLocalAgent,
    handleExternalAgentLifecycleEvent: handleAgentLifecycleEvent,
    hasDurableExternalLifecycleEvent: (event: AgentLifecycleEvent) =>
      hasDurableAgentLifecycleEvent(context, event),
    shutdown,
  };
};
