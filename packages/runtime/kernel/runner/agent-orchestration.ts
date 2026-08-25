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
import type { LocalChatEventRecord } from "../storage/shared.js";
import type { ThreadActivityRecord } from "@stella/contracts/local-chat";
import { createRunnerImageDescriptionService } from "./model-selection.js";

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

      const subagentFileChanges: FileChangeRecord[] = [];
      const subagentFileChangeKeys = new Set<string>();
      const subagentProducedFiles: ProducedFileRecord[] = [];
      const subagentProducedFileKeys = new Set<string>();

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
        toolExecutor: subagentToolExecutor,
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

            runnerCallbacks?.onToolEnd(agentId ? { ...event, agentId } : event);
          },
        },
        hookEmitter: context.hookEmitter,
      }).finally(() => context.toolHost.endBrowserTurn(runId, "close-tabs"));

      if (touchedShellSessions.size > 0) {
        try {
          const lateProducedFiles =
            await context.toolHost.drainCompletedShellProducedFiles([
              ...touchedShellSessions,
            ]);
          if (lateProducedFiles.length > 0) {
            collectProducedFiles(
              subagentProducedFiles,
              subagentProducedFileKeys,
              { producedFiles: lateProducedFiles },
            );
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
