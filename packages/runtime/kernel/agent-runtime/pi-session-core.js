import { cleanupSessionResources } from "../../ai/session-resources.js";
import { createRuntimeLogger } from "../debug.js";
import {
  buildSafetyAbortSwapRoute,
  isProviderContentAbortMessage,
  parseQuarantineRecord,
  ProviderAbortContainment,
  QUARANTINE_CUSTOM_TYPE,
} from "./provider-abort-containment.js";
import { createRuntimeAgent, resolveAgentThinkingLevel } from "./shared.js";
import { buildHistorySource } from "./thread-memory.js";
import {
  ACTIVE_THREAD_IMAGE_DECODED_BYTE_BUDGET,
  getCompactionTriggerTokens,
  getThreadTokenEstimate,
  MAX_ACTIVE_THREAD_IMAGES,
} from "../thread-runtime.js";
import {
  CONTEXT_DELTA_CUSTOM_TYPE_PREFIX,
  PINNED_INSTRUCTION_ENTRY_ID_MARKER,
} from "./resident-context.js";
import {
  checkPromptPrefixStability,
  clearPromptPrefixSnapshot,
} from "./prompt-prefix-guard.js";
import {
  clearProviderContextWindow,
  estimateProviderPayloadTokens,
  getLastProviderPayloadTokens,
  getProviderPayloadImageStats,
  providerInputBudgetTokens,
  setProviderContextWindow,
  withForcedThreadCompaction,
} from "./context-budget.js";
import { runCompactionWithHooks } from "./run-completion.js";

const ORCHESTRATOR_COMPACTION_BLOCK_WINDOW_FRACTION = 0.9;
const awaitUnlessAborted = async (promise, signal) => {
  if (!signal) {
    await promise;
    return true;
  }
  if (signal.aborted) return false;
  let onAbort;
  const aborted = new Promise((resolve) => {
    onAbort = () => resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise.then(() => true), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};
const resolveCodexProviderServiceTier = (resolvedLlm, agentContext) => {
  const snapshot = agentContext.modelConfigSnapshot;
  if (
    snapshot?.engine !== "codex_cli" ||
    resolvedLlm.model.api !== "openai-codex-responses"
  ) {
    return undefined;
  }

  return snapshot.serviceTier === "fast" ? "priority" : undefined;
};
const safeSchemaJson = (value) => {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
};
const durableComparableMessage = (message) => {
  if (message?.role === "assistant") {
    const {
      stellaRunId: _runId,
      stellaAttemptGeneration: _attemptGeneration,
      ...comparable
    } = message;
    return comparable;
  }
  if (message?.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content,
      ...(typeof message.modelOutputTokens === "number"
        ? { modelOutputTokens: message.modelOutputTokens }
        : {}),
      isError: message.isError,
      timestamp: message.timestamp,
    };
  }
  if (message?.role === "runtimeInternal") {
    return {
      role: "runtimeInternal",
      content: message.content,
      timestamp: message.timestamp,
      ...(message.customType ? { customType: message.customType } : {}),

      display: message.display === true,
    };
  }
  return message;
};
const hasExactDurableCompletedSuffix = (history, completedMessages) => {
  if (
    completedMessages.length === 0 ||
    completedMessages.length > history.length
  ) {
    return false;
  }
  const offset = history.length - completedMessages.length;
  return completedMessages.every(
    (message, index) =>
      safeSchemaJson(durableComparableMessage(history[offset + index])) ===
      safeSchemaJson(durableComparableMessage(message)),
  );
};
const hasExactDurableRawTail = (args) => {
  if (typeof args.store.findLatestRangeCompaction !== "function") {
    return true;
  }
  const compaction = args.store.findLatestRangeCompaction(args.threadKey);
  const checkpointId = compaction?.entry?.id;
  if (!checkpointId) {
    return false;
  }
  const checkpointIndex = args.threadHistory.findIndex(
    (entry) => entry.entryId === checkpointId,
  );
  if (checkpointIndex < 0) {
    return false;
  }
  const rawTailEntries = args.threadHistory
    .slice(checkpointIndex + 1)
    .filter(
      (entry) => !entry.entryId?.includes(PINNED_INSTRUCTION_ENTRY_ID_MARKER),
    );
  const durableRawTail = buildHistorySource({
    ...args.agentContext,
    threadHistory: rawTailEntries,
  });
  const rawTailLength = durableRawTail.length;
  if (
    rawTailLength > args.residentMessages.length ||
    rawTailLength > args.refreshedMessages.length
  ) {
    return false;
  }
  const residentOffset = args.residentMessages.length - rawTailLength;
  const refreshedOffset = args.refreshedMessages.length - rawTailLength;
  for (let index = 0; index < rawTailLength; index += 1) {
    const durable = safeSchemaJson(
      durableComparableMessage(durableRawTail[index]),
    );
    if (
      safeSchemaJson(
        durableComparableMessage(
          args.refreshedMessages[refreshedOffset + index],
        ),
      ) !== durable ||
      safeSchemaJson(
        durableComparableMessage(args.residentMessages[residentOffset + index]),
      ) !== durable
    ) {
      return false;
    }
  }
  return true;
};

const snapshotToolSchemas = (tools) =>
  new Map(
    (tools ?? []).map((tool) => [
      tool.name,
      {
        description: tool.description,
        parameters: tool.parameters,
        parametersJson: safeSchemaJson(tool.parameters),
      },
    ]),
  );

export class PiSessionCore {
  logger;
  agent = null;
  currentResolvedLlm = null;
  pendingHistoryRefresh = false;
  lastMemoryEnabled = null;

  frozenSystemPrompt = null;
  frozenToolSchemas = null;
  adoptFreshContextSnapshot = false;

  announcedToolDriftSignature = null;

  pendingContextDeltaMessages = [];

  abortContainment = new ProviderAbortContainment();
  threadKey;
  promptCacheKey;
  constructor(opts) {
    this.threadKey = opts.threadKey;
    this.promptCacheKey = opts.promptCacheKey;
    this.logger = createRuntimeLogger(opts.loggerName);
  }
  get hasAgent() {
    return this.agent !== null;
  }
  get canSteerLiveAgent() {
    return this.agent?.state.isStreaming === true;
  }

  steerLiveAgent(message) {
    if (!this.canSteerLiveAgent || !this.agent) return false;
    this.agent.steer(message);
    return true;
  }

  notifyCompacted() {
    if (!this.agent) return;
    this.pendingHistoryRefresh = true;
  }

  notifyHistoryChanged() {
    this.pendingHistoryRefresh = true;
  }
  setResolvedLlm(resolvedLlm) {
    this.currentResolvedLlm = resolvedLlm;
    setProviderContextWindow(this.threadKey, resolvedLlm.model.contextWindow);
  }
  refreshHistoryIfNeeded(agentContext, logContext) {
    if (!this.pendingHistoryRefresh || !this.agent) return;
    const refreshed = buildHistorySource(agentContext);
    this.agent.state.messages = refreshed;
    this.pendingHistoryRefresh = false;

    this.adoptFreshContextSnapshot = true;
    this.logger.debug("history-refreshed", {
      threadKey: this.threadKey,
      historyLength: refreshed.length,
      ...logContext,
    });
  }

  refreshHistoryFromStoreIfNeeded(agentContext, store, logContext) {
    if (!this.pendingHistoryRefresh || !this.agent) return agentContext;
    const refreshedContext = {
      ...agentContext,
      threadHistory: store.loadThreadMessages(this.threadKey),
    };
    this.refreshHistoryIfNeeded(refreshedContext, logContext);
    return refreshedContext;
  }

  async refreshActiveWorkingSetAtBoundary(args) {
    const agent = this.agent;
    const scheduler = args.opts.compactionScheduler;
    if (!agent || !scheduler || args.signal?.aborted) return undefined;
    let measuredTokens = 0;
    const liveImages = getProviderPayloadImageStats({
      messages: args.messages,
    });
    const imagePressure =
      liveImages.count > MAX_ACTIVE_THREAD_IMAGES ||
      liveImages.decodedBytes > ACTIVE_THREAD_IMAGE_DECODED_BYTE_BUDGET;
    if (!this.pendingHistoryRefresh) {
      try {
        const lastProviderTokens = getLastProviderPayloadTokens(this.threadKey);
        if (lastProviderTokens === undefined) {
          const narrow =
            typeof args.opts.store.getThreadContextPressureStats === "function"
              ? args.opts.store.getThreadContextPressureStats(this.threadKey)
              : null;

          measuredTokens = narrow?.complete
            ? narrow.estimatedTokens
            : narrow
              ? estimateProviderPayloadTokens(
                  { messages: args.messages },
                  Number.POSITIVE_INFINITY,
                )
              : getThreadTokenEstimate(
                  args.opts.store.loadThreadMessages(this.threadKey),
                );
        } else {

          measuredTokens =
            lastProviderTokens +
            estimateProviderPayloadTokens(
              { messages: args.completedMessages },
              Number.POSITIVE_INFINITY,
            );
        }
      } catch {

        return undefined;
      }
      const triggerTokens = getCompactionTriggerTokens(
        args.opts.resolvedLlm,
        args.opts.agentType,
      );
      if (!imagePressure && measuredTokens < triggerTokens) return undefined;
      args.onCompacting?.();
    }
    try {

      let pending = scheduler.pending(this.threadKey);
      while (pending) {
        if (!(await awaitUnlessAborted(pending, args.signal))) return undefined;
        pending = scheduler.pending(this.threadKey);
      }
      if (this.agent !== agent || args.signal?.aborted) return undefined;
      if (!this.pendingHistoryRefresh) {
        let compacted = false;
        const inputBudget = providerInputBudgetTokens(
          args.opts.resolvedLlm.model.contextWindow,
        );
        const runCompaction = () =>
          runCompactionWithHooks({
            opts: args.opts,
            threadKey: this.threadKey,
            runId: args.runId,
            messageCount: args.messages.length,
          });
        const scheduled = scheduler.schedule({
          threadKey: this.threadKey,
          run: async () => {
            const result =
              imagePressure || (inputBudget && measuredTokens >= inputBudget)
                ? await withForcedThreadCompaction(
                    this.threadKey,
                    runCompaction,
                  )
                : await runCompaction();
            compacted = result.compacted;
            if (compacted) {
              this.notifyCompacted();
            }
          },
        });
        if (!(await awaitUnlessAborted(scheduled, args.signal)))
          return undefined;
        if (!compacted || !this.pendingHistoryRefresh) {
          return undefined;
        }
      }
      if (this.agent !== agent || args.signal?.aborted) return undefined;

      if (args.canApply && !args.canApply()) return undefined;
      const threadHistory = args.opts.store.loadThreadMessages(this.threadKey);
      const refreshedContext = {
        ...args.agentContext,
        threadHistory,
      };
      const refreshed = buildHistorySource(refreshedContext);
      this.abortContainment.reapplyQuarantine(refreshed);

      const completedSuffixExact = hasExactDurableCompletedSuffix(
        refreshed,
        args.completedMessages,
      );
      const currentTurnSuffixExact =
        !args.requiredResidentSuffix ||
        hasExactDurableCompletedSuffix(refreshed, args.requiredResidentSuffix);
      const rawTailExact = hasExactDurableRawTail({
        store: args.opts.store,
        threadKey: this.threadKey,
        threadHistory,
        agentContext: refreshedContext,
        residentMessages: args.messages,
        refreshedMessages: refreshed,
      });
      if (!completedSuffixExact || !currentTurnSuffixExact || !rawTailExact) {
        this.logger.warn("active-working-set-durable-tail-mismatch", {
          threadKey: this.threadKey,
          historyLength: refreshed.length,
          completedMessages: args.completedMessages.length,
          completedSuffixExact,
          currentTurnSuffixExact,
          rawTailExact,
          ...args.logContext,
        });
        return undefined;
      }
      this.pendingHistoryRefresh = false;
      this.adoptFreshContextSnapshot = true;
      checkPromptPrefixStability({
        threadKey: this.threadKey,
        systemPrompt: agent.state.systemPrompt,
        tools: agent.state.tools,
        messages: refreshed,
        boundary: true,
        logger: this.logger,
      });
      this.logger.debug("active-working-set-refreshed", {
        threadKey: this.threadKey,
        priorMessages: args.messages.length,
        historyLength: refreshed.length,
        ...args.logContext,
      });

      args.agentContext.threadHistory = threadHistory;
      return refreshed;
    } catch (error) {
      this.logger.warn("active-working-set-refresh-failed", {
        threadKey: this.threadKey,
        error: error instanceof Error ? error.message : String(error),
        ...args.logContext,
      });
      return undefined;
    }
  }

  async maybeCompactForModelSwitch(args) {
    const previous = this.currentResolvedLlm;
    const next = args.opts.resolvedLlm;
    const scheduler = args.opts.compactionScheduler;
    if (!previous || !next || !scheduler) return;
    const previousWindow = Number(previous.model.contextWindow);
    const nextWindow = Number(next.model.contextWindow);
    if (
      !Number.isFinite(previousWindow) ||
      !Number.isFinite(nextWindow) ||
      nextWindow >= previousWindow
    ) {
      return;
    }
    const blockThresholdTokens = providerInputBudgetTokens(nextWindow);
    if (!blockThresholdTokens) return;
    const measureTokens = () => {
      const historyTokens = getThreadTokenEstimate(
        args.opts.store.loadThreadMessages(this.threadKey),
      );
      return Math.max(
        historyTokens,
        getLastProviderPayloadTokens(this.threadKey) ?? 0,
      );
    };
    let measuredTokens;
    try {
      measuredTokens = measureTokens();
    } catch {

      return;
    }
    if (measuredTokens < blockThresholdTokens) return;
    this.logger.warn("compaction.model-switch-shrink", {
      threadKey: this.threadKey,
      fromModel: previous.model.id,
      toModel: next.model.id,
      fromWindow: previousWindow,
      toWindow: nextWindow,
      measuredTokens,
      ...args.logContext,
    });
    args.onCompacting?.();
    try {

      let pending = scheduler.pending(this.threadKey);
      while (pending) {
        await pending;
        pending = scheduler.pending(this.threadKey);
      }
      try {
        measuredTokens = measureTokens();
      } catch {
        return;
      }
      if (measuredTokens < blockThresholdTokens) return;

      await scheduler.schedule({
        threadKey: this.threadKey,
        run: async () => {
          const { compacted } = await withForcedThreadCompaction(
            this.threadKey,
            () =>
              runCompactionWithHooks({
                opts: { ...args.opts, resolvedLlm: previous },
                threadKey: this.threadKey,
                runId: args.runId,
                messageCount: this.agent?.state.messages.length ?? 0,
              }),
          );
          if (compacted) {
            this.notifyCompacted();
          }
        },
      });
    } catch {

    }
  }
  async awaitPendingCompactionBeforeTurn(args) {
    const scheduler = args.compactionScheduler;
    if (!scheduler || typeof scheduler.pending !== "function") return;
    if (!scheduler.pending(this.threadKey)) return;
    if (args.mode === "guard") {
      const window = Number(args.resolvedLlm?.model?.contextWindow);
      if (!Number.isFinite(window) || window <= 0) return;
      let estimate;
      let imagePressure = false;
      let imageCount = 0;
      try {
        const narrow =
          typeof args.store.getThreadContextPressureStats === "function"
            ? args.store.getThreadContextPressureStats(this.threadKey)
            : null;
        if (narrow?.complete) {
          estimate = narrow.estimatedTokens;
          imageCount = narrow.imageCount;
          imagePressure =
            narrow.imageCount > MAX_ACTIVE_THREAD_IMAGES ||
            narrow.imageDecodedBytes > ACTIVE_THREAD_IMAGE_DECODED_BYTE_BUDGET;
        } else {
          const history = args.store.loadThreadMessages(this.threadKey);
          estimate = getThreadTokenEstimate(history);
          const images = getProviderPayloadImageStats({ messages: history });
          imageCount = images.count;
          imagePressure =
            images.count > MAX_ACTIVE_THREAD_IMAGES ||
            images.decodedBytes > ACTIVE_THREAD_IMAGE_DECODED_BYTE_BUDGET;
        }
      } catch {

        return;
      }
      if (
        !imagePressure &&
        estimate < window * ORCHESTRATOR_COMPACTION_BLOCK_WINDOW_FRACTION
      )
        return;
      this.logger.warn("compaction.block-imminent-overflow", {
        threadKey: this.threadKey,
        estimatedTokens: estimate,
        contextWindow: window,
        imagePressure,
        imageCount,
        ...args.logContext,
      });
    } else {
      this.logger.debug("compaction.block-agent-turn", {
        threadKey: this.threadKey,
        ...args.logContext,
      });
    }

    args.onCompacting?.();
    try {

      let pending = scheduler.pending(this.threadKey);
      while (pending) {
        await pending;
        pending = scheduler.pending(this.threadKey);
      }
    } catch {

    }
  }

  beginAbortContainmentTurn(agent, agentContext, logContext) {
    const persisted = (agentContext.threadHistory ?? [])
      .map((entry) =>
        entry.customMessage?.customType === QUARANTINE_CUSTOM_TYPE
          ? parseQuarantineRecord(entry.customMessage.content)
          : null,
      )
      .filter((record) => record !== null);
    if (persisted.length > 0) {
      this.abortContainment.seedQuarantined(persisted);
    }
    const application = this.abortContainment.applyQuarantine(
      agent.state.messages,
    );
    if (application.newlyQuarantined || application.reappliedKeys.length > 0) {
      this.logger.warn("provider-abort-quarantine", {
        threadKey: this.threadKey,
        reapplied: application.reappliedKeys,
        newlyQuarantined: application.newlyQuarantined,
        consecutiveInstantAborts:
          this.abortContainment.consecutiveInstantAbortCount,
        ...logContext,
      });
    }
    return {
      messagesBefore: agent.state.messages.length,
      failureMessagesBefore: agent.state.messages.length,
      newlyQuarantined: application.newlyQuarantined,
    };
  }

  prepareSafetyModelSwap(agent, args) {
    if (!this.currentResolvedLlm) return null;
    if (!isProviderContentAbortMessage(args.errorMessage)) return null;
    const swap = buildSafetyAbortSwapRoute(this.currentResolvedLlm);
    if (!swap) return null;
    if (!this.popErroredTailForResume(agent)) return null;
    this.dropDurableErroredTailForRetry(args.store, args.runId);
    this.setResolvedLlm(swap.route);
    agent.state.model = swap.route.model;
    this.logger.warn("safety-model-swap", {
      threadKey: this.threadKey,
      fromModel: swap.fromModelId,
      toModel: swap.toModelId,
      providerError: args.errorMessage,
      ...args.logContext,
    });
    return swap;
  }

  prepareSafetySameModelRetry(agent, args) {
    if (!this.currentResolvedLlm) return null;
    if (!isProviderContentAbortMessage(args.errorMessage)) return null;
    if (!buildSafetyAbortSwapRoute(this.currentResolvedLlm)) return null;
    if (!this.popErroredTailForResume(agent)) return null;
    this.dropDurableErroredTailForRetry(args.store, args.runId);
    const modelId = this.currentResolvedLlm.model.id;
    this.logger.warn("safety-same-model-retry", {
      threadKey: this.threadKey,
      model: modelId,
      providerError: args.errorMessage,
      ...args.logContext,
    });
    return { modelId };
  }

  prepareAgentRunRetry(agent, args) {
    if (!args.failure.retryable) return false;
    if (
      !this.popErroredTailForResume(agent, {
        allowEmpty: args.failure.category === "empty_response",
      })
    ) {
      return false;
    }
    this.dropDurableErroredTailForRetry(args.store, args.runId, {
      allowEmpty: args.failure.category === "empty_response",
    });
    this.logger.warn("agent-run-retry", {
      threadKey: this.threadKey,
      category: args.failure.category,
      providerError: args.failure.message,
      ...args.logContext,
    });
    return true;
  }
  dropDurableErroredTailForRetry(store, runId, options) {
    if (
      !store ||
      !runId ||
      typeof store.loadThreadMessages !== "function" ||
      typeof store.removeThreadMessageEntry !== "function"
    ) {
      return;
    }
    try {
      const last = store.loadThreadMessages(this.threadKey).at(-1);
      const payload = last?.payload;
      const errored =
        payload?.role === "assistant" &&
        (payload.stopReason === "error" || payload.stopReason === "aborted");
      const empty =
        options?.allowEmpty === true &&
        payload?.role === "assistant" &&
        !payload.content.some(
          (block) =>
            block.type === "toolCall" ||
            (block.type === "text" && block.text.trim().length > 0),
        );
      if (
        !last?.entryId ||
        payload?.role !== "assistant" ||
        payload.stellaRunId !== runId ||
        (!errored && !empty)
      ) {
        return;
      }
      store.removeThreadMessageEntry(this.threadKey, last.entryId);
    } catch (error) {
      this.logger.warn("agent-run-retry-durable-tail-remove-failed", {
        threadKey: this.threadKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  popErroredTailForResume(agent, options) {
    const messages = agent.state.messages;
    const last = messages[messages.length - 1];
    const popErroredTail =
      last?.role === "assistant" &&
      (last.stopReason === "error" || last.stopReason === "aborted");
    const popEmptyTail =
      options?.allowEmpty === true &&
      last?.role === "assistant" &&
      !last.content.some(
        (block) =>
          block.type === "toolCall" ||
          (block.type === "text" && block.text.trim().length > 0),
      );
    const popAssistantTail = popErroredTail || popEmptyTail;
    const tailAfterPop = popAssistantTail
      ? messages[messages.length - 2]
      : last;
    if (!tailAfterPop || tailAfterPop.role === "assistant") {
      return false;
    }
    if (popAssistantTail) {

      messages.pop();
    }
    return true;
  }
  noteAbortContainmentSuccess() {
    this.abortContainment.noteRunSuccess();
  }

  noteAbortContainmentFailure(agent, args) {
    const messages = agent.state.messages;
    const failureMessagesBefore = Number.isFinite(args.failureMessagesBefore)
      ? args.failureMessagesBefore
      : args.messagesBefore;
    const surfaced = this.abortContainment.noteRunFailure({
      history: messages.slice(0, failureMessagesBefore),
      appended: messages.slice(failureMessagesBefore),
      errorMessage: args.errorMessage,
      swapAttempted: args.swapAttempted,
    });
    if (surfaced !== args.errorMessage) {
      this.logger.warn("deterministic-provider-abort", {
        threadKey: this.threadKey,
        consecutiveInstantAborts:
          this.abortContainment.consecutiveInstantAbortCount,
        quarantinedEntries: this.abortContainment.quarantinedCount,
        providerError: args.errorMessage,
        ...args.logContext,
      });
    }
    return surfaced;
  }
  freezeContextSnapshot(systemPrompt, tools) {
    this.frozenSystemPrompt = systemPrompt;
    this.frozenToolSchemas = snapshotToolSchemas(tools);
    this.announcedToolDriftSignature = null;
    this.adoptFreshContextSnapshot = false;
  }

  takePendingContextDeltaMessages() {
    if (this.pendingContextDeltaMessages.length === 0) {
      return [];
    }
    const messages = this.pendingContextDeltaMessages;
    this.pendingContextDeltaMessages = [];
    return messages;
  }

  applyFrozenContext(args) {
    const agent = this.agent;
    const frozen = this.frozenToolSchemas;
    const structuralToolChange =
      !this.frozenSystemPrompt ||
      !frozen ||
      frozen.size !== args.tools.length ||
      args.tools.some((tool) => !frozen.has(tool.name));
    const boundary = this.adoptFreshContextSnapshot || structuralToolChange;
    if (boundary) {
      if (structuralToolChange && !this.adoptFreshContextSnapshot) {

        this.logger.warn("frozen-context.structural-tool-change", {
          threadKey: this.threadKey,
          previousTools: frozen ? [...frozen.keys()] : [],
          nextTools: args.tools.map((tool) => tool.name),
          ...args.logContext,
        });
      }
      agent.state.systemPrompt = args.systemPrompt;
      agent.state.tools = args.tools;
      this.freezeContextSnapshot(args.systemPrompt, args.tools);
      checkPromptPrefixStability({
        threadKey: this.threadKey,
        systemPrompt: agent.state.systemPrompt,
        tools: agent.state.tools,
        messages: agent.state.messages,
        boundary: true,
        logger: this.logger,
      });
      return;
    }
    agent.state.systemPrompt = this.frozenSystemPrompt;
    const driftedToolNames = [];
    agent.state.tools = args.tools.map((tool) => {
      const snapshot = frozen.get(tool.name);
      if (!snapshot) {
        return tool;
      }
      const descriptionMatches = tool.description === snapshot.description;
      const parametersMatch =
        tool.parameters === snapshot.parameters ||
        safeSchemaJson(tool.parameters) === snapshot.parametersJson;
      if (descriptionMatches && parametersMatch) {
        return tool;
      }
      driftedToolNames.push(tool.name);
      return {
        ...tool,
        description: snapshot.description,
        parameters: snapshot.parameters,
      };
    });
    if (args.systemPrompt !== this.frozenSystemPrompt) {

      this.logger.debug("frozen-context.system-prompt-drift-held", {
        threadKey: this.threadKey,
        ...args.logContext,
      });
    }
    if (driftedToolNames.length > 0) {
      const signature = driftedToolNames.sort().join(",");
      if (this.announcedToolDriftSignature !== signature) {
        this.announcedToolDriftSignature = signature;
        this.pendingContextDeltaMessages.push({
          text: `<system-reminder>Available tool definitions changed mid-conversation (${driftedToolNames.join(", ")}) — for example the set of integration tools reachable from the current delivery surface. Your visible tool schemas are a thread-start snapshot and refresh at the next context compaction; current callable names and compact signatures are discoverable inside node_repl via await tools.$search({ query: "<capability>" }), and one selected live schema is available via await tools.$describe(name).</system-reminder>`,
          uiVisibility: "hidden",
          messageType: "message",
          customType: `${CONTEXT_DELTA_CUSTOM_TYPE_PREFIX}tools`,
        });
        this.logger.debug("frozen-context.tool-drift-held", {
          threadKey: this.threadKey,
          driftedToolNames,
          ...args.logContext,
        });
      }
    }
    checkPromptPrefixStability({
      threadKey: this.threadKey,
      systemPrompt: agent.state.systemPrompt,
      tools: agent.state.tools,
      messages: agent.state.messages,
      boundary: false,
      logger: this.logger,
    });
  }
  createOrReuseAgent(args) {
    const serviceTier = resolveCodexProviderServiceTier(
      args.resolvedLlm,
      args.agentContext,
    );
    const memoryEnabled = args.agentContext.memoryEnabled !== false;
    if (!this.agent) {
      const historySource = buildHistorySource(args.agentContext);
      this.agent = createRuntimeAgent({
        agentType: args.agentType,
        systemPrompt: args.systemPrompt,
        resolvedLlm: args.resolvedLlm,
        resolvedLlmOverride: () => this.currentResolvedLlm ?? args.resolvedLlm,
        reasoningEffort: resolveAgentThinkingLevel({
          resolvedLlm: args.resolvedLlm,
          ...(args.agentContext.reasoningEffort
            ? { agentContextReasoningEffort: args.agentContext.reasoningEffort }
            : {}),
        }),
        ...(args.hookEmitter ? { hookEmitter: args.hookEmitter } : {}),
        tools: args.tools,
        historySource,
        cacheSessionId: this.threadKey,
        promptCacheKey: this.promptCacheKey,
        ...(serviceTier ? { serviceTier } : {}),
        ...(args.afterToolCall ? { afterToolCall: args.afterToolCall } : {}),
        ...(args.onProviderRetry
          ? { onProviderRetry: args.onProviderRetry }
          : {}),
        ...(args.onTurnBoundary ? { onTurnBoundary: args.onTurnBoundary } : {}),
      });
      this.logger.debug("agent-created", {
        threadKey: this.threadKey,
        historyLength: historySource.length,
        model: args.resolvedLlm.model.id,
        ...args.logContext,
      });
      this.lastMemoryEnabled = memoryEnabled;
      this.freezeContextSnapshot(args.systemPrompt, args.tools);
      checkPromptPrefixStability({
        threadKey: this.threadKey,
        systemPrompt: args.systemPrompt,
        tools: args.tools,
        messages: this.agent.state.messages,
        boundary: true,
        logger: this.logger,
      });
      return this.agent;
    }
    if (this.lastMemoryEnabled !== memoryEnabled) {
      this.agent.state.messages = buildHistorySource(args.agentContext);
      this.lastMemoryEnabled = memoryEnabled;

      this.adoptFreshContextSnapshot = true;
      this.logger.debug("history-refreshed.memory-preference", {
        threadKey: this.threadKey,
        memoryEnabled,
        historyLength: this.agent.state.messages.length,
        ...args.logContext,
      });
    }
    this.applyFrozenContext(args);
    this.agent.state.model = args.resolvedLlm.model;
    this.agent.state.thinkingLevel = resolveAgentThinkingLevel({
      resolvedLlm: args.resolvedLlm,
      ...(args.agentContext.reasoningEffort
        ? { agentContextReasoningEffort: args.agentContext.reasoningEffort }
        : {}),
    });
    this.agent.setServiceTier(serviceTier);
    this.logger.debug("agent-reused", {
      threadKey: this.threadKey,
      priorMessages: this.agent.state.messages.length,
      model: args.resolvedLlm.model.id,
      thinkingLevel: this.agent.state.thinkingLevel,
      ...args.logContext,
    });
    return this.agent;
  }
  dispose() {
    if (this.agent) {
      try {
        this.agent.abort();
      } catch {

      }
    }
    this.agent = null;
    this.currentResolvedLlm = null;
    this.pendingHistoryRefresh = false;
    this.lastMemoryEnabled = null;
    this.frozenSystemPrompt = null;
    this.frozenToolSchemas = null;
    this.adoptFreshContextSnapshot = false;
    this.announcedToolDriftSignature = null;
    this.pendingContextDeltaMessages = [];
    clearPromptPrefixSnapshot(this.threadKey);
    clearProviderContextWindow(this.threadKey);

    try {
      cleanupSessionResources(this.threadKey);
    } catch {

    }
  }
}
