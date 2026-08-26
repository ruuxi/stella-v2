import crypto from "crypto";
import {
  finalizeSubagentError,
  finalizeSubagentInterrupted,
  finalizeSubagentSuccess,
  resolveInterruptionReason,
} from "./run-completion.js";
import { executeRuntimeAgentPrompt } from "./run-execution.js";
import {
  AGENT_RUN_MAX_ATTEMPTS,
  executeAgentTurnWithRetry,
  formatAgentRunRetryStatus,
  hasAgentRunAttemptBudget,
} from "./agent-run-retry.js";
import { buildSubagentSystemPrompt } from "./run-preparation.js";
import {
  createRunEventRecorder,
  type RuntimeRunEventRecorder,
} from "./run-events.js";
import { PiSessionCore } from "./pi-session-core.js";
import {
  QUARANTINE_CUSTOM_TYPE,
  SAFETY_ABORT_FABLE_ATTEMPTS,
  safetyRetryStatusMessage,
  safetySwapStatusMessage,
  serializeQuarantineRecord,
} from "./provider-abort-containment.js";
import {
  buildRunThreadKey,
  buildSubagentPromptMessages,
  persistThreadCustomMessage,
  persistThreadPayloadMessage,
} from "./thread-memory.js";
import { createPiTools } from "./tool-adapters.js";
import { executeWithContextOverflowRecovery } from "./context-overflow-recovery.js";
import {
  enrichImageContentForTextOnlyModel,
  type ImageDescriptionService,
} from "./image-description.js";
import type { Api, Model } from "../../ai/types.js";
import type { AgentMessage } from "../agent-core/types.js";
import { createRunScopedStreamFn } from "./provider-stream-lifecycle.js";
import { streamSimple } from "../../ai/stream.js";
import type {
  RuntimeRunCallbacks,
  SubagentRunOptions,
  SubagentRunResult,
} from "./types.js";
import type { RuntimePromptMessage } from "@stella/contracts/protocol";

/**
 * Engine-neutral steering facade surface (see `createExternalLiveAgent` in
 * external-engines.ts). Only the members the session touches are typed here.
 */
type ExternalLiveSteerableAgent = {
  state: { isStreaming: boolean };
  steer: (message: AgentMessage) => void;
};

type SubagentSteeringContext = {
  store: import("../storage/runtime-store.js").RuntimeStore;
  runId: string;
  attemptGeneration?: number;
};

export class SubagentSession extends PiSessionCore {
  private currentSteeringContext: SubagentSteeringContext | null = null;
  private externalLiveAgent: ExternalLiveSteerableAgent | null = null;
  private currentRetryStatusContext: {
    recorder: RuntimeRunEventRecorder;
    callbacks?: Partial<RuntimeRunCallbacks>;
  } | null = null;
  private currentImageDescriptionContext: {
    model: Pick<Model<Api>, "input">;
    describeImages?: ImageDescriptionService;
  } | null = null;

  private handleProviderRetry = (info: {
    attempt: number;
    delayMs: number;
    reason?: string;
  }): void => {
    if (info.attempt < 2) return;
    const context = this.currentRetryStatusContext;
    if (!context) return;
    const seconds = Math.max(1, Math.round(info.delayMs / 1_000));
    try {
      const event = context.recorder.recordStatus(
        `Task connection interrupted — reconnecting in ${seconds}s`,
        "provider-retry",
      );
      context.callbacks?.onStatus?.(event);
    } catch {
      // Recovery must not fail because a status listener did.
    }
  };

  constructor(
    public readonly threadId: string,
    public readonly conversationId: string,
    public readonly agentType: string,
  ) {
    super({
      loggerName: "subagent-session",
      promptCacheKey: conversationId,
      threadKey: buildRunThreadKey({
        conversationId,
        agentType,
        runId: threadId,
        threadId,
      }),
    });
  }

  get canSteer(): boolean {
    return (
      this.externalLiveAgent?.state.isStreaming === true ||
      this.canSteerLiveAgent
    );
  }

  steer(text: string): boolean {
    const prompt = text.trim();
    const context = this.currentSteeringContext;
    if (!prompt || !context || !this.canSteer) return false;
    const message: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: Date.now(),
    };
    persistThreadPayloadMessage(context.store, {
      threadKey: this.threadKey,
      payload: message,
      runId: context.runId,
      ...(typeof context.attemptGeneration === "number"
        ? { attemptGeneration: context.attemptGeneration }
        : {}),
    });
    if (this.externalLiveAgent?.state.isStreaming === true) {
      this.externalLiveAgent.steer(message);
      return true;
    }
    return this.steerLiveAgent(message);
  }

  /**
   * Attach the engine-neutral steering facade used by Claude Code/Codex to
   * this durable subagent session. LocalAgentManager can then steer an
   * external General agent through the same `session.steer()` path as Pi.
   */
  attachExternalLiveAgent(
    agent: ExternalLiveSteerableAgent,
    context: SubagentSteeringContext,
  ): () => void {
    this.externalLiveAgent = agent;
    this.currentSteeringContext = context;
    return () => {
      if (this.externalLiveAgent === agent) {
        this.externalLiveAgent = null;
        this.currentSteeringContext = null;
      }
    };
  }

  async runTurn(opts: SubagentRunOptions): Promise<SubagentRunResult> {
    const prompt = opts.userPrompt.trim();

    // Generate the runId BEFORE building the system prompt so the
    // `before_agent_start` hook payload carries it. Same pattern as
    // `OrchestratorSession.runTurn`. Without the runId in the payload,
    // any hook that keys on it (e.g. a baseline cache) silently fails
    // to set up its run-scoped state.
    const runId = opts.runId ?? `local:sub:${crypto.randomUUID()}`;
    const effectiveSystemPrompt = await buildSubagentSystemPrompt({
      ...opts,
      runId,
    });

    // The recorder is side-effect-free to create and is needed this early
    // so the compaction waits below can surface a "compacting" indicator.
    const runEvents = createRunEventRecorder({
      store: opts.store,
      runId,
      conversationId: opts.conversationId,
      agentType: opts.agentType,
      userMessageId: opts.userMessageId,
      uiVisibility: opts.uiVisibility,
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
    // smaller-window route starts on a context it can actually hold.
    await this.maybeCompactForModelSwitch({
      opts,
      runId,
      onCompacting: emitCompactingStatus,
      logContext: { threadId: this.threadId, runId },
    });

    // Keep the reused Agent pointed at the current model route.
    this.setResolvedLlm(opts.resolvedLlm);
    this.currentImageDescriptionContext = {
      model: opts.resolvedLlm.model,
      ...(opts.describeImages ? { describeImages: opts.describeImages } : {}),
    };
    // Overflow-during-compaction guard: general agents and subagents do
    // real tool work and can burn a lot of tokens fast, so block on any
    // in-flight background compaction and resume this turn on the compacted
    // context instead of accumulating onto the uncompacted tail.
    await this.awaitPendingCompactionBeforeTurn({
      compactionScheduler: opts.compactionScheduler,
      mode: "blocking",
      onCompacting: emitCompactingStatus,
      logContext: { threadId: this.threadId, runId },
    });

    const tools = createPiTools({
      runId,
      rootRunId: opts.rootRunId ?? runId,
      agentId: opts.agentId,
      conversationId: opts.conversationId,
      agentType: opts.agentType,
      deviceId: opts.deviceId,
      stellaAppDir: opts.stellaAppDir,
      stellaDataDir: opts.stellaDataDir,
      toolWorkspaceRoot: opts.toolWorkspaceRoot,
      agentDepth: opts.agentContext.agentDepth ?? 0,
      maxAgentDepth: opts.agentContext.maxAgentDepth,
      parentAgentId: opts.agentContext.parentAgentId,
      modelConfigSnapshot: opts.agentContext.modelConfigSnapshot,
      // Inherited from the spawning orchestrator's run so subagent-side
      // tools that opt in (none today — `image_gen` is orchestrator-only)
      // can route their outputs back to the same connector. Subagents
      // don't *need* this for the current toolset; carry it so future
      // connector-aware tools work without another round of plumbing.
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
      systemPrompt: effectiveSystemPrompt,
      resolvedLlm: opts.resolvedLlm,
      agentContext: opts.agentContext,
      ...(opts.hookEmitter ? { hookEmitter: opts.hookEmitter } : {}),
      tools,
      afterToolCall: async (context, signal) => {
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
      logContext: {
        threadId: this.threadId,
        runId,
      },
    });
    const effectiveAgentContext = this.refreshHistoryFromStoreIfNeeded(
      opts.agentContext,
      opts.store,
      { threadId: this.threadId, runId },
    );

    // Provider streams opened this turn supervise as child fibers of the
    // root run's scope (fiber-derived abort, terminal-settlement join).
    // Reset every turn: the Agent is long-lived but the registrar is
    // per-run.
    agent.streamFn = opts.superviseRunResource
      ? createRunScopedStreamFn({
          supervise: opts.superviseRunResource,
          runId,
        })
      : streamSimple;

    const containmentTurn = this.beginAbortContainmentTurn(
      agent,
      effectiveAgentContext,
      {
        threadId: this.threadId,
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

    runEvents.recordRunStart();

    if (opts.abortSignal?.aborted) {
      const reason =
        resolveInterruptionReason({ abortSignal: opts.abortSignal }) ??
        "Canceled";
      const result = finalizeSubagentInterrupted({
        opts,
        runEvents,
        runId,
        reason,
        threadKey: this.threadKey,
      });
      this.currentImageDescriptionContext = null;
      return result;
    }

    this.currentRetryStatusContext = {
      recorder: runEvents,
      ...(opts.callbacks ? { callbacks: opts.callbacks } : {}),
    };
    this.currentSteeringContext = {
      store: opts.store,
      runId,
      ...(typeof opts.agentContext.attemptGeneration === "number"
        ? { attemptGeneration: opts.agentContext.attemptGeneration }
        : {}),
    };
    try {
      // Frozen-context drift notes (queued by createOrReuseAgent) ride as
      // hidden appends ahead of any caller-supplied prompt messages.
      const contextDeltaMessages = this.takePendingContextDeltaMessages();
      const combinedPromptMessages =
        contextDeltaMessages.length > 0
          ? [...contextDeltaMessages, ...(opts.promptMessages ?? [])]
          : opts.promptMessages;
      const promptMessages = await buildSubagentPromptMessages({
        context: effectiveAgentContext,
        userPrompt: prompt,
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
        ...(opts.callbacks ? { callbacks: opts.callbacks } : {}),
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
        ...(opts.hookEmitter ? { hookEmitter: opts.hookEmitter } : {}),
        threadStore: opts.store,
        threadKey: this.threadKey,
        conversationId: opts.conversationId,
        stellaDataDir: opts.stellaDataDir,
        ...(typeof opts.agentContext.attemptGeneration === "number"
          ? { attemptGeneration: opts.agentContext.attemptGeneration }
          : {}),
        ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
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
              logContext: { threadId: this.threadId, runId },
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
      let execution = await executeWithContextOverflowRecovery({
        execute: executeWithTransientRetry,
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
            threadId: this.threadId,
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
          logContext: { threadId: this.threadId, runId },
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
      const { finalText: result, errorMessage } = execution;

      const interruptedReason = resolveInterruptionReason({
        abortSignal: opts.abortSignal,
        error: errorMessage,
      });
      if (interruptedReason) {
        return finalizeSubagentInterrupted({
          opts,
          runEvents,
          runId,
          reason: interruptedReason,
          threadKey: this.threadKey,
        });
      }
      if (errorMessage) {
        throw new Error(errorMessage);
      }

      this.noteAbortContainmentSuccess();
      return await finalizeSubagentSuccess({
        opts,
        runEvents,
        runId,
        threadKey: this.threadKey,
        result,
        agentMessageCount: agent.state.messages.length,
      });
    } catch (error) {
      const interruptedReason = resolveInterruptionReason({
        abortSignal: opts.abortSignal,
        error,
      });
      if (interruptedReason) {
        return finalizeSubagentInterrupted({
          opts,
          runEvents,
          runId,
          reason: interruptedReason,
          threadKey: this.threadKey,
        });
      }
      const surfacedMessage = this.noteAbortContainmentFailure(agent, {
        messagesBefore: containmentTurn.messagesBefore,
        failureMessagesBefore: containmentTurn.failureMessagesBefore,
        errorMessage:
          error instanceof Error
            ? error.message || "Subagent failed"
            : String(error),
        swapAttempted,
        logContext: { threadId: this.threadId, runId },
      });
      const surfacedError =
        error instanceof Error && surfacedMessage === error.message
          ? error
          : new Error(surfacedMessage);
      return finalizeSubagentError({
        opts,
        runEvents,
        runId,
        error: surfacedError,
        threadKey: this.threadKey,
      });
    } finally {
      this.currentSteeringContext = null;
      this.currentRetryStatusContext = null;
      this.currentImageDescriptionContext = null;
    }
  }

  dispose(): void {
    super.dispose();
    this.externalLiveAgent = null;
    this.currentSteeringContext = null;
    this.currentRetryStatusContext = null;
    this.currentImageDescriptionContext = null;
  }
}

/**
 * Look up an existing session for the durable subagent threadId, or build
 * a new one and store it on the provided map.
 */
export const getOrCreateSubagentSession = (
  sessions: Map<string, SubagentSession>,
  threadId: string,
  conversationId: string,
  agentType: string,
): SubagentSession => {
  let session = sessions.get(threadId);
  if (!session) {
    session = new SubagentSession(threadId, conversationId, agentType);
    sessions.set(threadId, session);
  }
  return session;
};
