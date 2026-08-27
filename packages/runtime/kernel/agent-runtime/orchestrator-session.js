import crypto from "crypto";
import { finalizeOrchestratorError, finalizeOrchestratorInterrupted, finalizeOrchestratorSuccess, markOrchestratorErrorReported, resolveInterruptionReason, } from "./run-completion.js";
import { executeRuntimeAgentPrompt, isDurablyPersistedRuntimePromptInput, } from "./run-execution.js";
import { executeWithContextOverflowRecovery } from "./context-overflow-recovery.js";
import { enrichImageContentForTextOnlyModel } from "./image-description.js";
import { buildRuntimeSystemPrompt } from "./run-preparation.js";
import { createRunEventRecorder } from "./run-events.js";
import { createOrchestratorResponseTargetTracker } from "./response-target.js";
import { PiSessionCore } from "./pi-session-core.js";
import { AGENT_RUN_MAX_ATTEMPTS, executeAgentTurnWithRetry, formatAgentRunRetryStatus, hasAgentRunAttemptBudget, } from "./agent-run-retry.js";
import { QUARANTINE_CUSTOM_TYPE, SAFETY_ABORT_FABLE_ATTEMPTS, safetyRetryStatusMessage, safetySwapStatusMessage, serializeQuarantineRecord, } from "./provider-abort-containment.js";
import { buildOrchestratorPromptMessages, buildRunThreadKey, persistThreadCustomMessage, } from "./thread-memory.js";
import { createPiTools } from "./tool-adapters.js";

const ORCHESTRATOR_SESSION_RUN_ID = "session";
const ORCHESTRATOR_AGENT_IDLE_EVICTION_MS = 5 * 60 * 1000;
const runtimeInternalText = (message) => Array.isArray(message.content)
    ? message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
    : message.content;
const removeTransientRuntimePromptInputs = (agent, inputs, messagesBefore) => {
    const remaining = inputs
        .filter((input) => input.messageType === "message" &&
        !isDurablyPersistedRuntimePromptInput(input))
        .map((input) => ({ customType: input.customType, text: input.text }));
    if (remaining.length === 0)
        return false;
    const messages = agent.state.messages;
    const nextMessages = messages.filter((message, index) => {
        if (index < messagesBefore || message.role !== "runtimeInternal")
            return true;
        const matchIndex = remaining.findIndex((input) => input.customType === message.customType &&
            input.text === runtimeInternalText(message));
        if (matchIndex < 0)
            return true;
        remaining.splice(matchIndex, 1);
        return false;
    });
    if (nextMessages.length === messages.length)
        return false;
    agent.replaceMessages(nextMessages);
    return true;
};
export class OrchestratorSession extends PiSessionCore {
    conversationId;
    idleEvictionTimer = null;
    activeTurnCount = 0;

    currentResponseTargetTracker = null;

    currentRetryStatusContext = null;
    currentImageDescriptionContext = null;

    currentActiveWorkingSetContext = null;
    hasUnresolvedThreadPersistenceFailure = false;
    scheduleIdleEviction() {
        if (this.idleEvictionTimer) {
            clearTimeout(this.idleEvictionTimer);
            this.idleEvictionTimer = null;
        }
        if (this.activeTurnCount > 0 || this.hasUnresolvedThreadPersistenceFailure)
            return;
        this.idleEvictionTimer = setTimeout(() => {
            this.idleEvictionTimer = null;
            if (this.activeTurnCount > 0)
                return;
            this.dispose();
        }, ORCHESTRATOR_AGENT_IDLE_EVICTION_MS);
        this.idleEvictionTimer.unref?.();
    }
    constructor(conversationId) {
        super({
            loggerName: "orchestrator-session",
            promptCacheKey: conversationId,
            threadKey: buildRunThreadKey({
                conversationId,
                agentType: "orchestrator",
                runId: ORCHESTRATOR_SESSION_RUN_ID,
            }),
        });
        this.conversationId = conversationId;
    }

    handleProviderRetry = (info) => {
        if (info.attempt < 2)
            return;
        const ctx = this.currentRetryStatusContext;
        if (!ctx)
            return;
        const seconds = Math.max(1, Math.round(info.delayMs / 1000));
        const statusText = `Stella is having trouble reaching the server — trying again in ${seconds}s`;
        try {
            const event = ctx.recorder.recordStatus(statusText, "provider-retry");
            ctx.callbacks?.onStatus?.(event);
        }
        catch {

        }
    };
    handleActiveTurnBoundary = async (context, signal) => {
        const current = this.currentActiveWorkingSetContext;
        if (!current)
            return undefined;

        current.containmentTurn.messagesBefore = Math.max(0, context.context.messages.length - context.completedMessages.length);

        current.containmentTurn.failureMessagesBefore = context.context.messages.length;

        if (current.refreshBlocked || context.pendingMessages.length > 0 || this.agent?.hasQueuedMessages()) {
            return undefined;
        }
        const turnStartIndex = Math.min(context.context.messages.length, Math.max(0, current.containmentTurn.messagesBefore));
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
            canApply: () => {
                if (this.currentActiveWorkingSetContext !== current ||
                    context.pendingMessages.length > 0 ||
                    this.agent?.hasQueuedMessages()) {
                    return false;
                }
                return true;
            },
            logContext: {
                conversationId: this.conversationId,
                runId: current.runId,
            },
        });
        if (replacement && this.currentActiveWorkingSetContext === current) {

            current.containmentTurn.messagesBefore = replacement.length - currentTurnTail.length;
            current.containmentTurn.failureMessagesBefore = replacement.length;
        }
        return replacement;
    };
    async runTurn(opts) {
        if (this.hasUnresolvedThreadPersistenceFailure) {
            throw new Error("Cannot continue this live session after an unresolved thread persistence failure.");
        }
        if (this.idleEvictionTimer) {
            clearTimeout(this.idleEvictionTimer);
            this.idleEvictionTimer = null;
        }
        this.activeTurnCount += 1;
        try {
            return await this.runActiveTurn(opts);
        }
        finally {
            this.activeTurnCount = Math.max(0, this.activeTurnCount - 1);
            if (this.activeTurnCount === 0)
                this.scheduleIdleEviction();
        }
    }
    async runActiveTurn(opts) {
        const runId = opts.runId ?? `local:${crypto.randomUUID()}`;
        const turnOpts = opts.runId === runId ? opts : { ...opts, runId };
        const effectiveSystemPrompt = await buildRuntimeSystemPrompt(turnOpts);

        const responseTargetTracker = createOrchestratorResponseTargetTracker(opts.responseTarget);
        this.currentResponseTargetTracker = responseTargetTracker;
        const runEvents = createRunEventRecorder({
            store: opts.store,
            runId,
            conversationId: opts.conversationId,
            agentType: opts.agentType,
            userMessageId: opts.userMessageId,
            uiVisibility: opts.uiVisibility,
            getResponseTarget: () => responseTargetTracker.resolve() ?? opts.responseTarget,
        });
        const emitCompactingStatus = () => {
            try {
                opts.callbacks?.onStatus?.(runEvents.recordStatus("Compacting context", "compacting"));
            }
            catch {

            }
        };

        await this.maybeCompactForModelSwitch({
            opts,
            runId,
            onCompacting: emitCompactingStatus,
            logContext: { conversationId: this.conversationId, runId },
        });

        this.setResolvedLlm(opts.resolvedLlm);

        await this.awaitPendingCompactionBeforeTurn({
            compactionScheduler: opts.compactionScheduler,
            store: opts.store,
            resolvedLlm: opts.resolvedLlm,
            mode: "guard",
            onCompacting: emitCompactingStatus,
            logContext: { conversationId: this.conversationId, runId },
        });

        const refreshedAgentContext = this.refreshHistoryFromStoreIfNeeded(opts.agentContext, opts.store, {
            conversationId: this.conversationId,
        });
        if (refreshedAgentContext !== opts.agentContext) {
            opts.agentContext.threadHistory = refreshedAgentContext.threadHistory;
        }
        this.currentImageDescriptionContext = {
            model: opts.resolvedLlm.model,
            ...(opts.describeImages ? { describeImages: opts.describeImages } : {}),
        };
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
            connectorDeliveryTarget: opts.connectorDeliveryTarget,
            toolsAllowlist: opts.agentContext.toolsAllowlist,
            toolCatalog: opts.toolCatalog,
            store: opts.store,
            toolExecutor: opts.toolExecutor,
            hookEmitter: opts.hookEmitter,
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
                this.currentResponseTargetTracker?.noteToolEnd(context.toolCall.name, context.result.details);
                const imageContext = this.currentImageDescriptionContext;
                if (!imageContext)
                    return undefined;
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
        const containmentTurn = this.beginAbortContainmentTurn(agent, opts.agentContext, {
            conversationId: this.conversationId,
            runId,
        });
        if (containmentTurn.newlyQuarantined) {

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
        let swapAttempted;
        opts.onExecutionSessionCreated?.({
            runId,
            threadKey: this.threadKey,
            engine: "native",
            queueUserMessageId: runEvents.queueUserMessageId,
            agent,
        });
        runEvents.recordRunStart();
        if (opts.abortSignal?.aborted) {
            const reason = resolveInterruptionReason({ abortSignal: opts.abortSignal }) ??
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
        let transientRuntimePromptInputs = [];
        const transientRuntimePromptStart = containmentTurn.messagesBefore;
        const dropTransientRuntimePromptInputs = () => {
            if (removeTransientRuntimePromptInputs(agent, transientRuntimePromptInputs, transientRuntimePromptStart)) {
                opts.agentContext.threadHistory = agent.state.messages;
            }
            transientRuntimePromptInputs = [];
        };
        try {

            const contextDeltaMessages = this.takePendingContextDeltaMessages();
            const combinedPromptMessages = contextDeltaMessages.length > 0
                ? [...contextDeltaMessages, ...(opts.promptMessages ?? [])]
                : opts.promptMessages;
            const promptMessages = await buildOrchestratorPromptMessages({
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
            const workingSetContext = this.currentActiveWorkingSetContext;
            transientRuntimePromptInputs = promptMessages.filter((message) => message.messageType === "message" &&
                !isDurablyPersistedRuntimePromptInput(message));
            if (workingSetContext?.runId === runId &&
                transientRuntimePromptInputs.length > 0) {

                workingSetContext.refreshBlocked = true;
            }
            const executionArgs = {
                agent,
                promptMessages: promptMessages.map((message, index) => ({
                    ...message,
                    ...(index === promptMessages.length - 1 && opts.attachments?.length
                        ? { attachments: opts.attachments }
                        : {}),
                })),
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
            };
            const retryState = { attemptsUsed: 0, retriesUsed: 0 };
            const executeWithTransientRetry = (initialResume = false) => executeAgentTurnWithRetry({
                state: retryState,
                initialResume,
                execute: (resume) => executeRuntimeAgentPrompt({
                    ...executionArgs,
                    ...(resume ? { resume: true } : {}),
                }),
                prepareRetry: (failure) => this.prepareAgentRunRetry(agent, {
                    failure,
                    store: opts.store,
                    runId,
                    logContext: { conversationId: this.conversationId, runId },
                }),
                ...(opts.abortSignal ? { signal: opts.abortSignal } : {}),
                onRetry: (info) => {
                    opts.callbacks?.onStatus?.(runEvents.recordStatus(formatAgentRunRetryStatus(info), "provider-retry"));
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

            let fableAttempts = 1;
            while (execution.errorMessage &&
                !opts.abortSignal?.aborted &&
                hasAgentRunAttemptBudget(retryState, AGENT_RUN_MAX_ATTEMPTS) &&
                fableAttempts < SAFETY_ABORT_FABLE_ATTEMPTS) {
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
                if (!retry)
                    break;
                fableAttempts += 1;
                opts.callbacks?.onStatus?.(runEvents.recordStatus(safetyRetryStatusMessage({
                    modelId: retry.modelId,
                    attempt: fableAttempts,
                }), "running"));
                execution = await executeWithTransientRetry(true);
            }

            if (execution.errorMessage &&
                !opts.abortSignal?.aborted &&
                hasAgentRunAttemptBudget(retryState, AGENT_RUN_MAX_ATTEMPTS)) {
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
                    opts.callbacks?.onStatus?.(runEvents.recordStatus(statusText, "model-fallback"));
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
        }
        catch (error) {
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
                errorMessage: error instanceof Error
                    ? error.message || "Stella runtime failed"
                    : String(error),
                swapAttempted,
                logContext: { conversationId: this.conversationId, runId },
            });
            const surfacedError = error instanceof Error && surfacedMessage === error.message
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
        }
        finally {
            dropTransientRuntimePromptInputs();
            this.currentResponseTargetTracker = null;
            this.currentRetryStatusContext = null;
            this.currentImageDescriptionContext = null;
            this.currentActiveWorkingSetContext = null;
        }
    }
    dispose() {
        if (this.idleEvictionTimer) {
            clearTimeout(this.idleEvictionTimer);
            this.idleEvictionTimer = null;
        }
        super.dispose();
        this.currentResponseTargetTracker = null;
        this.currentRetryStatusContext = null;
        this.currentImageDescriptionContext = null;
        this.currentActiveWorkingSetContext = null;
    }
}

export const getOrCreateOrchestratorSession = (sessions, conversationId) => {
    let session = sessions.get(conversationId);
    if (!session) {
        session = new OrchestratorSession(conversationId);
        sessions.set(conversationId, session);
    }
    return session;
};
