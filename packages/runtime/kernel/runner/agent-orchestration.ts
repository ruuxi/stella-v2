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
import {
  isFileChangeRecordArray,
  isProducedFileRecordArray,
  type FileChangeRecord,
  type ProducedFileRecord,
} from "@stella/contracts/file-changes";
import type { RunnerContext } from "./types.js";
import { buildAgentEventPrompt } from "./shared.js";
import { RUNTIME_PRIVATE_TASK_LIFECYCLE_CUSTOM_TYPE } from "../storage/shared.js";
import type { ComputerAgentCloudRecords } from "./computer-agent-cloud-records.js";

const collectFileChanges = (
  target: FileChangeRecord[],
  seen: Set<string>,
  source: unknown,
): void => {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return;
  }
  const candidate = (source as { fileChanges?: unknown }).fileChanges;
  if (!isFileChangeRecordArray(candidate)) {
    return;
  }
  for (const change of candidate) {
    const key = `${change.kind.type}:${change.path}:${change.kind.type === "update" ? (change.kind.move_path ?? "") : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(change);
  }
};

const collectProducedFiles = (
  target: ProducedFileRecord[],
  seen: Set<string>,
  source: unknown,
): void => {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return;
  }
  const candidate = (source as { producedFiles?: unknown }).producedFiles;
  if (!isProducedFileRecordArray(candidate)) {
    return;
  }
  for (const file of candidate) {
    const key = `${file.kind.type}:${file.path}:${file.kind.type === "update" ? (file.kind.move_path ?? "") : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(file);
  }
};

const hasPersistedThreadEvent = (
  context: RunnerContext,
  threadId: string,
  eventId: string | undefined,
): boolean => {
  if (!eventId) return false;
  const loadThreadMessages = context.runtimeStore.loadThreadMessages;
  if (typeof loadThreadMessages !== "function") return false;
  return loadThreadMessages
    .call(context.runtimeStore, threadId)
    .some((message) => {
      if (
        message.customMessage?.customType !== "runtime.task_lifecycle" &&
        message.customMessage?.customType !== "runtime.task_update" &&
        message.customMessage?.customType !==
          RUNTIME_PRIVATE_TASK_LIFECYCLE_CUSTOM_TYPE
      ) {
        return false;
      }
      return message.customMessage.eventId === eventId;
    });
};

const getShellExecutionState = (
  result: ToolResult,
): { sessionId: string | null; running: boolean } | null => {
  const payload = result.details ?? result.result;
  if (typeof payload === "string") {
    const match = payload.match(/\bShell ID:\s*([^\s]+)/);
    if (match) {
      return { sessionId: match[1] ?? null, running: true };
    }
  }
  if (!payload || typeof payload !== "object") return null;
  const record = payload as { session_id?: unknown; running?: unknown };
  if (typeof record.running !== "boolean") return null;
  return {
    sessionId: typeof record.session_id === "string" ? record.session_id : null,
    running: record.running,
  };
};

const normalizeNestedToolName = (raw: unknown): string => {
  const value = typeof raw === "string" ? raw.trim() : "";
  return value.startsWith("functions.")
    ? value.slice("functions.".length)
    : value;
};

const getParallelToolEntries = (
  args: Record<string, unknown>,
): Array<{ toolName: string; parameters: Record<string, unknown> }> => {
  if (!Array.isArray(args.tool_uses)) return [];
  const out: Array<{ toolName: string; parameters: Record<string, unknown> }> =
    [];
  for (const entry of args.tool_uses) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { recipient_name?: unknown; parameters?: unknown };
    const toolName = normalizeNestedToolName(record.recipient_name);
    const parameters =
      record.parameters && typeof record.parameters === "object"
        ? (record.parameters as Record<string, unknown>)
        : {};
    out.push({ toolName, parameters });
  }
  return out;
};

const parallelContainsShellCommand = (args: Record<string, unknown>): boolean =>
  getParallelToolEntries(args).some(
    (entry) => entry.toolName === "exec_command",
  );

const getParallelRunningShellSessions = (result: ToolResult): string[] => {
  const details = result.details;
  if (!details || typeof details !== "object") return [];
  const results = (details as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const sessionIds: string[] = [];
  for (const entry of results) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as {
      tool_name?: unknown;
      result?: unknown;
      details?: unknown;
    };
    if (record.tool_name !== "exec_command") continue;
    const shellState = getShellExecutionState({
      result: record.result,
      details: record.details,
    });
    if (shellState?.running && shellState.sessionId) {
      sessionIds.push(shellState.sessionId);
    }
  }
  return sessionIds;
};

const parallelToolResultContainsShellCommand = (details: unknown): boolean => {
  if (!details || typeof details !== "object") return false;
  const results = (details as { results?: unknown }).results;
  if (!Array.isArray(results)) return false;
  return results.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    return (entry as { tool_name?: unknown }).tool_name === "exec_command";
  });
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
        ...(event.fileChanges?.length
          ? { fileChanges: event.fileChanges }
          : {}),
        ...(event.producedFiles?.length
          ? { producedFiles: event.producedFiles }
          : {}),
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
      deliverAs?: "steer" | "followUp";
      callbackRunId?: string;
      responseTarget?: import("@stella/contracts/protocol").RuntimeAgentEventPayload["responseTarget"];
      customType?: string;
      display?: boolean;
    }) => Promise<void>;
    cloudAgentRecords: ComputerAgentCloudRecords;
    /** Test/embedding override; production uses the manager's bounded default. */
    attemptTeardownTimeoutMs?: number;
  },
) => {
  const handleAgentLifecycleEvent = (rawEvent: AgentLifecycleEvent) => {
    // Enrich every lifecycle event with its thread's work group ONCE,
    // centrally — emit sites in the manager stay group-unaware. The
    // Activity UI uses this to collapse sibling agents under one group
    // header.
    let event = rawEvent;
    if (!event.groupKey) {
      // Optional-chained like the other runtimeStore lookups here so partial
      // runtime-store adapters remain supported.
      const group = context.runtimeStore.getThreadGroup?.(event.agentId);
      if (group?.groupKey) {
        event = {
          ...event,
          groupKey: group.groupKey,
          ...(group.groupLabel ? { groupLabel: group.groupLabel } : {}),
        };
      }
    }
    const resolvePersistedManagerAncestry = () => {
      if (!event.parentAgentId) return { kind: "none" as const };
      const visited = new Set<string>();
      let cursor: string | undefined = event.parentAgentId;
      while (cursor) {
        if (visited.has(cursor)) {
          return { kind: "invalid" as const };
        }
        visited.add(cursor);
        const record = context.runtimeStore.getAgentRecord?.(cursor);
        if (!record) return { kind: "invalid" as const };
        if (record.agentType === AGENT_IDS.MANAGER) {
          return { kind: "manager" as const, managerThreadId: cursor };
        }
        cursor = record.parentAgentId;
      }
      return { kind: "none" as const };
    };
    const managerOwnership =
      context.state.localAgentManager?.resolveManagerAncestry(
        event.parentAgentId,
      ) ?? resolvePersistedManagerAncestry();
    const managerParentId =
      managerOwnership.kind === "manager"
        ? managerOwnership.managerThreadId
        : undefined;
    // Broken or cyclic ownership must fail closed: never expose a potentially
    // managed descendant to root merely because its persisted chain is bad.
    const isManagerOwned = managerOwnership.kind !== "none";
    const isRootManagerCompletion =
      !isManagerOwned &&
      event.agentType === AGENT_IDS.MANAGER &&
      event.type === "agent-completed";
    const rootManagerActivityPersisted =
      isRootManagerCompletion && event.eventId
        ? context.runtimeStore.hasEvent(
            event.conversationId,
            event.eventId,
            event.type,
          )
        : false;
    // Interjection-turn completions arrive twice (see
    // `AgentLifecycleEvent.audience`): `orchestrator-only` skips every
    // display surface (persisted activity row, renderer/run callbacks,
    // OS notification) so the task UI keeps reading "in progress",
    // while the deferred `display-only` replay skips the hidden
    // orchestrator follow-up that already went out.
    if (event.audience !== "orchestrator-only" && !isManagerOwned) {
      // Progress ticks are ephemeral decoration: they stream to the renderer
      // below but are never persisted — thread state lives in
      // `runtime_agents` (see `listThreadActivity`), and persisting every
      // tick grew the message table without bound.
      if (
        event.type !== "agent-progress" &&
        event.type !== "agent-message" &&
        !rootManagerActivityPersisted
      ) {
        appendAgentLifecycleChatEvent(context, event);
      }
      if (event.rootRunId && !rootManagerActivityPersisted) {
        context.state.runCallbacksByRunId
          .get(event.rootRunId)
          ?.onAgentEvent?.(event);
      }
    }
    if (event.audience === "display-only") {
      return;
    }
    if (managerOwnership.kind === "invalid") {
      return;
    }
    if (
      managerParentId &&
      (event.type === "agent-started" || event.type === "agent-progress")
    ) {
      // Starts/progress are exact-thread UI state, not instructions for the
      // Manager model. Persist a structured private row without waking the
      // Manager or exposing the descendant in root Activity/history.
      if (hasPersistedThreadEvent(context, managerParentId, event.eventId)) {
        return;
      }
      persistThreadCustomMessage(context.runtimeStore, {
        threadKey: managerParentId,
        customType: RUNTIME_PRIVATE_TASK_LIFECYCLE_CUSTOM_TYPE,
        content: [],
        display: false,
        timestamp: Date.now(),
        ...(event.eventId ? { eventId: event.eventId } : {}),
        lifecycleEvent: {
          type: event.type,
          payload: buildLifecycleEventPayload(event),
        },
      });
      return;
    }
    const userPrompt = buildAgentEventPrompt(event, {
      recipient: isManagerOwned ? "manager" : "orchestrator",
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
    if (managerParentId) {
      // Managed child reports live in the manager's durable thread and wake
      // that manager directly. They never enter the top-level orchestrator's
      // history, callbacks, or hidden follow-up stream.
      if (hasPersistedThreadEvent(context, managerParentId, event.eventId)) {
        return;
      }
      persistThreadCustomMessage(context.runtimeStore, {
        threadKey: managerParentId,
        customType: "runtime.task_lifecycle",
        content: [{ type: "text", text: userPrompt }],
        display: false,
        timestamp: Date.now(),
        ...(event.eventId ? { eventId: event.eventId } : {}),
        ...(event.type !== "agent-progress" && event.type !== "agent-message"
          ? {
              lifecycleEvent: {
                type: event.type,
                payload: buildLifecycleEventPayload(event),
              },
            }
          : {}),
      });
      void context.state.localAgentManager?.sendAgentMessage(
        managerParentId,
        userPrompt,
        "orchestrator",
        { deliveryKind: "manager-event" },
      );
      return;
    }
    // The follow-up below is in-memory delivery for the active orchestrator
    // session; this row is the durable record read by the next history rebuild.
    const isInterimMessage = event.type === "agent-message";
    const orchestratorThreadId = resolveOrchestratorThreadKey(
      event.conversationId,
    );
    const requiresStableReminder =
      Boolean(event.eventId) &&
      (isInterimMessage ||
        isRootManagerCompletion ||
        event.type === "agent-completed" ||
        event.type === "agent-failed" ||
        event.type === "agent-canceled");
    if (
      requiresStableReminder &&
      hasPersistedThreadEvent(context, orchestratorThreadId, event.eventId)
    ) {
      return;
    }
    persistThreadCustomMessage(context.runtimeStore, {
      threadKey: orchestratorThreadId,
      customType: isInterimMessage
        ? "runtime.task_update"
        : "runtime.task_lifecycle",
      content: [{ type: "text", text: userPrompt }],
      display: false,
      timestamp: Date.now(),
      ...(requiresStableReminder && event.eventId
        ? { eventId: event.eventId }
        : {}),
    });
    // Phase two of Dream report provenance: only after the terminal report
    // has durably landed in this orchestrator thread may its inbox row claim
    // that conversation. Superseded/adopted/crashed attempts never reach
    // this branch and stay NULL on the model-driven path.
    if (event.type === "agent-completed" && event.result?.trim()) {
      try {
        context.runtimeStore.dreamInboxStore.promoteThreadSummaryConversation({
          threadId: event.agentId,
          conversationId: event.conversationId,
          rolloutSummary: event.result,
        });
      } catch {
        // Best effort and fail-safe: an unpromoted row remains visible to
        // Dream's inbox and cannot be mechanically consumed by a future gate.
      }
    }
    void deps.sendMessage({
      conversationId: event.conversationId,
      text: userPrompt,
      uiVisibility: "hidden",
      agentType: AGENT_IDS.ORCHESTRATOR,
      deliverAs: "followUp",
      callbackRunId: event.rootRunId,
      customType: isInterimMessage
        ? "runtime.task_update"
        : "runtime.task_lifecycle",
      display: false,
      responseTarget: createAgentLifecycleResponseTarget({
        agentId: event.agentId,
        eventType: event.type,
      }),
    });
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
    listGroupMemberThreadIds: (groupKey) =>
      context.runtimeStore.listGroupMemberThreadIds(groupKey),
    onAgentEvent: handleAgentLifecycleEvent,
    fetchAgentContext: deps.buildAgentContext,
    ...(deps.resolveAgentModelConfig
      ? { resolveAgentModelConfig: deps.resolveAgentModelConfig }
      : {}),
    superviseAttempt: (attempt) =>
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
      abortSignal,
      subagentSession,
      onProgress,
      onStatus,
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

      const subagentFileChanges: FileChangeRecord[] = [];
      const subagentFileChangeKeys = new Set<string>();
      const subagentProducedFiles: ProducedFileRecord[] = [];
      const subagentProducedFileKeys = new Set<string>();
      // Shell sessions this run interacted with. Background/long-running
      // commands can finish after the model's last poll, so their produced
      // files never drain inline; we sweep these sessions at finalize to pull
      // late deliverables into the completion rollup.
      const touchedShellSessions = new Set<string>();
      const subagentToolExecutor = async (
        toolName: string,
        args: Record<string, unknown>,
        ctx: ToolContext,
        signal?: AbortSignal,
        onUpdate?: (update: ToolResult) => void,
      ): Promise<ToolResult> => {
        const isParallelWithShellCommands =
          toolName === "multi_tool_use_parallel" &&
          parallelContainsShellCommand(args);
        const shellSessionId =
          typeof args.session_id === "string" ? args.session_id : null;
        const result = await toolExecutor(
          toolName,
          args,
          ctx,
          signal,
          onUpdate,
        );
        const shellState = getShellExecutionState(result);
        // Remember every shell session this run touched so finalize can
        // sweep background/long-running commands that completed after their
        // last poll for undrained produced files.
        if (shellSessionId) touchedShellSessions.add(shellSessionId);
        if (shellState?.sessionId)
          touchedShellSessions.add(shellState.sessionId);
        if (isParallelWithShellCommands) {
          for (const sessionId of getParallelRunningShellSessions(result)) {
            touchedShellSessions.add(sessionId);
          }
        }
        return result;
      };
      const result = await runSubagentTask({
        conversationId,
        storageMode: persistToConvex ? "cloud" : "local",
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
          includeDeferred: true,
        }),
        toolExecutor: subagentToolExecutor,
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
                onStream: (event) => runnerCallbacks.onStream(event),
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
            collectFileChanges(
              subagentFileChanges,
              subagentFileChangeKeys,
              event.fileChanges?.length ? event : event.details,
            );
            collectProducedFiles(
              subagentProducedFiles,
              subagentProducedFileKeys,
              event.producedFiles?.length ? event : event.details,
            );
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
      });
      // Late/background flush: long-running shell commands (e.g. video
      // renders) can finish after the model's last poll, so their produced
      // files were never drained inline and would ride only individual
      // tool_result entries — missing from the completion rollup that both
      // desktop and mobile source exclusively. Sweep the sessions this run
      // touched for completed-but-unreported deliverables and merge them
      // (dedup + noise/MAX guards preserved by the shell drain) before the
      // rollup assembles off `result.producedFiles`.
      if (touchedShellSessions.size > 0) {
        try {
          const late = await context.toolHost.drainCompletedShellProducedFiles([
            ...touchedShellSessions,
          ]);
          if (late.files.length > 0) {
            collectProducedFiles(
              subagentProducedFiles,
              subagentProducedFileKeys,
              { producedFiles: late.files },
            );
          }
          // The cap withheld a background batch. It reaches the rollup as a
          // count rather than as files, because there is nothing to attach.
          if (late.omitted) {
            result.producedFilesOmitted = late.omitted;
          }
        } catch (error) {
          console.warn(
            "[produced-files] late background shell drain failed (continuing):",
            (error as Error).message,
          );
        }
      }
      if (subagentFileChanges.length > 0) {
        result.fileChanges = subagentFileChanges;
      }
      if (subagentProducedFiles.length > 0) {
        result.producedFiles = subagentProducedFiles;
      }
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
    createCloudAgentRecord: deps.cloudAgentRecords.create,
    completeCloudAgentRecord: deps.cloudAgentRecords.complete,
    getCloudAgentRecord: deps.cloudAgentRecords.get,
    cancelCloudAgentRecord: deps.cloudAgentRecords.cancel,
    saveAgentRecord: (record) => {
      context.runtimeStore.saveAgentRecord?.(record);
      // Every thread transition funnels through here — this push is what
      // keeps the renderer's authoritative Activity store current.
      context.notifyThreadActivityUpdated?.(record.conversationId);
    },
    getAgentRecord: (threadId) =>
      context.runtimeStore.getAgentRecord?.(threadId) ?? null,
    listAgentRecordsByStatus: (status) =>
      context.runtimeStore.listAgentRecordsByStatus?.(status) ?? [],
    persistBootInterruptionSnapshot: (threads) =>
      writeRestartInterruptedSnapshot(context.stellaDataDir, threads),
    hasAgentLifecycleEvent: (conversationId, eventId, type) => {
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
      if (type === "agent-completed") {
        // A Manager completion is delivered only when both durable artifacts
        // exist. Recovery re-enters the idempotent lifecycle handler to repair
        // either half of an interrupted two-write completion.
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
    const { threadId } = await context.state.localAgentManager.createAgent({
      ...request,
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
    return await context.state.localAgentManager.cancelAgent(agentId, reason);
  };

  const shutdown = async (): Promise<void> => {
    await context.state.localAgentManager?.shutdown();
    shutdownSubagentRuntimes();
  };

  return {
    runBlockingLocalAgent,
    createBackgroundAgent,
    cancelLocalAgent,
    handleExternalAgentLifecycleEvent: handleAgentLifecycleEvent,
    hasDurableExternalLifecycleEvent: (event: AgentLifecycleEvent) => {
      if (!event.eventId) return false;
      if (event.audience === "orchestrator-only") {
        return hasPersistedThreadEvent(
          context,
          resolveOrchestratorThreadKey(event.conversationId),
          event.eventId,
        );
      }
      const hasActivityEvent = context.runtimeStore.hasEvent(
        event.conversationId,
        event.eventId,
        event.type,
      );
      if (event.type === "agent-started") {
        return hasActivityEvent;
      }
      return (
        hasActivityEvent &&
        hasPersistedThreadEvent(
          context,
          resolveOrchestratorThreadKey(event.conversationId),
          event.eventId,
        )
      );
    },
    shutdown,
  };
};
