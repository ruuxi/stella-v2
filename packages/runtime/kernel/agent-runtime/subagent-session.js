import crypto from "crypto";
import { finalizeSubagentError, finalizeSubagentInterrupted, finalizeSubagentSuccess, resolveInterruptionReason, } from "./run-completion.js";
import { executeRuntimeAgentPrompt } from "./run-execution.js";
import { executeWithContextOverflowRecovery } from "./context-overflow-recovery.js";
import { buildSubagentSystemPrompt } from "./run-preparation.js";
import { createRunEventRecorder } from "./run-events.js";
import { PiSessionCore } from "./pi-session-core.js";
import { AGENT_RUN_MAX_ATTEMPTS, executeAgentTurnWithRetry, formatAgentRunRetryStatus, hasAgentRunAttemptBudget, } from "./agent-run-retry.js";
import { QUARANTINE_CUSTOM_TYPE, SAFETY_ABORT_FABLE_ATTEMPTS, safetyRetryStatusMessage, safetySwapStatusMessage, serializeQuarantineRecord, } from "./provider-abort-containment.js";
import { buildRunThreadKey, buildSubagentPromptMessages, persistThreadCustomMessage, persistThreadPayloadMessage, } from "./thread-memory.js";
import { createPiTools } from "./tool-adapters.js";
import { enrichImageContentForTextOnlyModel } from "./image-description.js";
export class SubagentSession extends PiSessionCore {
    threadId;
    conversationId;
    agentType;
    currentSteeringContext = null;
    externalLiveAgent = null;
    currentRetryStatusContext = null;
    currentImageDescriptionContext = null;
    handleProviderRetry = (info) => {
        if (info.attempt < 2)
            return;
        const context = this.currentRetryStatusContext;
        if (!context)
            return;
        const seconds = Math.max(1, Math.round(info.delayMs / 1_000));
        try {
            const event = context.recorder.recordStatus(`Task connection interrupted — reconnecting in ${seconds}s`, "provider-retry");
            context.callbacks?.onStatus?.(event);
        }
        catch {

        }
    };
    constructor(threadId, conversationId, agentType) {
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
        this.threadId = threadId;
        this.conversationId = conversationId;
        this.agentType = agentType;
    }
    get canSteer() {
        return (this.externalLiveAgent?.state.isStreaming === true ||
            this.canSteerLiveAgent);
    }
    steer(text) {
        const prompt = text.trim();
        const context = this.currentSteeringContext;
        if (!prompt || !context || !this.canSteer)
            return false;
        const message = {
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

    attachExternalLiveAgent(agent, context) {
        this.externalLiveAgent = agent;
        this.currentSteeringContext = context;
        return () => {
            if (this.externalLiveAgent === agent) {
                this.externalLiveAgent = null;
                this.currentSteeringContext = null;
            }
        };
    }
    async runTurn(opts) {
        const prompt = opts.userPrompt.trim();

        const runId = opts.runId ?? `local:sub:${crypto.randomUUID()}`;
        const effectiveSystemPrompt = await buildSubagentSystemPrompt({
            ...opts,
            runId,
        });

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
                opts.callbacks?.onStatus?.(runEvents.recordStatus("Compacting context", "compacting"));
            }
            catch {

            }
        };

        await this.maybeCompactForModelSwitch({
            opts,
            runId,
            onCompacting: emitCompactingStatus,
            logContext: { threadId: this.threadId, runId },
        });

        this.setResolvedLlm(opts.resolvedLlm);
        this.currentImageDescriptionContext = {
            model: opts.resolvedLlm.model,
            ...(opts.describeImages ? { describeImages: opts.describeImages } : {}),
        };

        await this.awaitPendingCompactionBeforeTurn({
            compactionScheduler: opts.compactionScheduler,
            mode: "blocking",
            onCompacting: emitCompactingStatus,
            logContext: { threadId: this.threadId, runId },
        });
        this.refreshHistoryIfNeeded(opts.agentContext, {
            threadId: this.threadId,
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
            logContext: {
                threadId: this.threadId,
                runId,
            },
        });
        const effectiveAgentContext = this.refreshHistoryFromStoreIfNeeded(opts.agentContext, opts.store, { threadId: this.threadId, runId });
        const containmentTurn = this.beginAbortContainmentTurn(agent, effectiveAgentContext, {
            threadId: this.threadId,
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
        runEvents.recordRunStart();
        if (opts.abortSignal?.aborted) {
            const reason = resolveInterruptionReason({ abortSignal: opts.abortSignal }) ??
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

            const contextDeltaMessages = this.takePendingContextDeltaMessages();
            const combinedPromptMessages = contextDeltaMessages.length > 0
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
                ...(opts.callbacks ? { callbacks: opts.callbacks } : {}),
                ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
                ...(opts.hookEmitter ? { hookEmitter: opts.hookEmitter } : {}),
                threadStore: opts.store,
                threadKey: this.threadKey,
                conversationId: opts.conversationId,
                ...(typeof opts.agentContext.attemptGeneration === "number"
                    ? { attemptGeneration: opts.agentContext.attemptGeneration }
                    : {}),
                ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
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
                    logContext: { threadId: this.threadId, runId },
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
                        threadId: this.threadId,
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
                    logContext: { threadId: this.threadId, runId },
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
        }
        catch (error) {
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
                errorMessage: error instanceof Error
                    ? error.message || "Subagent failed"
                    : String(error),
                swapAttempted,
                logContext: { threadId: this.threadId, runId },
            });
            const surfacedError = error instanceof Error && surfacedMessage === error.message
                ? error
                : new Error(surfacedMessage);
            return finalizeSubagentError({
                opts,
                runEvents,
                runId,
                error: surfacedError,
                threadKey: this.threadKey,
            });
        }
        finally {
            this.currentSteeringContext = null;
            this.currentRetryStatusContext = null;
            this.currentImageDescriptionContext = null;
        }
    }
    dispose() {
        super.dispose();
        this.externalLiveAgent = null;
        this.currentSteeringContext = null;
        this.currentRetryStatusContext = null;
        this.currentImageDescriptionContext = null;
    }
}

export const getOrCreateSubagentSession = (sessions, threadId, conversationId, agentType) => {
    let session = sessions.get(threadId);
    if (!session) {
        session = new SubagentSession(threadId, conversationId, agentType);
        sessions.set(threadId, session);
    }
    return session;
};
