import { cleanupSessionResources } from "../../ai/session-resources.js";
import { createRuntimeLogger } from "../debug.js";
import { buildSafetyAbortSwapRoute, isProviderContentAbortMessage, parseQuarantineRecord, ProviderAbortContainment, QUARANTINE_CUSTOM_TYPE, } from "./provider-abort-containment.js";
import { createRuntimeAgent, resolveAgentThinkingLevel } from "./shared.js";
import { buildHistorySource } from "./thread-memory.js";
import { getThreadTokenEstimate } from "../thread-runtime.js";
import { CONTEXT_DELTA_CUSTOM_TYPE_PREFIX } from "./resident-context.js";
import { checkPromptPrefixStability, clearPromptPrefixSnapshot, } from "./prompt-prefix-guard.js";
import { clearProviderContextWindow, setProviderContextWindow, } from "./context-budget.js";
/**
 * Fraction of the model's real context window at which the orchestrator's
 * non-blocking "compact-while-you-talk" path degrades to blocking: if a
 * background compaction is still in flight AND the (un-compacted) thread has
 * already accumulated this share of the hard window, dispatching the next turn
 * risks overflowing the provider limit before the compaction that would
 * relieve it lands. At that point we wait for compaction instead. Sits above
 * the 0.7 compaction trigger so the common case stays non-blocking; the
 * remaining headroom to 1.0 covers the incoming turn's own output.
 */
const ORCHESTRATOR_COMPACTION_BLOCK_WINDOW_FRACTION = 0.9;
const resolveCodexProviderServiceTier = (resolvedLlm, agentContext) => {
    const snapshot = agentContext.modelConfigSnapshot;
    if (snapshot?.engine !== "codex_cli" ||
        resolvedLlm.model.api !== "openai-codex-responses") {
        return undefined;
    }
    // Codex represents Standard as an explicit `default` session setting but
    // omits it from the actual Responses request. The native provider has no
    // Codex session layer, so omission is the matching wire behavior.
    return snapshot.serviceTier === "fast" ? "priority" : undefined;
};
const safeSchemaJson = (value) => {
    try {
        return JSON.stringify(value) ?? "";
    }
    catch {
        return "";
    }
};
/** Provider-visible bytes per tool, snapshotted when the thread context freezes. */
const snapshotToolSchemas = (tools) => new Map((tools ?? []).map((tool) => [
    tool.name,
    {
        description: tool.description,
        parameters: tool.parameters,
        parametersJson: safeSchemaJson(tool.parameters),
    },
]));
/**
 * Shared mutable Pi-Agent state for long-lived runtime sessions.
 *
 * Orchestrators and subagents differ in prompt assembly and finalization, but
 * the live `Agent` lifecycle is the same: keep one Agent per durable thread,
 * update route/system/tools between turns, and refresh the in-memory message
 * mirror only at turn boundaries after background compaction lands.
 */
export class PiSessionCore {
    logger;
    agent = null;
    currentResolvedLlm = null;
    pendingHistoryRefresh = false;
    lastMemoryEnabled = null;
    /**
     * Thread-start (or last-boundary) snapshot of the provider-visible
     * context: the system prompt string and each tool's description +
     * parameter schema. Between boundaries the reused Agent keeps these
     * frozen bytes even when the freshly-computed values drift (locale
     * change, connector-surface switch mutating node_repl's demoted-tool
     * catalog), so the prompt-cache prefix stays byte-identical. The
     * snapshot re-adopts fresh values only at legitimate cache boundaries:
     * compaction/history refresh, the memory-preference toggle, or a
     * structural tool-set change (different tool names, e.g. a model switch
     * flipping the file-edit family).
     */
    frozenSystemPrompt = null;
    frozenToolSchemas = null;
    adoptFreshContextSnapshot = false;
    /** Signature of the last announced frozen-tools drift (dedup). */
    announcedToolDriftSignature = null;
    /**
     * Hidden `runtime.context_delta.*` messages queued by the freeze logic,
     * consumed into the next prompt build so the model hears about resident
     * context drift as an APPEND instead of a prefix rewrite. Persisted by
     * run-execution and swept at the next compaction fold-in.
     */
    pendingContextDeltaMessages = [];
    /**
     * Deterministic provider-abort tracking for this durable thread: instant
     * first-call failure counting and the request-assembly quarantine
     * registry. Survives across turns for the lifetime of the session.
     */
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
    /**
     * Inject a user message into an actively streaming Pi agent. The agent loop
     * consumes it at the next safe boundary without aborting the provider.
     */
    steerLiveAgent(message) {
        if (!this.canSteerLiveAgent || !this.agent)
            return false;
        this.agent.steer(message);
        return true;
    }
    /**
     * Flag that SQLite compaction wrote a new overlay. The next turn swaps the
     * live Agent's message array from freshly-loaded history before prompting.
     */
    notifyCompacted() {
        if (!this.agent)
            return;
        this.pendingHistoryRefresh = true;
    }
    /**
     * External conversation writers (for example realtime voice) append into
     * the same durable thread without going through this live Agent instance.
     * Refresh at the next turn boundary so switching surfaces keeps context.
     */
    notifyHistoryChanged() {
        this.pendingHistoryRefresh = true;
    }
    setResolvedLlm(resolvedLlm) {
        this.currentResolvedLlm = resolvedLlm;
        setProviderContextWindow(this.threadKey, resolvedLlm.model.contextWindow);
    }
    refreshHistoryIfNeeded(agentContext, logContext) {
        if (!this.pendingHistoryRefresh || !this.agent)
            return;
        const refreshed = buildHistorySource(agentContext);
        this.agent.state.messages = refreshed;
        this.pendingHistoryRefresh = false;
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
    refreshHistoryFromStoreIfNeeded(agentContext, store, logContext) {
        if (!this.pendingHistoryRefresh || !this.agent)
            return agentContext;
        const refreshedContext = {
            ...agentContext,
            threadHistory: store.loadThreadMessages(this.threadKey),
        };
        this.refreshHistoryIfNeeded(refreshedContext, logContext);
        return refreshedContext;
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
     *     thread has already reached
     *     {@link ORCHESTRATOR_COMPACTION_BLOCK_WINDOW_FRACTION} of the hard
     *     window while a compaction is still in flight.
     *
     * A rejected wait never fails the turn: background compaction failures are
     * logged by the scheduler, and the normal pre-generation overflow recovery
     * remains as the last-resort backstop.
     */
    async awaitPendingCompactionBeforeTurn(args) {
        const scheduler = args.compactionScheduler;
        if (!scheduler || typeof scheduler.pending !== "function")
            return;
        if (!scheduler.pending(this.threadKey))
            return;
        if (args.mode === "guard") {
            const window = Number(args.resolvedLlm?.model?.contextWindow);
            if (!Number.isFinite(window) || window <= 0)
                return;
            let estimate;
            try {
                estimate = getThreadTokenEstimate(args.store.loadThreadMessages(this.threadKey));
            }
            catch {
                // Can't assess the accumulated tail — preserve the non-blocking UX
                // and let pre-generation overflow recovery catch a genuine overflow.
                return;
            }
            if (estimate < window * ORCHESTRATOR_COMPACTION_BLOCK_WINDOW_FRACTION)
                return;
            this.logger.warn("compaction.block-imminent-overflow", {
                threadKey: this.threadKey,
                estimatedTokens: estimate,
                contextWindow: window,
                ...args.logContext,
            });
        }
        else {
            this.logger.debug("compaction.block-agent-turn", {
                threadKey: this.threadKey,
                ...args.logContext,
            });
        }
        try {
            // Drain the active run plus any queued follow-up so the next turn
            // starts on the compacted context. No new compaction is scheduled
            // during a turn boundary, so this loop terminates.
            let pending = scheduler.pending(this.threadKey);
            while (pending) {
                await pending;
                pending = scheduler.pending(this.threadKey);
            }
        }
        catch {
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
    beginAbortContainmentTurn(agent, agentContext, logContext) {
        const persisted = (agentContext.threadHistory ?? [])
            .map((entry) => entry.customMessage?.customType === QUARANTINE_CUSTOM_TYPE
            ? parseQuarantineRecord(entry.customMessage.content)
            : null)
            .filter((record) => record !== null);
        if (persisted.length > 0) {
            this.abortContainment.seedQuarantined(persisted);
        }
        const application = this.abortContainment.applyQuarantine(agent.state.messages);
        if (application.newlyQuarantined || application.reappliedKeys.length > 0) {
            this.logger.warn("provider-abort-quarantine", {
                threadKey: this.threadKey,
                reapplied: application.reappliedKeys,
                newlyQuarantined: application.newlyQuarantined,
                consecutiveInstantAborts: this.abortContainment.consecutiveInstantAbortCount,
                ...logContext,
            });
        }
        return {
            messagesBefore: agent.state.messages.length,
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
    prepareSafetyModelSwap(agent, args) {
        if (!this.currentResolvedLlm)
            return null;
        if (!isProviderContentAbortMessage(args.errorMessage))
            return null;
        const swap = buildSafetyAbortSwapRoute(this.currentResolvedLlm);
        if (!swap)
            return null;
        if (!this.popErroredTailForResume(agent))
            return null;
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
    prepareSafetySameModelRetry(agent, args) {
        if (!this.currentResolvedLlm)
            return null;
        if (!isProviderContentAbortMessage(args.errorMessage))
            return null;
        if (!buildSafetyAbortSwapRoute(this.currentResolvedLlm))
            return null;
        if (!this.popErroredTailForResume(agent))
            return null;
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
     * Prepare a transient run-level retry without appending another user turn.
     * Only the failed (or clean-but-empty) assistant tail is removed. Any tool
     * result immediately before it remains in context, so continuing resumes
     * after completed side effects instead of executing them again.
     */
    prepareAgentRunRetry(agent, args) {
        if (!args.failure.retryable)
            return false;
        if (!this.popErroredTailForResume(agent, {
            allowEmpty: args.failure.category === "empty_response",
        })) {
            return false;
        }
        this.logger.warn("agent-run-retry", {
            threadKey: this.threadKey,
            category: args.failure.category,
            providerError: args.failure.message,
            ...args.logContext,
        });
        return true;
    }
    /**
     * Pop the errored assistant tail so `continue()` resumes from the prompt
     * instead of refusing on a trailing assistant message. Inspects the tail
     * WITHOUT mutating it first: only commits to the pop once the retry is
     * definitely happening — bailing after a pop would corrupt the
     * appended-messages slice that failure classification reads, silently
     * resetting the deterministic-abort streak. Returns false when the tail
     * shape is unexpected (e.g. failure mid-tool-loop) and resuming would
     * throw.
     */
    popErroredTailForResume(agent, options) {
        const messages = agent.state.messages;
        const last = messages[messages.length - 1];
        const popErroredTail = last?.role === "assistant" &&
            (last.stopReason === "error" || last.stopReason === "aborted");
        const popEmptyTail = options?.allowEmpty === true &&
            last?.role === "assistant" &&
            !last.content.some((block) => block.type === "toolCall" ||
                (block.type === "text" && block.text.trim().length > 0));
        const popAssistantTail = popErroredTail || popEmptyTail;
        const tailAfterPop = popAssistantTail
            ? messages[messages.length - 2]
            : last;
        if (!tailAfterPop || tailAfterPop.role === "assistant") {
            return false;
        }
        if (popAssistantTail) {
            // Drop the failed stream's partial output or clean-but-empty reply.
            messages.pop();
        }
        return true;
    }
    noteAbortContainmentSuccess() {
        this.abortContainment.noteRunSuccess();
    }
    /**
     * Record a failed turn with the containment tracker. Returns the error
     * message to surface — the original, or the deterministic-abort
     * containment error once the threshold is reached.
     */
    noteAbortContainmentFailure(agent, args) {
        const messages = agent.state.messages;
        const surfaced = this.abortContainment.noteRunFailure({
            history: messages.slice(0, args.messagesBefore),
            appended: messages.slice(args.messagesBefore),
            errorMessage: args.errorMessage,
            swapAttempted: args.swapAttempted,
        });
        if (surfaced !== args.errorMessage) {
            this.logger.warn("deterministic-provider-abort", {
                threadKey: this.threadKey,
                consecutiveInstantAborts: this.abortContainment.consecutiveInstantAbortCount,
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
    /** Drain the queued resident-context delta messages for this turn's prompt. */
    takePendingContextDeltaMessages() {
        if (this.pendingContextDeltaMessages.length === 0) {
            return [];
        }
        const messages = this.pendingContextDeltaMessages;
        this.pendingContextDeltaMessages = [];
        return messages;
    }
    /**
     * Reused-agent context policy. Tool `execute` closures are rebuilt every
     * turn (they capture per-turn state like runId), but the provider-visible
     * bytes come from the frozen snapshot so the cached prefix survives:
     *
     *   - boundary (compaction refresh / memory toggle / structural tool-set
     *     change) → adopt fresh system prompt + tools and re-freeze;
     *   - otherwise → keep frozen bytes; when the freshly-computed bytes
     *     drifted (e.g. a desktop↔mobile surface switch changing
     *     node_repl's demoted-tool catalog), queue ONE hidden
     *     `runtime.context_delta.tools` note so the model learns about the
     *     change as an append. The real bytes swap at the next boundary.
     */
    applyFrozenContext(args) {
        const agent = this.agent;
        const frozen = this.frozenToolSchemas;
        const structuralToolChange = !this.frozenSystemPrompt ||
            !frozen ||
            frozen.size !== args.tools.length ||
            args.tools.some((tool) => !frozen.has(tool.name));
        const boundary = this.adoptFreshContextSnapshot || structuralToolChange;
        if (boundary) {
            if (structuralToolChange && !this.adoptFreshContextSnapshot) {
                // Accepted cache break: the available tool NAMES changed (model
                // switch flipping the file-edit family, extension hot-reload).
                // Frozen schemas for a tool that no longer exists would strand
                // calls, so the swap applies immediately and knowingly.
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
            const parametersMatch = tool.parameters === snapshot.parameters ||
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
            // Rare (locale / workspace-root / hook-append drift). Kept frozen;
            // the fresh prompt applies at the next compaction boundary.
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
                    text: `<system-reminder>Available tool definitions changed mid-conversation (${driftedToolNames.join(", ")}) — for example the set of integration tools reachable from the current delivery surface. Your visible tool schemas are a thread-start snapshot and refresh at the next context compaction; current callable signatures are always discoverable inside node_repl via await tools.$search({ query: "<capability>" }).</system-reminder>`,
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
        const serviceTier = resolveCodexProviderServiceTier(args.resolvedLlm, args.agentContext);
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
    dispose() {
        if (this.agent) {
            try {
                this.agent.abort();
            }
            catch {
                // Best-effort; the Agent may already be idle.
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
        // Release per-session provider resources keyed by the same id used as the
        // AI cache session id (the thread key), e.g. Codex WebSocket connections
        // and their transport/fallback bookkeeping.
        try {
            cleanupSessionResources(this.threadKey);
        }
        catch {
            // Best-effort; a failing cleanup shouldn't break session teardown.
        }
    }
}
