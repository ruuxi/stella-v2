import { cleanupSessionResources } from "../../ai/session-resources.js";
import type { Agent } from "../agent-core/agent.js";
import type { AgentMessage } from "../agent-core/types.js";
import { createRuntimeLogger } from "../debug.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import type { LocalAgentContext } from "../agents/local-agent-manager.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import type { RuntimePromptMessage } from "@stella/contracts/protocol";
import {
  buildSafetyAbortSwapRoute,
  isProviderContentAbortMessage,
  parseQuarantineRecord,
  ProviderAbortContainment,
  QUARANTINE_CUSTOM_TYPE,
  type QuarantineRecord,
  type SafetySwapRoute,
} from "./provider-abort-containment.js";
import { createRuntimeAgent, resolveAgentThinkingLevel } from "./shared.js";
import { buildHistorySource } from "./thread-memory.js";
import {
  ACTIVE_THREAD_IMAGE_DECODED_BYTE_BUDGET,
  getCompactionTriggerTokens,
  getThreadTokenEstimate,
  MAX_ACTIVE_THREAD_IMAGES,
} from "../thread-runtime.js";
import { PINNED_INSTRUCTION_ENTRY_ID_MARKER } from "./resident-context.js";
import {
  checkPromptPrefixStability,
  clearPromptPrefixSnapshot,
} from "./prompt-prefix-guard.js";
import {
  clearProviderContextWindow,
  clearProviderUsage,
  estimateProviderPayloadTokens,
  getBilledContextTokens,
  getLastBilledPromptTokens,
  getLastProviderPayloadTokens,
  getProviderPayloadImageStats,
  providerInputBudgetTokens,
  setProviderContextWindow,
  withForcedThreadCompaction,
} from "./context-budget.js";
import { runCompactionWithHooks } from "./run-completion.js";
import {
  advanceFrozenContext,
  freezeContext,
  frozenProviderTools,
  renderSystemPrompt,
  type FrozenContext,
  type SystemPromptSection,
} from "./frozen-context.js";
import type { BackgroundCompactionScheduler } from "./compaction-scheduler.js";
import type { OrchestratorRunOptions } from "./types.js";
import {
  popEmptyCompletionTailForResume,
  popErroredTailForResume,
  type AgentRunFailureClassification,
} from "./run-retry.js";
import type { AgentRunFailure } from "./agent-run-retry.js";

type CreateRuntimeAgentArgs = Parameters<typeof createRuntimeAgent>[0];
type RuntimeAgentTools = CreateRuntimeAgentArgs["tools"];
type RuntimeAgentTool = RuntimeAgentTools[number];

type PiSessionCoreOptions = {
  threadKey: string;
  loggerName: string;
  /** Stable provider prompt-cache key (the conversation id) for this thread. */
  promptCacheKey?: string;
};

type SessionLogContext = Record<string, unknown>;

const awaitUnlessAborted = async (
  promise: Promise<unknown>,
  signal?: AbortSignal,
): Promise<boolean> => {
  if (!signal) {
    await promise;
    return true;
  }
  if (signal.aborted) return false;
  let onAbort = () => {};
  const aborted = new Promise<boolean>((resolve) => {
    onAbort = () => resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise.then(() => true), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

const resolveCodexProviderServiceTier = (
  resolvedLlm: ResolvedLlmRoute,
  agentContext: LocalAgentContext,
): "default" | "priority" | undefined => {
  const snapshot = agentContext.modelConfigSnapshot;
  if (
    snapshot?.engine !== "codex_cli" ||
    resolvedLlm.model.api !== "chatgpt-responses"
  ) {
    return undefined;
  }
  // Codex represents Standard as an explicit `default` session setting but
  // omits it from the actual Responses request. The native provider has no
  // Codex session layer, so omission is the matching wire behavior.
  return snapshot.serviceTier === "fast" ? "priority" : undefined;
};

const safeSchemaJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
};

const durableComparableMessage = (message: AgentMessage): unknown => {
  if (message.role === "assistant") {
    const {
      stellaRunId: _runId,
      stellaAttemptGeneration: _attemptGeneration,
      ...comparable
    } = message as typeof message & {
      stellaRunId?: string;
      stellaAttemptGeneration?: number;
    };
    return comparable;
  }
  if (message.role === "toolResult") {
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
  if (message.role === "runtimeInternal") {
    return {
      role: "runtimeInternal",
      content: message.content,
      timestamp: message.timestamp,
      ...(message.customType ? { customType: message.customType } : {}),
      // Custom rows persist the provider-equivalent default explicitly.
      display: message.display === true,
    };
  }
  return message;
};

const hasExactDurableCompletedSuffix = (
  history: AgentMessage[],
  completedMessages: AgentMessage[],
): boolean => {
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

const hasExactDurableRawTail = (args: {
  store: RuntimeStore;
  threadKey: string;
  threadHistory: any[];
  agentContext: LocalAgentContext;
  residentMessages: AgentMessage[];
  refreshedMessages: AgentMessage[];
}): boolean => {
  if (typeof args.store.findLatestRangeCompaction !== "function") return true;
  const compaction = args.store.findLatestRangeCompaction(args.threadKey);
  const checkpointId = compaction?.entry?.id;
  if (!checkpointId) return false;
  const checkpointIndex = args.threadHistory.findIndex(
    (entry) => entry.entryId === checkpointId,
  );
  if (checkpointIndex < 0) return false;
  const rawTailEntries = args.threadHistory
    .slice(checkpointIndex + 1)
    .filter(
      (entry) =>
        !entry.entryId?.includes(PINNED_INSTRUCTION_ENTRY_ID_MARKER),
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
        durableComparableMessage(args.refreshedMessages[refreshedOffset + index]),
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


/**
 * Shared mutable Pi-Agent state for long-lived runtime sessions.
 *
 * Orchestrators and subagents differ in prompt assembly and finalization, but
 * the live `Agent` lifecycle is the same: keep one Agent per durable thread,
 * update route/system/tools between turns, and refresh the in-memory message
 * mirror only at turn boundaries after background compaction lands.
 */
export class PiSessionCore {
  protected readonly logger;
  protected agent: Agent | null = null;
  private currentResolvedLlm: ResolvedLlmRoute | null = null;
  private pendingHistoryRefresh = false;
  private lastMemoryEnabled: boolean | null = null;
  /**
   * Thread-start (or last-boundary) snapshot of the provider-visible
   * context: the system prompt string and each tool's description +
   * parameter schema. Between boundaries the reused Agent keeps these
   * frozen bytes even when the freshly-computed values drift (locale
   * change, connector-surface switch mutating node_repl's demoted-tool
   * catalog), so the prompt-cache prefix stays byte-identical. The
   * snapshot re-adopts fresh values only at legitimate cache boundaries:
   * compaction/history refresh or the memory-preference toggle.
   */
  private frozenContext: FrozenContext | null = null;
  private adoptFreshContextSnapshot = false;
  /**
   * Hidden `runtime.context_delta.*` messages queued by the freeze logic,
   * consumed into the next prompt build so the model hears about resident
   * context drift as an APPEND instead of a prefix rewrite. Persisted by
   * run-execution and swept at the next compaction fold-in.
   */
  private pendingContextDeltaMessages: RuntimePromptMessage[] = [];
  /**
   * Deterministic provider-abort tracking for this durable thread: instant
   * first-call failure counting and the request-assembly quarantine
   * registry. Survives across turns for the lifetime of the session.
   */
  protected readonly abortContainment = new ProviderAbortContainment();
  readonly threadKey: string;
  readonly promptCacheKey: string | undefined;

  constructor(opts: PiSessionCoreOptions) {
    this.threadKey = opts.threadKey;
    this.promptCacheKey = opts.promptCacheKey;
    this.logger = createRuntimeLogger(opts.loggerName);
  }

  get hasAgent(): boolean {
    return this.agent !== null;
  }

  get canSteerLiveAgent(): boolean {
    return this.agent?.state.isStreaming === true;
  }

  /**
   * Inject a user message into an actively streaming Pi agent. The agent loop
   * consumes it at the next safe boundary without aborting the provider.
   */
  steerLiveAgent(message: AgentMessage): boolean {
    if (!this.canSteerLiveAgent || !this.agent) return false;
    this.agent.steer(message);
    return true;
  }

  /**
   * Flag that SQLite compaction wrote a new overlay. The next turn swaps the
   * live Agent's message array from freshly-loaded history before prompting.
   */
  notifyCompacted(): void {
    if (!this.agent) return;
    this.pendingHistoryRefresh = true;
  }

  /**
   * External conversation writers (for example realtime voice) append into
   * the same durable thread without going through this live Agent instance.
   * Refresh at the next turn boundary so switching surfaces keeps context.
   */
  notifyHistoryChanged(): void {
    this.pendingHistoryRefresh = true;
  }

  protected setResolvedLlm(resolvedLlm: ResolvedLlmRoute): void {
    this.currentResolvedLlm = resolvedLlm;
    setProviderContextWindow(this.threadKey, resolvedLlm.model.contextWindow);
  }

  protected refreshHistoryIfNeeded(
    agentContext: LocalAgentContext,
    logContext: SessionLogContext,
  ): void {
    if (!this.pendingHistoryRefresh || !this.agent) return;
    const refreshed = buildHistorySource(agentContext);
    this.agent.state.messages = refreshed;
    this.pendingHistoryRefresh = false;
    clearProviderUsage(this.threadKey);
    // The mirror swap already broke the prompt-cache prefix (that is the
    // point of the boundary), so the next createOrReuseAgent re-freezes
    // the system prompt + tools from current state — this is where the
    // compaction fold-in "re-render the canonical blocks" applies to the
    // two request-level blocks that live outside the message array.
    this.adoptFreshContextSnapshot = true;
    this.logger.debug("history-refreshed", {
      threadKey: this.threadKey,
      historyLength: refreshed.length,
      ...logContext,
    });
  }

  /**
   * Close the session-creation race: a writer can flag history after the
   * caller loaded `agentContext`, but before the Pi Agent exists. Once the
   * Agent has been created, reload SQLite and replace its message mirror
   * before the provider turn begins.
   */
  protected refreshHistoryFromStoreIfNeeded(
    agentContext: LocalAgentContext,
    store: RuntimeStore,
    logContext: SessionLogContext,
  ): LocalAgentContext {
    if (!this.pendingHistoryRefresh || !this.agent) return agentContext;
    const refreshedContext: LocalAgentContext = {
      ...agentContext,
      threadHistory: store.loadThreadMessages(this.threadKey),
    };
    this.refreshHistoryIfNeeded(refreshedContext, logContext);
    return refreshedContext;
  }

  /**
   * Bound a continuously-running Pi loop at the same durable checkpoint
   * boundary used between outer runtime turns. The agent-core invokes this
   * only after the completed assistant/tool-result group has synchronously
   * emitted `message_end` and immediately before another provider call.
   *
   * Two thresholds, as in Pi's durable harness: past the compaction trigger
   * a background compaction starts and the loop keeps working; a later
   * boundary pages the finished compaction in. Only a request that would
   * exceed the provider input budget (or image pressure) waits for one.
   *
   * SQLite stays authoritative: compaction appends its overlay first, then
   * this method reloads the checkpoint + exact post-checkpoint tail. Until
   * both steps succeed it returns no replacement, leaving the live mirror
   * untouched. The compactor owns split selection, including atomic
   * assistant-tool-call/tool-result groups.
   */
  protected async refreshActiveWorkingSetAtBoundary(args: {
    opts: OrchestratorRunOptions;
    agentContext: LocalAgentContext;
    runId: string;
    messages: AgentMessage[];
    completedMessages: AgentMessage[];
    requiredResidentSuffix?: AgentMessage[];
    signal?: AbortSignal;
    onCompacting?: () => void;
    canApply?: () => boolean;
    logContext: SessionLogContext;
  }): Promise<AgentMessage[] | undefined> {
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
        // The billed prompt of the response that ended this group is the
        // real request size; the preflight estimate stands in without one.
        const lastProviderTokens =
          getLastBilledPromptTokens(this.threadKey) ??
          getLastProviderPayloadTokens(this.threadKey);
        if (lastProviderTokens === undefined) {
          const narrow =
            typeof args.opts.store.getThreadContextPressureStats === "function"
              ? args.opts.store.getThreadContextPressureStats(this.threadKey)
              : null;
          // Prefer bounded SQLite metadata. If this is a legacy row,
          // the live mirror is already exact and avoids reconstructing
          // chunked base64 merely to perform a below-threshold probe.
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
          // The last measured provider request predates this completed
          // assistant/tool group. Include it so a large tool result can
          // trigger compaction before it reaches the next provider call.
          measuredTokens =
            lastProviderTokens +
            estimateProviderPayloadTokens(
              { messages: args.completedMessages },
              Number.POSITIVE_INFINITY,
            );
        }
      } catch {
        // A failed size probe must not affect the active loop. The normal
        // provider preflight/overflow-recovery path remains authoritative.
        return undefined;
      }
      const triggerTokens = getCompactionTriggerTokens(
        args.opts.resolvedLlm,
        args.opts.agentType,
      );
      if (!imagePressure && measuredTokens < triggerTokens) return undefined;
      const inputBudget = providerInputBudgetTokens(
        args.opts.resolvedLlm.model.contextWindow,
      );
      if (!imagePressure && !(inputBudget && measuredTokens >= inputBudget)) {
        // One background pass at a time; a later boundary applies it.
        if (!scheduler.pending(this.threadKey)) {
          this.logger.debug("active-working-set.background-compaction", {
            threadKey: this.threadKey,
            measuredTokens,
            triggerTokens,
            ...args.logContext,
          });
          void scheduler.schedule({
            threadKey: this.threadKey,
            run: (signal) =>
              this.runBoundaryCompaction(args, false, signal).then(
                () => undefined,
              ),
          });
        }
        return undefined;
      }
      args.onCompacting?.();

      try {
        // Serialize with any compaction already running. The scheduler can
        // coalesce queued callbacks, so drain first and schedule our own
        // forced pass only once it is idle.
        let pending = scheduler.pending(this.threadKey);
        while (pending) {
          if (!(await awaitUnlessAborted(pending, args.signal))) {
            return undefined;
          }
          pending = scheduler.pending(this.threadKey);
        }
        if (this.agent !== agent || args.signal?.aborted) return undefined;
        if (!this.pendingHistoryRefresh) {
          let compacted = false;
          const scheduled = scheduler.schedule({
            threadKey: this.threadKey,
            run: async (signal) => {
              compacted = await this.runBoundaryCompaction(args, true, signal);
            },
          });
          if (!(await awaitUnlessAborted(scheduled, args.signal))) {
            return undefined;
          }
          if (!compacted || !this.pendingHistoryRefresh) return undefined;
        }
      } catch (error) {
        this.logger.warn("active-working-set-compaction-failed", {
          threadKey: this.threadKey,
          error: error instanceof Error ? error.message : String(error),
          ...args.logContext,
        });
        return undefined;
      }
    }

    try {
      if (this.agent !== agent || args.signal?.aborted) return undefined;

      // A live steer can arrive while async compaction is running. Its row is
      // durable before the loop consumes it, so page in only if the caller
      // confirms there are still no queued/dequeued messages.
      if (args.canApply && !args.canApply()) return undefined;
      const threadHistory = args.opts.store.loadThreadMessages(this.threadKey);
      const refreshedContext: LocalAgentContext = {
        ...args.agentContext,
        threadHistory,
      };
      const refreshed = buildHistorySource(refreshedContext);
      this.abortContainment.reapplyQuarantine(refreshed);

      // Require both the completed group and the full provider-visible
      // post-checkpoint tail to match resident context. Failed/aborted attempts
      // are intentionally non-replayable and filtered by the history builder;
      // other extra or truncated rows fail open here.
      const completedSuffixExact = hasExactDurableCompletedSuffix(
        refreshed,
        args.completedMessages,
      );
      const currentTurnSuffixExact =
        !args.requiredResidentSuffix ||
        hasExactDurableCompletedSuffix(
          refreshed,
          args.requiredResidentSuffix,
        );
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
      // Usage billed before the swap measured the uncompacted history.
      clearProviderUsage(this.threadKey);
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
      // The outer run options retain agentContext for the duration of the
      // prompt. Drop their reference to the pre-compaction durable rows too,
      // otherwise the Agent swap alone would not release the old history.
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

  /** One compaction pass for the active run; a forced pass ignores hook vetoes. */
  private async runBoundaryCompaction(
    args: {
      opts: OrchestratorRunOptions;
      runId: string;
      messages: AgentMessage[];
    },
    forced: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const run = () =>
      runCompactionWithHooks({
        opts: args.opts,
        threadKey: this.threadKey,
        runId: args.runId,
        messageCount: args.messages.length,
        ...(signal ? { abortSignal: signal } : {}),
      });
    const { compacted } = forced
      ? await withForcedThreadCompaction(this.threadKey, run)
      : await run();
    if (compacted) this.notifyCompacted();
    return compacted;
  }

  /**
   * Shrinking-model-switch compaction. When the incoming route's context
   * window is smaller than the current route's AND the thread's measured
   * context no longer fits the incoming route's safe input budget (the
   * same ~70% bound preflight enforces at dispatch), the outgoing
   * (larger-window) model is the one that can still read the uncompacted
   * history in one summary pass — so compact NOW, blocking, on the
   * outgoing route before the switch takes effect. Any in-flight
   * background compaction is drained first (the "switched while
   * compacting" case waits here too), and `args.onCompacting` lets the
   * caller surface the wait as a "compacting" working indicator. Below
   * that bound nothing blocks: the thread fits the new model, and the
   * routine non-blocking compaction covers it from there.
   *
   * Best-effort by design: after a worker restart the previous route is
   * unknown (`currentResolvedLlm` is null), and a failed pass here is not
   * fatal — the pre-dispatch preflight, overflow recovery, and the capped
   * single-pass summary on the new route remain the backstops.
   */
  protected async maybeCompactForModelSwitch(args: {
    opts: Pick<
      OrchestratorRunOptions,
      | "agentType"
      | "conversationId"
      | "uiVisibility"
      | "resolvedLlm"
      | "store"
      | "hookEmitter"
      | "stellaDataDir"
      | "compactionScheduler"
    >;
    runId: string;
    onCompacting?: () => void;
    logContext: SessionLogContext;
  }): Promise<void> {
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
      return (
        getBilledContextTokens(this.threadKey) ??
        Math.max(historyTokens, getLastProviderPayloadTokens(this.threadKey) ?? 0)
      );
    };
    let measuredTokens: number;
    try {
      measuredTokens = measureTokens();
    } catch {
      // Can't measure the thread — let the dispatch backstops decide.
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
      // Drain any in-flight/queued background compaction first; it may
      // already relieve the thread (it was scheduled with the outgoing
      // route too).
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
      // Forced pass on the outgoing route. The scheduler is idle after the
      // drain, so this runs immediately and the await is the block.
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
      // Failures are logged by the scheduler/compaction path; the turn
      // proceeds and the dispatch backstops handle a residual overflow.
    }
  }

  /**
   * Gate the next turn on any in-flight background compaction for this
   * thread. Compaction is scheduled off the finalize path and runs
   * asynchronously (~1-2 min); meanwhile new turns/messages accumulate on
   * the still-uncompacted tail. Because the compaction trigger sits at the
   * same fraction of the window as the provider input budget, any tokens
   * added during that window eat directly into the headroom before the hard
   * context limit — so concurrent work can overflow the model BEFORE the
   * compaction meant to prevent it lands.
   *
   *   - `mode: "blocking"` (general agents + subagents): always wait for the
   *     pending compaction to finish before running the next turn. Agents do
   *     real tool work and can burn a lot of tokens fast, so their next turn
   *     must resume on the compacted context. This structurally removes the
   *     agent overflow-during-compaction path.
   *   - `mode: "guard"` (orchestrator): keep the non-blocking
   *     compact-while-you-talk UX for the common case, but fall back to
   *     blocking when a real overflow is imminent — i.e. the uncompacted
   *     thread has already reached the provider input budget (the bound
   *     preflight enforces, and the one the in-run boundary blocks at) while
   *     a compaction is still in flight.
   *
   * A rejected wait never fails the turn: background compaction failures are
   * logged by the scheduler, and the normal pre-generation overflow recovery
   * remains as the last-resort backstop.
   */
  protected async awaitPendingCompactionBeforeTurn(args: {
    compactionScheduler: BackgroundCompactionScheduler | undefined;
    store?: RuntimeStore;
    resolvedLlm?: ResolvedLlmRoute;
    mode: "guard" | "blocking";
    onCompacting?: () => void;
    logContext: SessionLogContext;
  }): Promise<void> {
    const scheduler = args.compactionScheduler;
    if (!scheduler || typeof scheduler.pending !== "function") return;
    if (!scheduler.pending(this.threadKey)) return;
    if (args.mode === "guard") {
      const store = args.store;
      if (!store) return;
      const window = Number(args.resolvedLlm?.model?.contextWindow);
      if (!Number.isFinite(window) || window <= 0) return;
      let estimate: number;
      let imagePressure = false;
      let imageCount = 0;
      try {
        const narrow =
          typeof store.getThreadContextPressureStats === "function"
            ? store.getThreadContextPressureStats(this.threadKey)
            : null;
        if (narrow?.complete) {
          estimate = narrow.estimatedTokens;
          imageCount = narrow.imageCount;
          imagePressure =
            narrow.imageCount > MAX_ACTIVE_THREAD_IMAGES ||
            narrow.imageDecodedBytes >
              ACTIVE_THREAD_IMAGE_DECODED_BYTE_BUDGET;
        } else {
          const history = store.loadThreadMessages(this.threadKey);
          estimate = getThreadTokenEstimate(history);
          const images = getProviderPayloadImageStats({ messages: history });
          imageCount = images.count;
          imagePressure =
            images.count > MAX_ACTIVE_THREAD_IMAGES ||
            images.decodedBytes > ACTIVE_THREAD_IMAGE_DECODED_BYTE_BUDGET;
        }
      } catch {
        // Can't assess the accumulated tail — preserve the non-blocking UX
        // and let pre-generation overflow recovery catch a genuine overflow.
        return;
      }
      if (!imagePressure && estimate < providerInputBudgetTokens(window)!) {
        return;
      }
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
    // The turn is now actually going to wait on compaction — surface it
    // as a "compacting" working indicator instead of a silent stall.
    args.onCompacting?.();
    try {
      // Drain the active run plus any queued follow-up so the next turn
      // starts on the compacted context. No new compaction is scheduled
      // during a turn boundary, so this loop terminates.
      let pending = scheduler.pending(this.threadKey);
      while (pending) {
        await pending;
        pending = scheduler.pending(this.threadKey);
      }
    } catch {
      // Background compaction failures are already logged by the scheduler;
      // a rejected wait must not fail the turn.
    }
  }

  /**
   * Start a containment-tracked turn. Re-seeds the quarantine registry from
   * persisted thread records (so healed threads survive app restarts),
   * re-masks previously quarantined entries (history refreshes rebuild the
   * message array from the intact store) and, after two consecutive instant
   * provider aborts, quarantines the newest suspect tool-result entry from
   * the request assembly. Returns the pre-run message count so failures can
   * be classified later, plus any newly quarantined record so the caller
   * can persist it.
   */
  protected beginAbortContainmentTurn(
    agent: Agent,
    agentContext: LocalAgentContext,
    logContext: SessionLogContext,
  ): {
    messagesBefore: number;
    failureMessagesBefore: number;
    newlyQuarantined: QuarantineRecord | null;
  } {
    const persisted = (agentContext.threadHistory ?? [])
      .map((entry: { customMessage?: { customType?: string; content?: unknown } }) =>
        entry.customMessage?.customType === QUARANTINE_CUSTOM_TYPE
          ? parseQuarantineRecord(entry.customMessage.content)
          : null,
      )
      .filter(
        (record: QuarantineRecord | null): record is QuarantineRecord =>
          record !== null,
      );
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

  /**
   * Last resort after `prepareSafetySameModelRetry` exhausts the fable
   * attempt budget: auto-swap a fable-5 route to opus-4.8 and retry once
   * (fable's safety guardrails false-positive on benign quoted content).
   * When eligible, this pops the errored assistant tail, points the live
   * Agent at the swapped route, and returns the swap so the caller re-runs
   * via `resume`. Per-run only: the next turn's
   * `setResolvedLlm(opts.resolvedLlm)` restores the configured model. The
   * caller invokes this at most once per turn, which enforces the
   * one-swap-attempt cap (no ping-pong).
   */
  protected prepareSafetyModelSwap(
    agent: Agent,
    args: {
      errorMessage: string;
      store: RuntimeStore;
      runId: string;
      logContext: SessionLogContext;
    },
  ): SafetySwapRoute | null {
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

  /**
   * After a failed attempt, decide whether to retry the SAME fable-5 route
   * before any model swap (refusals are frequently transient). When
   * eligible, pops the errored tail so the caller re-runs via `resume` and
   * returns the failing model id for the status note; the caller owns the
   * attempt budget (`SAFETY_ABORT_FABLE_ATTEMPTS`). Requires the same
   * eligibility as the swap itself so a route that could never swap doesn't
   * burn retries on a hopeless error.
   */
  protected prepareSafetySameModelRetry(
    agent: Agent,
    args: {
      errorMessage: string;
      store: RuntimeStore;
      runId: string;
      logContext: SessionLogContext;
    },
  ): { modelId: string } | null {
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

  /**
   * Prepare a retryable provider/transport failure for `Agent.continue()`.
   * Only the failed assistant tail is removed; the prompt, completed tool
   * calls/results, and fenced report acknowledgements stay in the live state.
   */
  protected prepareTransientFailureRetry(
    agent: Agent,
    args: {
      errorMessage: string;
      classification: AgentRunFailureClassification;
      logContext: SessionLogContext;
    },
  ): boolean {
    const prepared =
      args.classification.category === "empty-completion"
        ? this.popEmptyCompletionTailForResume(agent)
        : this.popErroredTailForResume(agent);
    if (!prepared) return false;
    this.logger.warn("transient-run-retry", {
      threadKey: this.threadKey,
      providerError: args.errorMessage,
      ...args.logContext,
    });
    return true;
  }

  /**
   * Prepare a transient run-level retry without appending another user turn.
   * Only the failed (or clean-but-empty) assistant tail is removed. Any tool
   * result immediately before it remains in context, so continuing resumes
   * after completed side effects instead of executing them again.
   */
  protected prepareAgentRunRetry(
    agent: Agent,
    args: {
      failure: AgentRunFailure;
      store: RuntimeStore;
      runId: string;
      logContext: SessionLogContext;
    },
  ): boolean {
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

  private dropDurableErroredTailForRetry(
    store: RuntimeStore,
    runId: string,
    options?: { allowEmpty?: boolean },
  ): void {
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
          (block: { type: string; text?: string }) =>
            block.type === "toolCall" ||
            (block.type === "text" && (block.text ?? "").trim().length > 0),
        );
      if (
        !last?.entryId ||
        payload?.role !== "assistant" ||
        (payload as typeof payload & { stellaRunId?: string }).stellaRunId !==
          runId ||
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

  // Tail-pop logic lives in run-retry.ts so cloud loop hosts share it.
  private popEmptyCompletionTailForResume(agent: Agent): boolean {
    return popEmptyCompletionTailForResume(agent.state.messages);
  }

  private popErroredTailForResume(
    agent: Agent,
    options?: { allowEmpty?: boolean },
  ): boolean {
    if (!options?.allowEmpty) {
      return popErroredTailForResume(agent.state.messages);
    }
    const messages = agent.state.messages;
    const last = messages[messages.length - 1];
    const popErroredTail =
      last?.role === "assistant" &&
      (last.stopReason === "error" || last.stopReason === "aborted");
    const popEmptyTail =
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
    if (!tailAfterPop || tailAfterPop.role === "assistant") return false;
    if (popAssistantTail) messages.pop();
    return true;
  }

  protected noteAbortContainmentSuccess(): void {
    this.abortContainment.noteRunSuccess();
  }

  /**
   * Record a failed turn with the containment tracker. Returns the error
   * message to surface — the original, or the deterministic-abort
   * containment error once the threshold is reached.
   */
  protected noteAbortContainmentFailure(
    agent: Agent,
    args: {
      messagesBefore: number;
      failureMessagesBefore?: number;
      errorMessage: string;
      swapAttempted?: { fromModelId: string; toModelId: string } | undefined;
      logContext: SessionLogContext;
    },
  ): string {
    const messages = agent.state.messages;
    const failureMessagesBefore = Number.isFinite(args.failureMessagesBefore)
      ? (args.failureMessagesBefore as number)
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

  private freezeContextSnapshot(
    sections: readonly SystemPromptSection[],
    tools: RuntimeAgentTools,
  ): void {
    this.frozenContext = freezeContext(sections, tools);
    this.pendingContextDeltaMessages = [];
    this.adoptFreshContextSnapshot = false;
  }

  /** Drain the queued resident-context delta messages for this turn's prompt. */
  protected takePendingContextDeltaMessages(): RuntimePromptMessage[] {
    const messages = this.pendingContextDeltaMessages;
    this.pendingContextDeltaMessages = [];
    return messages;
  }

  /**
   * Reused-agent context policy. Tool `execute` closures are rebuilt every
   * turn (they capture per-turn state like runId), but the provider-visible
   * bytes come from the frozen snapshot so the cached prefix survives:
   *
   *   - boundary (compaction refresh / memory toggle) → adopt fresh system prompt + tools and re-freeze;
   *   - otherwise → keep frozen bytes; when the freshly-computed bytes
   *     drifted (e.g. a desktop↔mobile surface switch changing
   *     node_repl's demoted-tool catalog), queue ONE hidden
   *     `runtime.context_delta.tools` note so the model learns about the
   *     change as an append. The real bytes swap at the next boundary.
   *
   * The policy itself is `frozen-context.ts`, which the cloud orchestrator
   * runs too; this method only holds its state for the live Agent.
   */
  private applyFrozenContext(args: {
    systemPromptSections: SystemPromptSection[];
    tools: RuntimeAgentTools;
    logContext: SessionLogContext;
  }): void {
    const agent = this.agent;
    if (!agent) return;
    const frozen = this.frozenContext;
    if (this.adoptFreshContextSnapshot || !frozen) {
      agent.state.systemPrompt = renderSystemPrompt(args.systemPromptSections);
      agent.state.tools = args.tools;
      this.freezeContextSnapshot(args.systemPromptSections, args.tools);
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
    const advanced = advanceFrozenContext(
      frozen,
      args.systemPromptSections,
      args.tools,
    );
    this.frozenContext = advanced.frozen;
    agent.state.systemPrompt = frozen.systemPrompt;
    agent.state.tools = frozenProviderTools(
      frozen,
      args.tools,
      (snapshot, text): RuntimeAgentTool => ({
        name: snapshot.name,
        label: snapshot.name,
        description: snapshot.description,
        parameters: snapshot.parameters as RuntimeAgentTool["parameters"],
        execute: async () => ({
          content: [{ type: "text", text }],
          details: { unavailable: true },
        }),
      }),
    );
    this.pendingContextDeltaMessages.push(...advanced.deltas);
    const { added, removed, changed } = advanced.drift;
    if (added.length + removed.length + changed.length > 0) {
      this.logger.debug("frozen-context.tool-drift-held", {
        threadKey: this.threadKey,
        driftedToolNames: [...added, ...removed, ...changed],
        ...args.logContext,
      });
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

  protected createOrReuseAgent(args: {
    agentType: string;
    systemPromptSections: SystemPromptSection[];
    resolvedLlm: ResolvedLlmRoute;
    agentContext: LocalAgentContext;
    hookEmitter?: HookEmitter;
    tools: CreateRuntimeAgentArgs["tools"];
    afterToolCall?: CreateRuntimeAgentArgs["afterToolCall"];
    onProviderRetry?: CreateRuntimeAgentArgs["onProviderRetry"];
    onTurnBoundary?: CreateRuntimeAgentArgs["onTurnBoundary"];
    logContext: SessionLogContext;
  }): Agent {
    const serviceTier = resolveCodexProviderServiceTier(
      args.resolvedLlm,
      args.agentContext,
    );
    const memoryEnabled = args.agentContext.memoryEnabled !== false;
    if (!this.agent) {
      const historySource = buildHistorySource(args.agentContext);
      const systemPrompt = renderSystemPrompt(args.systemPromptSections);
      this.agent = createRuntimeAgent({
        agentType: args.agentType,
        systemPrompt,
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
        ...(args.onTurnBoundary
          ? { onTurnBoundary: args.onTurnBoundary }
          : {}),
      });
      this.logger.debug("agent-created", {
        threadKey: this.threadKey,
        historyLength: historySource.length,
        model: args.resolvedLlm.model.id,
        ...args.logContext,
      });
      this.lastMemoryEnabled = memoryEnabled;
      this.freezeContextSnapshot(args.systemPromptSections, args.tools);
      checkPromptPrefixStability({
        threadKey: this.threadKey,
        systemPrompt,
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
      // Deliberate full cache break (the user toggled memory); adopt
      // fresh context bytes at the same boundary.
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

  dispose(): void {
    if (this.agent) {
      try {
        this.agent.abort();
      } catch {
        // Best-effort; the Agent may already be idle.
      }
    }
    this.agent = null;
    this.currentResolvedLlm = null;
    this.pendingHistoryRefresh = false;
    this.lastMemoryEnabled = null;
    this.frozenContext = null;
    this.adoptFreshContextSnapshot = false;
    this.pendingContextDeltaMessages = [];
    clearPromptPrefixSnapshot(this.threadKey);
    clearProviderContextWindow(this.threadKey);
    // Release per-session provider resources keyed by the same id used as the
    // AI cache session id (the thread key), e.g. Codex WebSocket connections
    // and their transport/fallback bookkeeping.
    try {
      cleanupSessionResources(this.threadKey);
    } catch {
      // Best-effort; a failing cleanup shouldn't break session teardown.
    }
  }
}
