import { createRuntimeLogger } from "../debug.js";
import { compactRuntimeThreadHistory } from "./thread-memory.js";
import {
  ACTIVE_THREAD_IMAGE_DECODED_BYTE_BUDGET,
  MAX_ACTIVE_THREAD_IMAGES,
} from "../thread-runtime.js";
import { isThreadCompactionForced } from "./context-budget.js";
import { resetSkillReadDedup } from "../tools/skill-read-dedup.js";
import { isOrchestratorAgentType } from "@stella/contracts/agent-runtime";
const logger = createRuntimeLogger("agent-runtime.completion");
const FINALIZE_STAGE_TIMEOUT_MS = 30_000;
const boundedFinalizeStage = async (args) => {
  let timer;
  const startedAt = Date.now();
  try {
    return await Promise.race([
      Promise.resolve(args.work()),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          logger.warn("orchestrator.finalize-stage-timeout", {
            stage: args.stage,
            runId: args.runId,
            timeoutMs: FINALIZE_STAGE_TIMEOUT_MS,
          });
          console.warn(
            `[runtime] Run finalization stage "${args.stage}" exceeded ${Math.round(FINALIZE_STAGE_TIMEOUT_MS / 1000)}s; finishing the run without it (run ${args.runId}).`,
          );
          resolve(args.fallback);
        }, FINALIZE_STAGE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > 5_000) {
      logger.warn("orchestrator.finalize-stage-slow", {
        stage: args.stage,
        runId: args.runId,
        elapsedMs,
      });
    }
  }
};
const REPORTED_ORCHESTRATOR_ERROR = Symbol("reportedOrchestratorError");
const INTERRUPT_MESSAGE_RE =
  /^(?:aborted|request was aborted\.?|request aborted by user|interrupted by .+|canceled(?: because .*)?|this operation was aborted|claude code run aborted\.?)$/i;
const safeErrorMessage = (error, fallback) =>
  error instanceof Error ? error.message || fallback : fallback;
const normalizeInterruptionReason = (value) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.toLowerCase() === "this operation was aborted") {
    return "Canceled";
  }
  if (
    /^(?:aborted|request was aborted\.?|request aborted by user|claude code run aborted\.?)$/i.test(
      trimmed,
    )
  ) {
    return "Canceled";
  }
  return trimmed;
};
export const resolveInterruptionReason = (args) => {
  const signalReason = args.abortSignal?.aborted
    ? (normalizeInterruptionReason(
        args.abortSignal.reason instanceof Error
          ? args.abortSignal.reason.message
          : typeof args.abortSignal.reason === "string"
            ? args.abortSignal.reason
            : undefined,
      ) ?? "Canceled")
    : null;
  if (signalReason) {
    return signalReason;
  }
  const message = safeErrorMessage(args.error, "").trim();
  if (!message || !INTERRUPT_MESSAGE_RE.test(message)) {
    return null;
  }
  return normalizeInterruptionReason(message) ?? "Canceled";
};
export const markOrchestratorErrorReported = (error) => {
  const normalized =
    error instanceof Error
      ? error
      : new Error(safeErrorMessage(error, "Stella runtime failed"));
  Object.defineProperty(normalized, REPORTED_ORCHESTRATOR_ERROR, {
    value: true,
    configurable: true,
  });
  return normalized;
};
export const isReportedOrchestratorError = (error) =>
  error instanceof Error && Boolean(error[REPORTED_ORCHESTRATOR_ERROR]);
const emitAgentEndHook = async (opts, args) => {
  if (!opts.hookEmitter) {
    return;
  }
  try {
    await opts.hookEmitter.emit(
      "agent_end",
      {
        agentType: opts.agentType,
        finalText: args.finalText,
        outcome: "success",
        conversationId: opts.conversationId,
        threadKey: args.threadKey,
        runId: args.runId,
        ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
        isUserTurn: opts.uiVisibility !== "hidden",
        services: {
          resolvedLlm: opts.resolvedLlm,
          ...(opts.appendLocalChatEvent
            ? { appendLocalChatEvent: opts.appendLocalChatEvent }
            : {}),
          ...(opts.listLocalChatEvents
            ? { listLocalChatEvents: opts.listLocalChatEvents }
            : {}),
          ...(opts.resolveSubsidiaryLlmRoute
            ? { resolveSubsidiaryLlmRoute: opts.resolveSubsidiaryLlmRoute }
            : {}),
        },
      },
      { agentType: opts.agentType },
    );
  } catch {
    return;
  }
};
const emitAgentEndCleanup = (opts, args) => {
  if (!opts.hookEmitter) return;
  void opts.hookEmitter
    .emit(
      "agent_end",
      {
        agentType: opts.agentType,
        finalText: args.finalText ?? "",
        outcome: args.outcome,
        conversationId: opts.conversationId,
        threadKey: args.threadKey,
        runId: args.runId,
        ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
        isUserTurn: opts.uiVisibility !== "hidden",
      },
      { agentType: opts.agentType },
    )
    .catch(() => undefined);
};
const emitSubagentAgentEnd = (opts, args) => {
  if (!opts.hookEmitter) return;
  void opts.hookEmitter
    .emit(
      "agent_end",
      {
        agentType: opts.agentType,
        finalText: args.finalText,
        outcome: args.outcome,
        conversationId: opts.conversationId,
        threadKey: args.threadKey,
        runId: args.runId,
        ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
        isUserTurn: opts.uiVisibility !== "hidden",
        ...(args.sideEffectsAllowed
          ? {
              services: {
                resolvedLlm: opts.resolvedLlm,
                ...(opts.appendLocalChatEvent
                  ? { appendLocalChatEvent: opts.appendLocalChatEvent }
                  : {}),
                ...(opts.listLocalChatEvents
                  ? { listLocalChatEvents: opts.listLocalChatEvents }
                  : {}),
                ...(opts.resolveSubsidiaryLlmRoute
                  ? {
                      resolveSubsidiaryLlmRoute: opts.resolveSubsidiaryLlmRoute,
                    }
                  : {}),
              },
            }
          : {}),
      },
      { agentType: opts.agentType },
    )
    .catch(() => undefined);
};
export const runCompactionWithHooks = async (args) => {
  let shouldCompact = true;
  let hookCompaction;
  const pressure =
    typeof args.opts.store.getThreadContextPressureStats === "function"
      ? args.opts.store.getThreadContextPressureStats(args.threadKey)
      : null;
  const hardImagePressure =
    pressure?.complete === true &&
    (pressure.imageCount > MAX_ACTIVE_THREAD_IMAGES ||
      pressure.imageDecodedBytes > ACTIVE_THREAD_IMAGE_DECODED_BYTE_BUDGET);
  if (args.opts.hookEmitter) {
    const hookResult = await args.opts.hookEmitter
      .emit(
        "before_compact",
        {
          agentType: args.opts.agentType,
          messageCount: args.messageCount,
          conversationId: args.opts.conversationId,
          threadKey: args.threadKey,
          runId: args.runId,
          ...(args.opts.uiVisibility
            ? { uiVisibility: args.opts.uiVisibility }
            : {}),
          isUserTurn: args.opts.uiVisibility !== "hidden",
        },
        { agentType: args.opts.agentType },
      )
      .catch(() => undefined);
    if (
      hookResult?.cancel &&
      !hardImagePressure &&
      !isThreadCompactionForced(args.threadKey)
    ) {
      shouldCompact = false;
    }
    const summary = hookResult?.compaction?.summary?.trim();
    if (summary) {
      hookCompaction = {
        summary,
        ...(hookResult?.compaction?.preserveLastN !== undefined
          ? { preserveLastN: hookResult.compaction.preserveLastN }
          : {}),
      };
    }
  }
  if (!shouldCompact) {
    return { compacted: false };
  }
  const result = await compactRuntimeThreadHistory({
    store: args.opts.store,
    threadKey: args.threadKey,
    resolvedLlm: args.opts.resolvedLlm,
    agentType: args.opts.agentType,
    stellaDataDir: args.opts.stellaDataDir,
    ...(hookCompaction
      ? {
          overrideSummary: hookCompaction.summary,
          ...(hookCompaction.preserveLastN !== undefined
            ? { preserveLastN: hookCompaction.preserveLastN }
            : {}),
        }
      : {}),
  });
  if (result.compacted && isOrchestratorAgentType(args.opts.agentType)) {
    args.opts.store.forceOrchestratorReminderOnNextTurn?.(
      args.opts.conversationId,
    );
  }
  if (result.compacted && args.opts.hookEmitter && hookCompaction?.summary) {
    void args.opts.hookEmitter
      .emit(
        "session_compact",
        {
          agentType: args.opts.agentType,
          summary: hookCompaction.summary,
          ...(hookCompaction.preserveLastN !== undefined
            ? { preserveLastN: hookCompaction.preserveLastN }
            : {}),
          fromHook: true,
          conversationId: args.opts.conversationId,
          threadKey: args.threadKey,
          runId: args.runId,
        },
        { agentType: args.opts.agentType },
      )
      .catch(() => undefined);
  }
  return result;
};
export const finalizeOrchestratorSuccess = async (args) => {
  logger.debug("orchestrator.end", {
    runId: args.runId,
    agentType: args.opts.agentType,
    finalTextPreview: args.finalText.slice(0, 300),
  });
  const runBeforeRunEnd = () =>
    Promise.resolve(
      args.opts.beforeRunEnd?.({
        runId: args.runId,
        threadKey: args.threadKey,
        finalText: args.finalText,
        outcome: "success",
      }),
    );
  await boundedFinalizeStage({
    stage: "beforeRunEnd",
    runId: args.runId,
    fallback: undefined,
    work: runBeforeRunEnd,
  });
  await boundedFinalizeStage({
    stage: "agent_end-hooks",
    runId: args.runId,
    fallback: undefined,
    work: () =>
      emitAgentEndHook(args.opts, {
        finalText: args.finalText,
        runId: args.runId,
        threadKey: args.threadKey,
      }),
  });
  args.opts.callbacks.onEnd(
    args.runEvents.recordRunEnd({
      finalText: args.finalText,
      ...(args.responseTarget ? { responseTarget: args.responseTarget } : {}),
    }),
  );
  if (args.finalText.trim()) {
    void args.opts.compactionScheduler.schedule({
      threadKey: args.threadKey,
      run: async () => {
        const { compacted } = await runCompactionWithHooks({
          opts: args.opts,
          threadKey: args.threadKey,
          runId: args.runId,
          messageCount: args.agent.state.messages.length,
        });
        if (compacted) {
          args.opts.orchestratorSession?.notifyCompacted();
        }
      },
    });
  }
};
export const finalizeOrchestratorError = (args) => {
  const errorMessage = safeErrorMessage(args.error, "Stella runtime failed");
  args.opts.callbacks.onError(args.runEvents.recordError(errorMessage));
  if (args.runId && args.threadKey) {
    emitAgentEndCleanup(args.opts, {
      runId: args.runId,
      threadKey: args.threadKey,
      outcome: "error",
      finalText: errorMessage,
    });
  }
  return errorMessage;
};
export const finalizeOrchestratorInterrupted = (args) => {
  args.opts.callbacks.onInterrupted?.(
    args.runEvents.recordInterrupted(args.reason),
  );
  if (args.runId && args.threadKey) {
    emitAgentEndCleanup(args.opts, {
      runId: args.runId,
      threadKey: args.threadKey,
      outcome: "interrupted",
      finalText: args.reason,
    });
  }
  return args.reason;
};
export const SUBAGENT_EMPTY_RESULT_SENTINEL =
  "(Agent completed without a user-visible reply. Re-prompt with send_input if you need the outcome.)";
export const finalizeSubagentSuccess = async (args) => {
  const trimmedResult = args.result.trim();
  const resolvedResult = trimmedResult || SUBAGENT_EMPTY_RESULT_SENTINEL;
  const sideEffectsAllowed = !args.opts.suppressCompletionSideEffects;
  emitSubagentAgentEnd(args.opts, {
    runId: args.runId,
    threadKey: args.threadKey,
    outcome: "success",
    finalText: resolvedResult,
    sideEffectsAllowed,
  });
  if (!args.opts.suppressCompletionSideEffects) {
    args.opts.callbacks?.onEnd?.(
      args.runEvents.recordRunEnd({ finalText: resolvedResult }),
    );
  }
  if (trimmedResult) {
    const messageCount = args.agentMessageCount ?? 0;
    void args.opts.compactionScheduler.schedule({
      threadKey: args.threadKey,
      run: async () => {
        const { compacted } = await runCompactionWithHooks({
          opts: args.opts,
          threadKey: args.threadKey,
          runId: args.runId,
          messageCount,
        });
        if (compacted) {
          resetSkillReadDedup(args.threadKey);
          args.opts.subagentSession?.notifyCompacted();
        }
      },
    });
  }
  return {
    runId: args.runId,
    result: resolvedResult,
  };
};
export const finalizeSubagentError = (args) => {
  const errorMessage = safeErrorMessage(args.error, "Subagent failed");
  args.opts.callbacks?.onError?.(args.runEvents.recordError(errorMessage));
  if (args.threadKey) {
    emitSubagentAgentEnd(args.opts, {
      runId: args.runId,
      threadKey: args.threadKey,
      outcome: "error",
      finalText: errorMessage,
      sideEffectsAllowed: false,
    });
  }
  return {
    runId: args.runId,
    result: "",
    error: errorMessage,
  };
};
export const finalizeSubagentInterrupted = (args) => {
  args.opts.callbacks?.onInterrupted?.(
    args.runEvents.recordInterrupted(args.reason),
  );
  if (args.threadKey) {
    emitSubagentAgentEnd(args.opts, {
      runId: args.runId,
      threadKey: args.threadKey,
      outcome: "interrupted",
      finalText: args.reason,
      sideEffectsAllowed: false,
    });
  }
  return {
    runId: args.runId,
    result: "",
    interrupted: true,
  };
};
