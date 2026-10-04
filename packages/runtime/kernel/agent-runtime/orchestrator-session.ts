/**
 * Long-lived per-conversation orchestrator session.
 *
 * Owns one live Pi `Agent` for the lifetime of the conversation. Subsequent
 * turns reuse the same Agent (and its `state.messages` array) instead of
 * rebuilding from SQLite each turn. This lets provider prompt caches hit
 * cleanly between turns: the prefix the LLM sees on turn N+1 is byte-
 * identical to turn N up through the new user message at the tail.
 *
 * Lifetime: created lazily on the first user message for a `conversationId`
 * via `getOrCreateOrchestratorSession`. Disposed when the runtime worker
 * stops (`runtime-initialization.ts:stop`). One session per conversation;
 * concurrent runs against the same conversation are serialized by the
 * orchestrator coordinator's queue, same as before.
 *
 * Scope: the Pi engine path only. External engines (Claude Code) keep their
 * existing per-turn flow because the engine binary owns its own session
 * concept. Subagents are out of scope (E2 follow-up).
 *
 * Limitations (intentional for v1):
 *   - Model switching mid-conversation is supported (matches Pi's pattern,
 *     `agent-session.ts:setModel`). Each turn, the session updates the
 *     `currentResolvedLlm` slot and `agent.state.model`; the Agent's
 *     `getApiKey` / `refreshApiKey` / `transformContext` closures read
 *     from the slot via `resolvedLlmOverride`, so the next provider call
 *     uses the new credentials, base URL, and context-window budget.
 *   - Memory bundle injection cadence is preserved (runs through
 *     `buildOrchestratorPromptMessages` on cadence turns). Now that the
 *     bootstrap-replay-key dedup is removed in `buildHistorySource`, the
 *     accumulating bootstrap entries don't break prompt cache; they're
 *     bounded by `maybeCompactRuntimeThread`.
 */

import crypto from "crypto";
import { Effect, Fiber, Layer, ManagedRuntime, Scope } from "effect";
import {
  finalizeOrchestratorError,
  finalizeOrchestratorInterrupted,
  finalizeOrchestratorSuccess,
  markOrchestratorErrorReported,
  resolveInterruptionReason,
} from "./run-completion.js";
import {
  executeRuntimeAgentPrompt,
  isDurablyPersistedRuntimePromptInput,
} from "./run-execution.js";
import { executeWithContextOverflowRecovery } from "./context-overflow-recovery.js";
import {
  enrichImageContentForTextOnlyModel,
  type ImageDescriptionService,
} from "./image-description.js";
import type { Api, Model } from "../../ai/types.js";
import {
  AGENT_RUN_MAX_ATTEMPTS,
  executeAgentTurnWithRetry,
  formatAgentRunRetryStatus,
  hasAgentRunAttemptBudget,
} from "./agent-run-retry.js";
import { buildRuntimeSystemPrompt } from "./run-preparation.js";
import {
  createRunEventRecorder,
  type RuntimeRunEventRecorder,
} from "./run-events.js";
import {
  createOrchestratorResponseTargetTracker,
  type OrchestratorResponseTargetTracker,
} from "./response-target.js";
import { PiSessionCore } from "./pi-session-core.js";
import {
  QUARANTINE_CUSTOM_TYPE,
  SAFETY_ABORT_FABLE_ATTEMPTS,
  safetyRetryStatusMessage,
  safetySwapStatusMessage,
  serializeQuarantineRecord,
} from "./provider-abort-containment.js";
import {
  buildOrchestratorPromptMessages,
  buildRunThreadKey,
  persistThreadCustomMessage,
  persistThreadPayloadMessages,
} from "./thread-memory.js";
import { prepareDurableResumeContext } from "./durable-resume.js";
import { snapshotCapturedTranscript } from "./run-events.js";
import { getAgentCompletion } from "./shared.js";
import {
  RUN_TASK_RESUME_SEQ_OFFSET,
  type RunTaskStore,
} from "../storage/run-task.js";
import type { PersistedRuntimeThreadPayload } from "../storage/shared.js";
import type { AgentMessage } from "../agent-core/types.js";
import { createPiTools } from "./tool-adapters.js";
import { createRunScopedStreamFn } from "./provider-stream-lifecycle.js";
import {
  LONG_PROMPT_CACHE_TTL_MS,
  hasRunningBackgroundAgents,
  withOrchestratorCacheRetention,
  type PromptCacheRequest,
} from "./orchestrator-cache-retention.js";
import { PromptCacheWarmer } from "./cache-warmer.js";
import { streamSimple } from "../../ai/stream.js";
import type {
  DurableRunResume,
  OrchestratorRunOptions,
  RuntimeRunCallbacks,
} from "./types.js";
import type { RuntimePromptMessage } from "@stella/contracts/protocol";
import type { Agent } from "../agent-core/agent.js";
import type { AgentTurnBoundaryContext } from "../agent-core/types.js";

/**
 * Stable runId fragment fed to {@link buildRunThreadKey} so the
 * orchestrator's threadKey is stable across turns. The shared
 * `buildRunThreadKey` helper is also used by subagents (where the
 * runId genuinely varies per attempt), so a literal placeholder is
 * needed to disambiguate; promoting it to a named constant prevents
 * future copy-paste from carrying the magic string into a per-
 * conversation key migration.
 */
const ORCHESTRATOR_SESSION_RUN_ID = "session";
const ORCHESTRATOR_AGENT_IDLE_EVICTION_MS = 5 * 60 * 1000;
const orchestratorSessionRuntime = ManagedRuntime.make(Layer.empty);
const orchestratorSessionTimerScope = Scope.makeUnsafe();

const forkOrchestratorSessionTimer = (
  delayMs: number,
  fire: () => void,
): Fiber.Fiber<void> =>
  orchestratorSessionRuntime.runSync(
    Effect.forkIn(
      Effect.andThen(Effect.sleep(delayMs), Effect.sync(fire)),
      orchestratorSessionTimerScope,
      { startImmediately: true },
    ),
  );

const runtimeInternalText = (message: {
  content: string | Array<{ type: string; text?: string }>;
}): string =>
  Array.isArray(message.content)
    ? message.content
        .filter(
          (block): block is { type: "text"; text: string } =>
            block.type === "text" && typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("\n")
    : message.content;

const removeTransientRuntimePromptInputs = (
  agent: Agent,
  inputs: RuntimePromptMessage[],
  messagesBefore: number,
): boolean => {
  const remaining = inputs
    .filter(
      (input) =>
        input.messageType === "message" &&
        !isDurablyPersistedRuntimePromptInput(input),
    )
    .map((input) => ({ customType: input.customType, text: input.text }));
  if (remaining.length === 0) return false;
  const messages = agent.state.messages;
  const nextMessages = messages.filter((message, index) => {
    if (index < messagesBefore || message.role !== "runtimeInternal")
      return true;
    const matchIndex = remaining.findIndex(
      (input) =>
        input.customType === message.customType &&
        input.text === runtimeInternalText(message),
    );
    if (matchIndex < 0) return true;
    remaining.splice(matchIndex, 1);
    return false;
  });
  if (nextMessages.length === messages.length) return false;
  agent.replaceMessages(nextMessages);
  return true;
};

export class OrchestratorSession extends PiSessionCore {
  private idleEvictionTimer: Fiber.Fiber<void> | null = null;
  private activeTurnCount = 0;
  /**
   * Mutable tracker slot. Set at the start of every `runTurn`, cleared at
   * the end. The Agent's `afterToolCall` closure (built once at Agent
   * construction) reads from this slot so per-turn trackers reach the
   * long-lived loop without re-binding the closure each turn.
   */
  private currentResponseTargetTracker: OrchestratorResponseTargetTracker | null =
    null;
  /**
   * Per-turn slot read by {@link handleProviderRetry} (installed once at
   * Agent construction). Set at the top of `runTurn`, cleared in `finally`.
   * Lets the long-lived Agent's retry closure reach the current turn's
   * recorder + UI callbacks without re-binding on every turn.
   */
  private currentRetryStatusContext: {
    recorder: RuntimeRunEventRecorder;
    callbacks?: RuntimeRunCallbacks;
  } | null = null;
  private currentImageDescriptionContext: {
    model: Pick<Model<Api>, "input">;
    describeImages?: ImageDescriptionService;
  } | null = null;
  /** Per-run data read by the long-lived Agent's quiescent-boundary hook. */
  private currentActiveWorkingSetContext: {
    opts: OrchestratorRunOptions;
    agentContext: OrchestratorRunOptions["agentContext"];
    runId: string;
    onCompacting: () => void;
    containmentTurn: {
      messagesBefore: number;
      failureMessagesBefore: number;
    };
    refreshBlocked: boolean;
  } | null = null;
  private hasUnresolvedThreadPersistenceFailure = false;
  /** Cache tier and time of the latest provider request this session sent. */
  private lastPromptCacheRequest: PromptCacheRequest | null = null;
  /** Store and route of the latest turn, read while the session idles. */
  private idleContext: Pick<
    OrchestratorRunOptions,
    "store" | "resolvedLlm"
  > | null = null;
  private readonly cacheWarmer: PromptCacheWarmer;

  private createCacheWarmer(): PromptCacheWarmer {
    return new PromptCacheWarmer({
      send: streamSimple,
      shouldWarm: () =>
        this.activeTurnCount === 0 &&
        !this.canSteerLiveAgent &&
        this.hasRunningBackgroundAgentsWhileIdle(),
      getPromptTokens: () => {
        const messages = this.agent?.state.messages ?? [];
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index];
          if (message?.role === "assistant" && message.usage) {
            const usage = message.usage;
            return usage.input + usage.cacheRead + usage.cacheWrite;
          }
        }
        return 0;
      },
      getApiKey: () => this.idleContext?.resolvedLlm.getApiKey(),
      logContext: { conversationId: this.conversationId },
    });
  }

  private hasRunningBackgroundAgentsWhileIdle(): boolean {
    const store = this.idleContext?.store;
    return store
      ? hasRunningBackgroundAgents(store, this.conversationId)
      : false;
  }

  /**
   * While background agents run, keep the live Agent (and its frozen prompt
   * bytes) for as long as the 1h cache entry its last request wrote: a
   * rebuild from SQLite after eviction is not guaranteed byte-identical,
   * which would forfeit the entry their completion is about to read.
   */
  private resolveIdleEvictionDelayMs(): number {
    const last = this.lastPromptCacheRequest;
    if (
      last?.retention !== "long" ||
      !this.hasRunningBackgroundAgentsWhileIdle()
    ) {
      return ORCHESTRATOR_AGENT_IDLE_EVICTION_MS;
    }
    return Math.max(
      ORCHESTRATOR_AGENT_IDLE_EVICTION_MS,
      last.at + LONG_PROMPT_CACHE_TTL_MS - Date.now(),
    );
  }

  private scheduleIdleEviction(): void {
    if (this.idleEvictionTimer) {
      this.idleEvictionTimer.interruptUnsafe();
      this.idleEvictionTimer = null;
    }
    if (this.activeTurnCount > 0 || this.hasUnresolvedThreadPersistenceFailure)
      return;
    this.idleEvictionTimer = forkOrchestratorSessionTimer(
      this.resolveIdleEvictionDelayMs(),
      () => {
        this.idleEvictionTimer = null;
        if (this.activeTurnCount > 0) return;
        // A scheduled keepalive still owns the cache entry; check back later.
        if (this.cacheWarmer.armed) {
          this.scheduleIdleEviction();
          return;
        }
        this.dispose();
      },
    );
  }

  constructor(public readonly conversationId: string) {
    super({
      loggerName: "orchestrator-session",
      promptCacheKey: conversationId,
      threadKey: buildRunThreadKey({
        conversationId,
        agentType: "orchestrator",
        runId: ORCHESTRATOR_SESSION_RUN_ID,
      }),
    });
    this.cacheWarmer = this.createCacheWarmer();
  }

  /**
   * Surface a transient "trying again in X" status as a STATUS event the
   * desktop renders in Activity without creating a root-chat message.
   */
  private handleProviderRetry = (info: {
    attempt: number;
    delayMs: number;
    reason?: string;
  }): void => {
    if (info.attempt < 2) return;
    const ctx = this.currentRetryStatusContext;
    if (!ctx) return;
    const seconds = Math.max(1, Math.round(info.delayMs / 1000));
    const statusText = `Stella is having trouble reaching the server — trying again in ${seconds}s`;
    try {
      const event = ctx.recorder.recordStatus(statusText, "provider-retry");
      ctx.callbacks?.onStatus?.(event);
    } catch {
      // Best-effort UI signal; never let a status emit abort the retry.
    }
  };

  private handleActiveTurnBoundary = async (
    context: AgentTurnBoundaryContext,
    signal?: AbortSignal,
  ) => {
    const current = this.currentActiveWorkingSetContext;
    if (!current) return undefined;
    // The completed group is the suspect tail for containment, while the
    // narrower failure baseline tracks only the next provider attempt.
    current.containmentTurn.messagesBefore = Math.max(
      0,
      context.context.messages.length - context.completedMessages.length,
    );
    current.containmentTurn.failureMessagesBefore =
      context.context.messages.length;
    // Steering rows are durable before consumption. Page-in while none are
    // queued so the same row cannot be loaded and appended twice.
    if (
      current.refreshBlocked ||
      context.pendingMessages.length > 0 ||
      this.agent?.hasQueuedMessages()
    ) {
      return undefined;
    }
    const turnStartIndex = Math.min(
      context.context.messages.length,
      Math.max(0, current.containmentTurn.messagesBefore),
    );
    const currentTurnTail = context.context.messages.slice(turnStartIndex);
    const replacement = await this.refreshActiveWorkingSetAtBoundary({
      opts: current.opts,
      agentContext: current.agentContext,
      runId: current.runId,
      messages: context.context.messages,
      completedMessages: context.completedMessages,
      requiredResidentSuffix: currentTurnTail,
      signal,
      onCompacting: current.onCompacting,
      canApply: () =>
        this.currentActiveWorkingSetContext === current &&
        context.pendingMessages.length === 0 &&
        !this.agent?.hasQueuedMessages(),
      logContext: {
        conversationId: this.conversationId,
        runId: current.runId,
      },
    });
    if (replacement && this.currentActiveWorkingSetContext === current) {
      current.containmentTurn.messagesBefore =
        replacement.length - currentTurnTail.length;
      current.containmentTurn.failureMessagesBefore = replacement.length;
    }
    return replacement;
  };

  async runTurn(opts: OrchestratorRunOptions): Promise<string> {
    if (this.hasUnresolvedThreadPersistenceFailure) {
      throw new Error(
        "Cannot continue this live session after an unresolved thread persistence failure.",
      );
    }
    if (this.idleEvictionTimer) {
      this.idleEvictionTimer.interruptUnsafe();
      this.idleEvictionTimer = null;
    }
    // A real turn always supersedes a keepalive, including one in flight.
    this.cacheWarmer.cancel();
    this.activeTurnCount += 1;
    this.idleContext = { store: opts.store, resolvedLlm: opts.resolvedLlm };
    try {
      return await this.runActiveTurn(opts);
    } finally {
      this.activeTurnCount = Math.max(0, this.activeTurnCount - 1);
      if (this.activeTurnCount === 0) {
        if (this.hasRunningBackgroundAgentsWhileIdle()) {
          this.cacheWarmer.onIdle();
        }
        this.scheduleIdleEviction();
      }
    }
  }

  private async runActiveTurn(opts: OrchestratorRunOptions): Promise<string> {
    const runId = opts.runId ?? `local:${crypto.randomUUID()}`;
    const turnOpts = opts.runId === runId ? opts : { ...opts, runId };
    // Durable run row before the first await: a process lost at any later
    // point leaves a row the next worker can resume (`run-task.ts`).
    const durableRunTasks = this.beginDurableRun(opts, runId);
    const effectiveSystemPrompt = await buildRuntimeSystemPrompt(turnOpts);

    // The recorder is side-effect-free to create and is needed this early
    // so the compaction waits below can surface a "compacting" indicator.
    const responseTargetTracker = createOrchestratorResponseTargetTracker(
      opts.responseTarget,
    );
    this.currentResponseTargetTracker = responseTargetTracker;
    const runEvents = createRunEventRecorder({
      runId,
      agentType: opts.agentType,
      userMessageId: opts.userMessageId,
      uiVisibility: opts.uiVisibility,
      getResponseTarget: () =>
        responseTargetTracker.resolve() ?? opts.responseTarget,
      ...(opts.resume
        ? {
            initialSeq:
              opts.resume.record.resumeCount * RUN_TASK_RESUME_SEQ_OFFSET,
          }
        : {}),
    });
    const emitCompactingStatus = () => {
      try {
        opts.callbacks?.onStatus?.(
          runEvents.recordStatus("Compacting context", "compacting"),
        );
      } catch {
        // Best-effort UI signal; never let a status emit block the turn.
      }
    };
    // Shrinking model switch: while the outgoing (larger-window) route is
    // still current, run a blocking compaction with it so the incoming
    // smaller-window route starts on a context it can actually hold. A
    // resume continues the exact context its dead process was sending.
    if (!opts.resume) {
      await this.maybeCompactForModelSwitch({
        opts,
        runId,
        onCompacting: emitCompactingStatus,
        logContext: { conversationId: this.conversationId, runId },
      });
    }

    // Keep the reused Agent pointed at this turn's model route.
    this.setResolvedLlm(opts.resolvedLlm);

    // Non-blocking compact-while-you-talk stays the norm, but degrade to
    // blocking if a real overflow is imminent: when a background compaction
    // is still in flight and the uncompacted thread has already reached the
    // provider input budget, wait for it rather than dispatch a turn that
    // could overflow before the compaction lands.
    await this.awaitPendingCompactionBeforeTurn({
      compactionScheduler: opts.compactionScheduler,
      store: opts.store,
      resolvedLlm: opts.resolvedLlm,
      mode: "guard",
      onCompacting: emitCompactingStatus,
      logContext: { conversationId: this.conversationId, runId },
    });

    // Apply compaction overlays before provider calls, never mid-stream.
    const refreshedAgentContext = this.refreshHistoryFromStoreIfNeeded(
      opts.agentContext,
      opts.store,
      { conversationId: this.conversationId },
    );
    if (refreshedAgentContext !== opts.agentContext) {
      opts.agentContext.threadHistory = refreshedAgentContext.threadHistory;
    }
    this.currentImageDescriptionContext = {
      model: opts.resolvedLlm.model,
      ...(opts.describeImages ? { describeImages: opts.describeImages } : {}),
    };

    const tools = createPiTools({
      executionHost: opts.executionHost,
      runId,
      rootRunId: opts.rootRunId ?? runId,
      agentId: opts.agentId,
      conversationId: opts.conversationId,
      storageMode: opts.storageMode,
      ownerGeneration: opts.ownerGeneration,
      agentType: opts.agentType,
      deviceId: opts.deviceId,
      stellaAppDir: opts.stellaAppDir,
      stellaDataDir: opts.stellaDataDir,
      toolWorkspaceRoot: opts.toolWorkspaceRoot,
      agentDepth: opts.agentContext.agentDepth ?? 0,
      maxAgentDepth: opts.agentContext.maxAgentDepth,
      parentAgentId: opts.agentContext.parentAgentId,
      modelConfigSnapshot: opts.agentContext.modelConfigSnapshot,
      connectorDeliveryTarget: opts.connectorDeliveryTarget,
      toolsAllowlist: opts.agentContext.toolsAllowlist,
      toolCatalog: opts.toolCatalog,
      store: opts.store,
      toolExecutor: opts.toolExecutor,
      hookEmitter: opts.hookEmitter,
      ...(opts.superviseRunResource
        ? { superviseRunResource: opts.superviseRunResource }
        : {}),
      imageCapTarget: {
        provider: opts.resolvedLlm.model.provider,
        api: opts.resolvedLlm.model.api,
        modelId: opts.resolvedLlm.model.id,
      },
    });

    const agent = this.createOrReuseAgent({
      agentType: opts.agentType,
      systemPromptSections: effectiveSystemPrompt,
      resolvedLlm: opts.resolvedLlm,
      agentContext: opts.agentContext,
      ...(opts.hookEmitter ? { hookEmitter: opts.hookEmitter } : {}),
      tools,
      afterToolCall: async (context, signal) => {
        this.currentResponseTargetTracker?.noteToolEnd(
          context.toolCall.name,
          context.result.details,
        );
        const imageContext = this.currentImageDescriptionContext;
        if (!imageContext) return undefined;
        const content = await enrichImageContentForTextOnlyModel({
          content: context.result.content,
          model: imageContext.model,
          describeImages: imageContext.describeImages,
          signal,
        });
        return content === context.result.content ? undefined : { content };
      },
      onProviderRetry: this.handleProviderRetry,
      onTurnBoundary: this.handleActiveTurnBoundary,
      logContext: {
        conversationId: this.conversationId,
        runId,
      },
    });

    this.currentRetryStatusContext = {
      recorder: runEvents,
      ...(opts.callbacks ? { callbacks: opts.callbacks } : {}),
    };

    // Provider streams opened this turn supervise as child fibers of the
    // run's scope (fiber-derived abort, terminal-settlement join). Reset
    // every turn: the Agent is long-lived but the registrar is per-run.
    // Anthropic requests use the 1h cache tier so a background agent's
    // completion (or the user returning) wakes this session on a warm
    // prefix; see orchestrator-cache-retention.ts for the cost reasoning.
    agent.streamFn = withOrchestratorCacheRetention(
      opts.superviseRunResource
        ? createRunScopedStreamFn({
            supervise: opts.superviseRunResource,
            runId,
            onLifecycle: (event) =>
              opts.callbacks?.onProviderLifecycle?.(
                runEvents.recordProviderLifecycle(event),
              ),
          })
        : streamSimple,
      {
        onRequest: (request) => {
          this.lastPromptCacheRequest = request;
          this.cacheWarmer.noteRequest(request);
        },
      },
    );

    const containmentTurn = this.beginAbortContainmentTurn(
      agent,
      opts.agentContext,
      {
        conversationId: this.conversationId,
        runId,
      },
    );
    if (containmentTurn.newlyQuarantined) {
      // Durable record so the quarantine survives session/app restarts.
      persistThreadCustomMessage(opts.store, {
        threadKey: this.threadKey,
        customType: QUARANTINE_CUSTOM_TYPE,
        content: [
          {
            type: "text",
            text: serializeQuarantineRecord(containmentTurn.newlyQuarantined),
          },
        ],
      });
    }
    let swapAttempted: { fromModelId: string; toModelId: string } | undefined;

    opts.onExecutionSessionCreated?.({
      runId,
      threadKey: this.threadKey,
      engine: "native",
      queueUserMessageId: runEvents.queueUserMessageId,
      agent,
    });

    if (opts.abortSignal?.aborted) {
      const reason =
        resolveInterruptionReason({ abortSignal: opts.abortSignal }) ??
        "Canceled";
      finalizeOrchestratorInterrupted({
        opts,
        runEvents,
        reason,
        runId,
        threadKey: this.threadKey,
      });
      this.currentResponseTargetTracker = null;
      this.currentRetryStatusContext = null;
      this.currentImageDescriptionContext = null;
      this.currentActiveWorkingSetContext = null;
      return runId;
    }

    this.currentActiveWorkingSetContext = {
      opts,
      agentContext: opts.agentContext,
      runId,
      onCompacting: emitCompactingStatus,
      containmentTurn,
      refreshBlocked: false,
    };
    let transientRuntimePromptInputs: RuntimePromptMessage[] = [];
    const transientRuntimePromptStart = containmentTurn.messagesBefore;
    const dropTransientRuntimePromptInputs = () => {
      if (
        removeTransientRuntimePromptInputs(
          agent,
          transientRuntimePromptInputs,
          transientRuntimePromptStart,
        )
      ) {
        opts.agentContext.threadHistory = agent.state.messages;
      }
      transientRuntimePromptInputs = [];
    };

    try {
      // Frozen-context drift notes (queued by createOrReuseAgent) ride as
      // hidden appends ahead of any caller-supplied prompt messages.
      const contextDeltaMessages = this.takePendingContextDeltaMessages();
      const combinedPromptMessages =
        contextDeltaMessages.length > 0
          ? [...contextDeltaMessages, ...(opts.promptMessages ?? [])]
          : opts.promptMessages;
      // A resume sends no prompt: its prompt is already in the context.
      const promptMessages = opts.resume
        ? []
        : await buildOrchestratorPromptMessages({
            context: opts.agentContext,
            userPrompt: opts.userPrompt,
            promptMessages: combinedPromptMessages,
            stellaDataDir: opts.stellaDataDir,
            stellaAppDir: opts.stellaAppDir,
            agentType: opts.agentType,
            hookContext: {
              ...(opts.hookEmitter ? { hookEmitter: opts.hookEmitter } : {}),
              conversationId: opts.conversationId,
              threadKey: this.threadKey,
              runId,
              ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
            },
          });
      const workingSetContext = this.currentActiveWorkingSetContext!;
      transientRuntimePromptInputs = promptMessages.filter(
        (message) =>
          message.messageType === "message" &&
          !isDurablyPersistedRuntimePromptInput(message),
      );
      if (
        workingSetContext?.runId === runId &&
        transientRuntimePromptInputs.length > 0
      ) {
        // Queued-reply wrappers are intentionally not durable: their user
        // messages already are. Keep this turn resident until cleanup.
        workingSetContext.refreshBlocked = true;
      }

      const executionArgs = {
        agent,
        promptMessages: promptMessages.map(
          (message: RuntimePromptMessage, index: number) => ({
            ...message,
            ...(index === promptMessages.length - 1 && opts.attachments?.length
              ? { attachments: opts.attachments }
              : {}),
          }),
        ),
        runId,
        agentType: opts.agentType,
        userMessageId: opts.userMessageId,
        recorder: runEvents,
        ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
        ...(opts.describeImages ? { describeImages: opts.describeImages } : {}),
        callbacks: opts.callbacks,
        ...(opts.hookEmitter ? { hookEmitter: opts.hookEmitter } : {}),
        threadStore: opts.store,
        threadKey: this.threadKey,
        conversationId: opts.conversationId,
        stellaDataDir: opts.stellaDataDir,
        ...(typeof opts.agentContext.attemptGeneration === "number"
          ? { attemptGeneration: opts.agentContext.attemptGeneration }
          : {}),
        ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
        onThreadPersistenceError: () => {
          workingSetContext.refreshBlocked = true;
          this.hasUnresolvedThreadPersistenceFailure = true;
        },
        onThreadPersistenceRecovered: () => {
          this.hasUnresolvedThreadPersistenceFailure = false;
          if (transientRuntimePromptInputs.length === 0) {
            workingSetContext.refreshBlocked = false;
          }
        },
        ...(durableRunTasks
          ? {
              // A cloud turn's prompt lives only in its in-memory capture;
              // mirror it into the run's checkpoint before the provider call.
              onPromptPersisted: () => {
                const captured = snapshotCapturedTranscript(
                  opts.store,
                  this.threadKey,
                  runId,
                );
                if (captured) durableRunTasks.checkpointCaptured(runId, captured);
              },
            }
          : {}),
      };
      const retryState = { attemptsUsed: 0, retriesUsed: 0 };
      const executeWithTransientRetry = (initialResume = false) =>
        executeAgentTurnWithRetry({
          state: retryState,
          initialResume,
          execute: (resume) =>
            executeRuntimeAgentPrompt({
              ...executionArgs,
              ...(resume ? { resume: true } : {}),
            }),
          prepareRetry: (failure) =>
            this.prepareAgentRunRetry(agent, {
              failure,
              store: opts.store,
              runId,
              logContext: { conversationId: this.conversationId, runId },
            }),
          ...(opts.abortSignal ? { signal: opts.abortSignal } : {}),
          onRetry: (info) => {
            opts.callbacks?.onStatus?.(
              runEvents.recordStatus(
                formatAgentRunRetryStatus(info),
                "provider-retry",
              ),
            );
          },
        });
      const resumed = opts.resume
        ? await this.prepareDurableResume({
            agent,
            opts,
            runId,
            runEvents,
            resume: opts.resume,
          })
        : null;
      let execution = resumed?.final
        ? getAgentCompletion(agent)
        : await executeWithContextOverflowRecovery({
            // A resume continues from the restored context; it never
            // re-sends the prompt.
            execute: resumed
              ? () => executeWithTransientRetry(true)
              : executeWithTransientRetry,
            agent,
            opts,
            threadKey: this.threadKey,
            runId,
            runEvents,
            session: this,
          });

      // Safety containment: a fable-5 refusal/safety abort first gets
      // retried on the configured model — refusals are often transient — up
      // to SAFETY_ABORT_FABLE_ATTEMPTS consecutive attempts total. Only when
      // every attempt fails does the turn swap to opus-4.8 below.
      let fableAttempts = 1;
      while (
        execution.errorMessage &&
        !opts.abortSignal?.aborted &&
        hasAgentRunAttemptBudget(retryState, AGENT_RUN_MAX_ATTEMPTS) &&
        fableAttempts < SAFETY_ABORT_FABLE_ATTEMPTS
      ) {
        const retry = this.prepareSafetySameModelRetry(agent, {
          errorMessage: execution.errorMessage,
          store: opts.store,
          runId,
          logContext: {
            conversationId: this.conversationId,
            runId,
            attempt: fableAttempts + 1,
          },
        });
        if (!retry) break;
        fableAttempts += 1;
        opts.callbacks?.onStatus?.(
          runEvents.recordStatus(
            safetyRetryStatusMessage({
              modelId: retry.modelId,
              attempt: fableAttempts,
            }),
            "running",
          ),
        );
        execution = await executeWithTransientRetry(true);
      }
      // Safety model swap: after the fable attempts are exhausted, one retry
      // on opus-4.8 (same auth path, per-run only). `prepareSafetyModelSwap`
      // returns null for anything else, and this block runs at most once per
      // turn, so there is no swap ping-pong.
      if (
        execution.errorMessage &&
        !opts.abortSignal?.aborted &&
        hasAgentRunAttemptBudget(retryState, AGENT_RUN_MAX_ATTEMPTS)
      ) {
        const swap = this.prepareSafetyModelSwap(agent, {
          errorMessage: execution.errorMessage,
          store: opts.store,
          runId,
          logContext: { conversationId: this.conversationId, runId },
        });
        if (swap) {
          swapAttempted = {
            fromModelId: swap.fromModelId,
            toModelId: swap.toModelId,
          };
          const statusText = safetySwapStatusMessage(swapAttempted);
          opts.callbacks?.onStatus?.(
            runEvents.recordStatus(statusText, "model-fallback"),
          );
          persistThreadCustomMessage(opts.store, {
            threadKey: this.threadKey,
            customType: "containment.safety-model-swap",
            content: [{ type: "text", text: statusText }],
          });
          execution = await executeWithTransientRetry(true);
        }
      }
      const { finalText, errorMessage } = execution;

      const interruptedReason = resolveInterruptionReason({
        abortSignal: opts.abortSignal,
        error: errorMessage,
      });
      if (interruptedReason) {
        finalizeOrchestratorInterrupted({
          opts,
          runEvents,
          reason: interruptedReason,
          runId,
          threadKey: this.threadKey,
        });
        return runId;
      }
      if (errorMessage) {
        throw new Error(errorMessage);
      }

      // One-shot queued-reply wrappers must not reach agent_end memory review
      // or the post-turn compaction snapshot; their user rows are durable.
      dropTransientRuntimePromptInputs();
      this.noteAbortContainmentSuccess();
      await finalizeOrchestratorSuccess({
        opts,
        runId,
        threadKey: this.threadKey,
        runEvents,
        agent,
        finalText,
        responseTarget: responseTargetTracker.resolve(),
      });
      return runId;
    } catch (error) {
      const interruptedReason = resolveInterruptionReason({
        abortSignal: opts.abortSignal,
        error,
      });
      if (interruptedReason) {
        finalizeOrchestratorInterrupted({
          opts,
          runEvents,
          reason: interruptedReason,
          runId,
          threadKey: this.threadKey,
        });
        return runId;
      }
      const surfacedMessage = this.noteAbortContainmentFailure(agent, {
        messagesBefore: containmentTurn.messagesBefore,
        failureMessagesBefore: containmentTurn.failureMessagesBefore,
        errorMessage:
          error instanceof Error
            ? error.message || "Stella runtime failed"
            : String(error),
        swapAttempted,
        logContext: { conversationId: this.conversationId, runId },
      });
      const surfacedError =
        error instanceof Error && surfacedMessage === error.message
          ? error
          : new Error(surfacedMessage);
      finalizeOrchestratorError({
        opts,
        runEvents,
        error: surfacedError,
        runId,
        threadKey: this.threadKey,
      });
      throw markOrchestratorErrorReported(surfacedError);
    } finally {
      dropTransientRuntimePromptInputs();
      this.currentResponseTargetTracker = null;
      this.currentRetryStatusContext = null;
      this.currentImageDescriptionContext = null;
      this.currentActiveWorkingSetContext = null;
    }
  }

  /**
   * Write (or, on resume, re-attach to) this run's durable row when the
   * launcher asked for one. Bookkeeping never costs the turn.
   */
  private beginDurableRun(
    opts: OrchestratorRunOptions,
    runId: string,
  ): RunTaskStore | undefined {
    const runTasks = (opts.store as { runTasks?: RunTaskStore } | undefined)
      ?.runTasks;
    if (!runTasks || (!opts.durable && !opts.resume)) return undefined;
    try {
      runTasks.begin({
        runId,
        conversationId: opts.conversationId,
        threadKey: this.threadKey,
        agentType: opts.agentType,
        ...(opts.durable ? { launch: opts.durable.launch } : {}),
        ...(opts.durable?.background ? { background: true } : {}),
      });
      return runTasks;
    } catch (error) {
      this.logger.warn("durable-run.begin-failed", {
        conversationId: this.conversationId,
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Restore the context a resumed run's dead process was working on and
   * answer its open tool calls (`durable-resume.ts`). The restored messages
   * and answers are persisted as the turn's group in one commit, exactly as
   * the turn boundary would have, so the next request's prefix is the same
   * bytes the dead process sent plus the answers.
   */
  private async prepareDurableResume(args: {
    agent: Agent;
    opts: OrchestratorRunOptions;
    runId: string;
    runEvents: RuntimeRunEventRecorder;
    resume: DurableRunResume;
  }): Promise<{ final: AgentMessage | null }> {
    const { agent, opts, runId, runEvents, resume } = args;
    if (opts.storageMode === "cloud" && !resume.record.checkpoint.captured) {
      // A cloud turn's prompt and completed groups lived only in memory;
      // without their checkpoint there is nothing to continue from.
      throw new Error(
        "This turn was interrupted before its progress was saved, so it could not resume.",
      );
    }
    const restoredContext = await prepareDurableResumeContext({
      messages: agent.state.messages,
      checkpoint: resume.record.checkpoint,
      intents: resume.intents,
      tools: agent.state.tools,
      ...(opts.abortSignal ? { signal: opts.abortSignal } : {}),
    });
    // A cloud turn's captured transcript goes back into its (re-seeded)
    // in-memory capture so the turn's finish carries it to the cloud.
    if (restoredContext.restored.length > 0) {
      opts.store.appendThreadMessages(
        (resume.record.checkpoint.captured ?? [])
          .filter((message) => message.payload !== undefined)
          .map((message) => ({
            threadKey: this.threadKey,
            timestamp: message.timestamp,
            role: message.role as "user" | "assistant" | "toolResult",
            content: message.content,
            ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
            payload: message.payload as PersistedRuntimeThreadPayload,
            preservePayloadExactly: true,
          })),
      );
    }
    const group = [
      ...(restoredContext.pendingAssistant
        ? [restoredContext.pendingAssistant]
        : []),
      ...restoredContext.resolved.map((entry) => entry.message),
    ] as PersistedRuntimeThreadPayload[];
    if (group.length > 0) {
      opts.store.commitRun((tasks) => {
        persistThreadPayloadMessages(opts.store, {
          threadKey: this.threadKey,
          payloads: group,
          runId,
          ...(typeof opts.agentContext.attemptGeneration === "number"
            ? { attemptGeneration: opts.agentContext.attemptGeneration }
            : {}),
          preservePayloadExactly: true,
        });
        const captured = snapshotCapturedTranscript(
          opts.store,
          this.threadKey,
          runId,
        );
        tasks.commitTurn(runId, captured ? { captured } : {});
      });
    }
    for (const entry of restoredContext.resolved) {
      if (entry.disposition === "interrupted") {
        opts.store.runTasks?.interruptIntent(runId, entry.call.id);
      }
      if (entry.disposition === "rerun") {
        opts.callbacks.onToolStart(
          runEvents.recordToolStart({
            toolCallId: entry.call.id,
            toolName: entry.call.name,
            toolArgs: entry.call.arguments ?? {},
          }),
        );
      }
      opts.callbacks.onToolEnd(
        runEvents.recordToolEnd({
          toolCallId: entry.call.id,
          toolName: entry.call.name,
          result: entry.message.content,
          details: entry.message.details,
          isError: entry.message.isError,
        }),
      );
    }
    agent.replaceMessages(restoredContext.messages);
    opts.agentContext.threadHistory = restoredContext.messages;
    this.logger.info("durable-run.resumed", {
      conversationId: this.conversationId,
      runId,
      resumeCount: resume.record.resumeCount,
      restoredMessages: restoredContext.restored.length,
      restoredPendingAssistant: restoredContext.pendingAssistant !== null,
      finalAnswer: restoredContext.final !== null,
      toolCalls: restoredContext.resolved.map((entry) => ({
        toolCallId: entry.call.id,
        toolName: entry.call.name,
        disposition: entry.disposition,
      })),
    });
    return { final: restoredContext.final };
  }

  /** Compaction swaps the prompt prefix at the next turn: stop warming it. */
  override notifyCompacted(): void {
    this.cacheWarmer.cancel();
    super.notifyCompacted();
  }

  override notifyHistoryChanged(): void {
    this.cacheWarmer.cancel();
    super.notifyHistoryChanged();
  }

  dispose(): void {
    if (this.idleEvictionTimer) {
      this.idleEvictionTimer.interruptUnsafe();
      this.idleEvictionTimer = null;
    }
    this.cacheWarmer.dispose();
    super.dispose();
    this.lastPromptCacheRequest = null;
    this.idleContext = null;
    this.currentResponseTargetTracker = null;
    this.currentRetryStatusContext = null;
    this.currentImageDescriptionContext = null;
    this.currentActiveWorkingSetContext = null;
  }
}

/**
 * Look up an existing session for this conversation, or build a new one
 * and store it on the provided map.
 *
 * Conversation-reset assumption: this helper assumes that
 * `conversationId` is unique per logical conversation for the lifetime
 * of the worker process. If the caller ever reuses the same
 * `conversationId` for a freshly-reset thread (e.g. a "new chat" UX
 * that recycles ids), the long-lived `Agent`'s `state.messages` would
 * still hold the OLD conversation's history, and the next `runTurn`
 * would only refresh from store when `pendingHistoryRefresh` is set
 * (which it isn't after a reset). Today every reset path the renderer
 * surfaces allocates a new id, so the issue is latent — but if you're
 * adding an id-reusing reset flow, call `dispose()` on the old session
 * (and `sessions.delete(conversationId)`) before the next turn lands.
 */
export const getOrCreateOrchestratorSession = (
  sessions: Map<string, OrchestratorSession>,
  conversationId: string,
): OrchestratorSession => {
  let session = sessions.get(conversationId);
  if (!session) {
    session = new OrchestratorSession(conversationId);
    sessions.set(conversationId, session);
  }
  return session;
};
