import crypto from "crypto";
import {
  resolveLlmRoute,
  resolveLlmRouteForCatalogEnrichment,
} from "../model-routing.js";
import { withStellaModelCatalogMetadata } from "../stella-model-catalog.js";
import {
  getAgentRuntimeEngine,
  getMaxAgentConcurrency,
  getModelOverride,
} from "../preferences/local-preferences.js";
import { desktopPiChatEnabled } from "@stella/contracts/pi-chat";
import { runSubagentTask, shutdownSubagentRuntimes } from "../agent-runtime.js";
import { createAgentLifecycleResponseTarget } from "../agent-runtime/response-target.js";
import { persistThreadCustomMessage } from "../agent-runtime/thread-memory.js";
import { resolvePlacedAgentModel } from "./placed-agent-model.js";
import { resolveOrchestratorThreadKey } from "../thread-runtime.js";
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
import type { AgentMessageDeviceOutcome } from "@stella/contracts/turn-plane/placement";
import { buildAgentEventPrompt } from "./shared.js";
import type { LocalChatEventRecord } from "../storage/shared.js";
import type { ThreadActivityRecord } from "@stella/contracts/local-chat";
import { createRunnerSiteConfig } from "./model-selection.js";
import { RUNTIME_PRIVATE_TASK_LIFECYCLE_CUSTOM_TYPE } from "../storage/shared.js";
import type { ComputerAgentCloudRecords } from "./computer-agent-cloud-records.js";
import {
  getPlacementCancellation,
  persistPlacementCancellation,
} from "./execution-placement-local-ownership.js";

const TASK_LIFECYCLE_CUSTOM_TYPE = "runtime.task_lifecycle";

const hasPersistedThreadCustomEvent = (
  context: RunnerContext,
  threadKey: string,
  eventId: string | undefined,
): boolean => {
  if (!eventId) return false;
  const store = context.runtimeStore;
  // Keyed, indexed probe; never loads or parses the thread transcript.
  if (typeof store.hasThreadCustomEvent === "function") {
    return store.hasThreadCustomEvent(
      threadKey,
      TASK_LIFECYCLE_CUSTOM_TYPE,
      eventId,
    );
  }
  // Store doubles without the keyed probe keep the historical transcript scan.
  const loadThreadMessages =
    store.loadRawThreadMessages ?? store.loadThreadMessages;
  if (typeof loadThreadMessages !== "function") return false;
  return loadThreadMessages
    .call(store, threadKey)
    .some(
      (message) =>
        message.customMessage?.customType === TASK_LIFECYCLE_CUSTOM_TYPE &&
        message.customMessage.eventId === eventId,
    );
};

// stella-cloud-side callers use the shorter name for the same check.
const hasPersistedThreadEvent = hasPersistedThreadCustomEvent;

/**
 * Where a terminal report belongs: the live owning agent, or the conversation
 * the user is actually on. Never a thread that failed, was canceled, or can no
 * longer be attributed.
 */
type LifecycleReportDestination =
  | { kind: "parent_agent"; threadId: string }
  | { kind: "user_thread"; reason?: string; orphanedFrom?: string };

const resolveLifecycleReportDestination = (
  context: RunnerContext,
  event: AgentLifecycleEvent,
): LifecycleReportDestination => {
  const installedManager = context.state.localAgentManager;
  if (typeof installedManager?.resolveReportDestination === "function") {
    return installedManager.resolveReportDestination(
      event.agentId,
      event.parentAgentId,
    ) as LifecycleReportDestination;
  }
  const legacyOwner = installedManager
    ? installedManager.resolveOwningParentThread(
        event.agentId,
        event.parentAgentId,
      )
    : event.parentAgentId;
  return typeof legacyOwner === "string"
    ? { kind: "parent_agent", threadId: legacyOwner }
    : { kind: "user_thread" };
};

export const hasDurableAgentLifecycleEvent = (
  context: RunnerContext,
  event: AgentLifecycleEvent,
): boolean => {
  const eventId = event.eventId?.trim();
  if (!eventId) return false;
  // Acceptance, not routing, is the receipt: an owner that already admitted
  // this wake keeps the row acknowledged even if it has since gone terminal,
  // and a refused wake stays unacknowledged until the user's thread admits it.
  const ownerAccepted = (threadId: string): boolean => {
    const owner = context.runtimeStore.getAgentRecord?.(threadId);
    return (
      owner?.descendantBoundaryState?.consumedEventIds.includes(eventId) ===
        true && hasPersistedThreadEvent(context, threadId, eventId)
    );
  };
  const staticOwner = event.parentAgentId?.trim();
  if (staticOwner && ownerAccepted(staticOwner)) return true;
  const destination = resolveLifecycleReportDestination(context, event);
  if (destination.kind === "parent_agent") {
    return ownerAccepted(destination.threadId);
  }
  const orchestratorThreadKey = resolveOrchestratorThreadKey(
    event.conversationId,
  );
  if (event.audience === "orchestrator-only") {
    return hasPersistedThreadEvent(context, orchestratorThreadKey, eventId);
  }
  return (
    context.runtimeStore.chat.hasEvent(
      event.conversationId,
      eventId,
      event.type,
    ) && hasPersistedThreadEvent(context, orchestratorThreadKey, eventId)
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

/**
 * Durable marker for a terminal event whose user-facing follow-up is
 * deliberately suppressed. Without it the cloud lifecycle monitor can never
 * ACK the row and replays it on every restart.
 */
const persistSuppressedLifecycleMarker = (
  context: RunnerContext,
  event: AgentLifecycleEvent,
): void => {
  if (!event.eventId) return;
  const orchestratorThreadId = resolveOrchestratorThreadKey(
    event.conversationId,
  );
  if (hasPersistedThreadEvent(context, orchestratorThreadId, event.eventId)) {
    return;
  }
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
    const destination = resolveLifecycleReportDestination(context, event);
    const ownerThreadId =
      destination.kind === "parent_agent" ? destination.threadId : undefined;
    const isParentOwned = ownerThreadId !== undefined;
    const orphanedFrom =
      destination.kind === "user_thread" ? destination.orphanedFrom : undefined;
    // Some lifecycle transitions are control-plane-only (see
    // `AgentLifecycleEvent.audience`): `orchestrator-only` skips every
    // display surface (persisted chat event, renderer/run callbacks,
    // OS notification). Interjection completions use it before their deferred
    // `display-only` replay; internal owner wake-ups use it so reviewing a
    // privately routed child report does not create a root-chat card.
    if (event.audience !== "orchestrator-only" && !isParentOwned) {
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
    if (ownerThreadId && event.audience !== "orchestrator-only") {
      // Subagents stay out of the root event table, but the parent's own
      // read-only thread viewer still needs the canonical lifecycle semantics
      // so spawns and completions render as cards there. Store a display-only
      // structured entry beside (not inside) the model-visible terminal
      // reminder. Starts/progress have no reminder at all, and this entry type
      // is never replayed into the parent's model context.
      const lifecycleEvent = buildThreadLifecycleEvent(event, Date.now());
      if (
        !context.runtimeStore.hasThreadLifecycleEvent(
          ownerThreadId,
          lifecycleEvent._id,
        )
      ) {
        context.runtimeStore.appendThreadLifecycleEvent({
          threadKey: ownerThreadId,
          event: lifecycleEvent,
        });
      }
    }
    if (event.audience === "display-only") {
      return;
    }
    const userPrompt = buildAgentEventPrompt(event, {
      recipient: isParentOwned ? "parent_agent" : "orchestrator",
      ...(orphanedFrom ? { orphanedFrom } : {}),
    });
    if (!userPrompt) {
      // Desktop-originated cloud pauses deliberately suppress a synthetic
      // orchestrator follow-up so it cannot overwrite the user's visible
      // pause response. The cloud lifecycle monitor still needs a durable
      // event marker before it may ACK the terminal row; otherwise that row
      // remains subscribed forever and is replayed on every restart.
      if (
        event.type === "agent-canceled" &&
        event.audience === "orchestrator-only"
      ) {
        persistSuppressedLifecycleMarker(context, event);
      }
      return;
    }
    const deliveryEventId = event.eventId?.trim();
    if (deliveryEventId) {
      if (inFlightLifecycleEventIds.has(deliveryEventId)) return;
      inFlightLifecycleEventIds.add(deliveryEventId);
    }
    try {
      if (ownerThreadId) {
        // Subagent reports live in the owning agent's durable thread and wake
        // that agent directly. They never enter the top-level orchestrator's
        // history, callbacks, or hidden steering stream — so a nested
        // completion produces no root card and no OS notification.
        if (
          !hasPersistedThreadCustomEvent(context, ownerThreadId, event.eventId)
        ) {
          persistThreadCustomMessage(context.runtimeStore, {
            threadKey: ownerThreadId,
            customType: "runtime.task_lifecycle",
            content: [{ type: "text", text: userPrompt }],
            display: false,
            timestamp: Date.now(),
            ...(deliveryEventId ? { eventId: deliveryEventId } : {}),
          });
        }
        const wake = await context.state.localAgentManager?.sendAgentMessage(
          ownerThreadId,
          userPrompt,
          "orchestrator",
          {
            deliveryKind: "child-report",
            ...(deliveryEventId ? { deliveryEventId } : {}),
          },
        );
        if (wake?.delivered === true) return;
        // The owner raced into a terminal state between routing and delivery.
        // Refusing the wake is not a delivery, so the report falls through to
        // the conversation the user is on rather than being dropped.
        console.warn(
          `[agent-report] owner ${ownerThreadId} did not admit ${event.type} for ${event.agentId}${
            wake?.reason ? ` (${wake.reason})` : ""
          }; escalating to the user's thread.`,
        );
      }
      const orchestratorPrompt = ownerThreadId
        ? buildAgentEventPrompt(event, {
            recipient: "orchestrator",
            orphanedFrom: ownerThreadId,
          })
        : userPrompt;
      if (!orchestratorPrompt) {
        persistSuppressedLifecycleMarker(context, event);
        return;
      }
      const orchestratorThreadKey = resolveOrchestratorThreadKey(
        event.conversationId,
      );
      if (
        hasPersistedThreadCustomEvent(
          context,
          orchestratorThreadKey,
          event.eventId,
        )
      ) {
        return;
      }
      if (desktopPiChatEnabled(getAgentRuntimeEngine(context.stellaDataDir))) {
        const deliver = context.state.piReportDelivery;
        if (!deliver) {
          throw new Error(
            "Stella's chat is not ready to take this agent report yet.",
          );
        }
        await deliver({
          conversationId: event.conversationId,
          requestId: `agent-report:${
            deliveryEventId ??
            `${event.agentId}:${event.attemptGeneration ?? 0}:${event.type}`
          }`,
          text: orchestratorPrompt,
        });
        persistThreadCustomMessage(context.runtimeStore, {
          threadKey: orchestratorThreadKey,
          customType: TASK_LIFECYCLE_CUSTOM_TYPE,
          content: [{ type: "text", text: orchestratorPrompt }],
          display: false,
          timestamp: Date.now(),
          ...(deliveryEventId ? { eventId: deliveryEventId } : {}),
        });
      } else {
        await deps.sendMessage({
          conversationId: event.conversationId,
          text: orchestratorPrompt,
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
      }
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
      attachments,
      persistToCloud,
      ownerGeneration,
      abortSignal,
      steering,
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
          backendUrl: context.state.backendUrl,
          stellaDataDir: context.stellaDataDir,
          ...(context.cliBridgeSocketPath
            ? { cliBridgeSocketPath: context.cliBridgeSocketPath }
            : {}),
        }));
      const runnerCallbacks =
        (rootRunId ? context.state.runCallbacksByRunId.get(rootRunId) : null) ??
        context.state.conversationCallbacks.get(conversationId) ??
        null;

      const composedUserPrompt = `${taskDescription}\n\n${taskPrompt}`;

      const result = await runSubagentTask({
        executionHost: "device",
        conversationId,
        storageMode: persistToCloud ? "cloud" : "local",
        ownerGeneration,
        userMessageId,
        runId,
        agentId,
        rootRunId,
        agentType,
        userPrompt: composedUserPrompt,
        // Already materialized into local files with a `sourcePath`, so the
        // run names the paths in the brief rather than inlining pixels the
        // agent may not need.
        ...(Array.isArray(attachments) && attachments.length > 0
          ? { attachments }
          : {}),
        agentContext,
        toolCatalog: context.toolHost.getToolCatalog(agentType, {
          model: resolvedLlm.toolPolicyModel ?? resolvedLlm.model,
          agentEngine: agentContext.agentEngine,
        }),
        toolExecutor,
        deviceId: context.deviceId,
        stellaDataDir: context.stellaDataDir,
        resolvedLlm,
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
        ...(steering ? { steering } : {}),
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
    onCloudReportText: (text: string) =>
      context.linkedFilePublisher?.publishText(text),
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
    // The persisted terminal-receipt replay is off the boot critical path: it
    // parks until the runtime has started and initialized, so the wake it
    // repairs can actually be admitted (a parent wake needs the installed
    // manager; an orchestrator wake needs a started runtime). An embedding
    // without the runner lifecycle latch keeps the historical immediate replay.
    ...(context.state.initializationStarted
      ? {
          awaitTerminalLifecycleRecoveryReady: async () => {
            await context.state.initializationStarted.awaitOpen();
            try {
              await context.state.initializationPromise;
            } catch {
              // Unready this boot: the unstamped rows replay on the next one.
              return false;
            }
            return context.state.isRunning === true;
          },
        }
      : {}),
    readTerminalLifecycleRecoveryLedger: (key: string) =>
      context.runtimeStore.chat.getSetting?.(key) ?? null,
    writeTerminalLifecycleRecoveryLedger: (key: string, value: string) => {
      context.runtimeStore.chat.setSetting?.(key, value);
    },
    hasAgentLifecycleEvent: (
      conversationId: string,
      eventId: string,
      type: string,
    ) => {
      const hasActivityEvent = context.runtimeStore.chat.hasEvent(
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
    request: Omit<AgentToolRequest, "storageMode"> & {
      executionId?: string;
      requestedModel?: string;
    },
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
    const {
      executionId: requestedExecutionId,
      requestedModel,
      ...agentRequest
    } = request;
    const requestedThreadId = agentRequest.threadId?.trim();
    const fenceId = requestedExecutionId?.trim() || requestedThreadId;
    const cancellationReason = fenceId
      ? getPlacementCancellation({
          store: context.runtimeStore.chat,
          kind: "agent",
          executionId: fenceId,
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
    const manager = context.state.localAgentManager;
    // A remote thread's later attempt continues the local thread its first
    // attempt created, with that thread's history, as a follow-up would.
    const continued =
      requestedThreadId &&
      requestedExecutionId &&
      context.runtimeStore.getAgentRecord?.(requestedThreadId)
        ? await manager.sendAgentMessage(
            requestedThreadId,
            agentRequest.prompt,
            "orchestrator",
            { deliveryKind: "external-input" },
          )
        : null;
    // A follow-up keeps the model its thread started on. A requested model
    // this device can't run fails the agent with the reason; it never runs
    // on something the requester didn't ask for.
    let placedModel: Awaited<ReturnType<typeof resolvePlacedAgentModel>> = {};
    if (!continued?.delivered) {
      try {
        placedModel = await resolvePlacedAgentModel(
          context.spawnModelSupport,
          requestedModel,
        );
      } catch (error) {
        return {
          status: "error",
          finalText: "",
          error: `The requested model "${requestedModel}" can't run on this device: ${
            error instanceof Error ? error.message : String(error)
          }`,
          ...(requestedThreadId ? { threadId: requestedThreadId } : {}),
        };
      }
    }
    const { threadId } = continued?.delivered
      ? { threadId: requestedThreadId! }
      : await manager.createAgent({
          ...agentRequest,
          ...placedModel,
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
    const settlement = await manager.awaitAgentSettled(threadId);
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
    executionId?: string,
  ): Promise<{ canceled: boolean }> => {
    const exactAgentId = agentId.trim();
    if (!exactAgentId) return { canceled: false };
    // This SQLite write is deliberately synchronous and precedes every
    // lookup/await. The ACK therefore survives a worker restart in the gap
    // before a delayed runBlockingLocalAgent RPC is delivered.
    persistPlacementCancellation({
      store: context.runtimeStore.chat,
      kind: "agent",
      executionId: executionId?.trim() || exactAgentId,
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

  const steerBlockingLocalAgent = async (
    agentId: string,
    text: string,
    messageId: string,
  ): Promise<{ delivered: boolean }> => {
    const manager = context.state.localAgentManager;
    const exactAgentId = agentId.trim();
    if (!manager || !exactAgentId || !text.trim()) return { delivered: false };
    // Only a run that is going now: a message for a finished thread would
    // resume it outside the placement that owns its attempts.
    const running = manager
      .listActiveAgentRuns()
      .some((run) => run.runId === exactAgentId);
    if (!running) return { delivered: false };
    // The cloud frames another agent's note before it gets here; the
    // owner's instruction arrives bare.
    return await manager.sendAgentMessage(exactAgentId, text, "orchestrator", {
      deliveryKind: text.trimStart().startsWith("<agent-message ")
        ? "agent-message"
        : "external-input",
      ...(messageId.trim() ? { deliveryEventId: messageId.trim() } : {}),
    });
  };

  const deliverLocalAgentMessage = async (
    threadId: string,
    text: string,
    messageId: string,
    ownerGeneration: string,
  ): Promise<AgentMessageDeviceOutcome> => {
    const manager = context.state.localAgentManager;
    const exactThreadId = threadId.trim();
    if (!manager || !text.trim()) return "refused";
    const record = exactThreadId
      ? context.runtimeStore.getAgentRecord?.(exactThreadId)
      : null;
    if (!record) return "not_found";
    if (record.ownerGeneration && record.ownerGeneration !== ownerGeneration) {
      return "refused";
    }
    const delivery = await manager.sendAgentMessage(
      exactThreadId,
      text,
      "orchestrator",
      {
        deliveryKind: "agent-message",
        ...(messageId.trim() ? { deliveryEventId: messageId.trim() } : {}),
      },
    );
    if (!delivery.delivered) return "not_found";
    if (delivery.resumed) return "resumed";
    return "steered" in delivery && delivery.steered ? "steered" : "queued";
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
    steerBlockingLocalAgent,
    deliverLocalAgentMessage,
    handleExternalAgentLifecycleEvent: handleAgentLifecycleEvent,
    hasDurableExternalLifecycleEvent: (event: AgentLifecycleEvent) =>
      hasDurableAgentLifecycleEvent(context, event),
    shutdown,
  };
};
