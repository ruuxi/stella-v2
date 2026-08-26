/**
 * State tools: spawn_agent / pause_agent / send_input / agent_status handlers.
 */
import { deriveRuntimeThreadLiveState, formatRuntimeThreadAge, runtimeThreadLastActiveAt, } from "../runtime-threads.js";
import { AGENT_PAUSE_CANCEL_REASON } from "../agents/local-agent-manager.js";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import { STELLA_DEFAULT_MODEL } from "@stella/contracts/stella-api";
import { isRegisteredModelReference } from "../../ai/models.js";
import { isOpenEndedModelReference, isRegisteredBareStellaModelReference, } from "../model-routing-matching.js";
const toOptionalString = (value) => {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};
const logWorkingIndicatorTrace = (label, payload) => {
    process.stderr.write(`${JSON.stringify({ label, ...payload })}\n`);
};
/** Engine ids accepted in spawn_agent's `model` parameter. */
const SPAWN_ENGINE_IDS = {
    codex: "codex_cli",
    "claude-code": "claude_code_local",
};
const SPAWN_REASONING_EFFORTS = new Set([
    "low",
    "medium",
    "high",
    "xhigh",
]);
const splitSpawnReasoningSuffix = (raw) => {
    const colon = raw.lastIndexOf(":");
    if (colon === -1)
        return undefined;
    const model = raw.slice(0, colon).trim();
    const suffix = raw
        .slice(colon + 1)
        .trim()
        .toLowerCase();
    return { model, suffix };
};
const invalidSpawnReasoningSuffix = (suffix) => new Error(`Invalid spawn_agent model reasoning suffix ":${suffix}". Expected one of :low, :medium, :high, or :xhigh; open-ended gateway references keep colons verbatim.`);
/**
 * Parses spawn_agent's optional `model` parameter:
 *
 *   - omitted / `default`            → the user's configured setup, untouched
 *   - `stella`                        → Stella's in-process engine
 *   - `codex` / `claude-code`        → that engine with its configured model
 *   - `codex/<m>` / `claude-code/<m>`→ that engine with `<m>` pinned
 *   - anything else                  → plain model reference, resolved through
 *                                      the normal model-routing path
 *
 * Closed known forms may end in `:low`, `:medium`, `:high`, or `:xhigh`.
 * Open-ended provider model identifiers preserve colons verbatim.
 */
export const parseSpawnAgentModel = (value, canResolveModel = () => false) => {
    const raw = toOptionalString(value);
    if (!raw)
        return { kind: "default" };
    // Registered full model references win over suffix interpretation.
    // This preserves legitimate ids such as `...:thinking`, `...:free`, and
    // even a future registered model whose id literally ends in `:high`.
    const fullReferenceIsModel = isRegisteredModelReference(raw) || isOpenEndedModelReference(raw);
    const suffixParts = splitSpawnReasoningSuffix(raw);
    let modelReference = raw;
    let reasoningEffort;
    if (!fullReferenceIsModel && suffixParts) {
        const suffixIsEffort = SPAWN_REASONING_EFFORTS.has(suffixParts.suffix);
        const slash = suffixParts.model.indexOf("/");
        const head = (slash === -1 ? suffixParts.model : suffixParts.model.slice(0, slash)).toLowerCase();
        const baseIsKnownForm = suffixParts.model === "default" ||
            suffixParts.model === STELLA_DEFAULT_MODEL ||
            suffixParts.model.toLowerCase() === "stella" ||
            Boolean(SPAWN_ENGINE_IDS[head]) ||
            isRegisteredModelReference(suffixParts.model) ||
            isRegisteredBareStellaModelReference(suffixParts.model) ||
            canResolveModel(suffixParts.model);
        if (baseIsKnownForm && !suffixIsEffort) {
            throw invalidSpawnReasoningSuffix(suffixParts.suffix);
        }
        if (baseIsKnownForm && suffixIsEffort) {
            modelReference = suffixParts.model;
            reasoningEffort = suffixParts.suffix;
        }
    }
    if (modelReference === "default") {
        return { kind: "default", ...(reasoningEffort ? { reasoningEffort } : {}) };
    }
    if (modelReference.toLowerCase() === "stella") {
        return {
            kind: "engine",
            engine: { engine: "default" },
            ...(reasoningEffort ? { reasoningEffort } : {}),
        };
    }
    const slash = modelReference.indexOf("/");
    // Engine ids are matched case-insensitively so `Codex/gpt-x` selects the
    // engine instead of falling through to a confusing route error.
    const head = (slash === -1 ? modelReference : modelReference.slice(0, slash)).toLowerCase();
    const engine = SPAWN_ENGINE_IDS[head];
    if (engine) {
        const model = slash === -1 ? undefined : modelReference.slice(slash + 1).trim();
        return {
            kind: "engine",
            engine: { engine, ...(model ? { model } : {}) },
            ...(reasoningEffort ? { reasoningEffort } : {}),
        };
    }
    return {
        kind: "model",
        model: modelReference,
        ...(reasoningEffort ? { reasoningEffort } : {}),
    };
};
const buildOtherThreadsResult = (threads, currentThreadId) => threads
    .filter((thread) => thread.threadId !== currentThreadId)
    .map((thread) => ({
    thread_id: thread.threadId,
    // Live execution state from the same runtime signal as the "# Other
    // Threads" roster: "active" = executing a turn now, "paused" = idle
    // but resumable via send_input.
    status: deriveRuntimeThreadLiveState(thread),
    last_active: formatRuntimeThreadAge(runtimeThreadLastActiveAt(thread)),
    ...(thread.description ? { description: thread.description } : {}),
}));
export const createStateContext = (stateRoot, agentApi, validateSpawnModel, validateSpawnModelWithMetadata, captureSpawnModelConfig) => ({
    stateRoot,
    tasks: new Map(),
    agentApi,
    validateSpawnModel,
    validateSpawnModelWithMetadata,
    captureSpawnModelConfig,
});
export const handleSendInput = async (ctx, args, context) => {
    const threadId = toOptionalString(args.thread_id) ?? toOptionalString(context.agentId);
    if (!ctx.agentApi?.sendAgentMessage) {
        return { error: "Agent input is not configured on this device." };
    }
    if (!threadId) {
        return { error: "thread_id is required" };
    }
    const message = toOptionalString(args.message);
    if (!message) {
        return { error: "message is required" };
    }
    const delivered = await ctx.agentApi.sendAgentMessage(threadId, message, "orchestrator", {
        ...(context.rootRunId ? { rootRunId: context.rootRunId } : {}),
        ...(context.agentType === AGENT_IDS.ORCHESTRATOR &&
            context.modelConfigSnapshot
            ? { modelConfigSnapshot: context.modelConfigSnapshot }
            : {}),
        deliveryKind: "external-input",
    });
    if (!delivered.delivered) {
        return { error: delivered.reason ?? `Thread not found: ${threadId}` };
    }
    return {
        result: {
            status: "delivered_agent_still_working",
            thread_id: threadId,
            note: "Delivered. This does NOT mean the task is done — the agent is still working. Wait for the [Agent completed] event; do not immediately re-check status.",
            delivered: true,
        },
    };

};
/** Codex engine id whose transcripts carry reasoning summaries, not text. */
const CODEX_ENGINE_ID = "codex_cli";
const AGENT_STATUS_MESSAGE_LIMIT = 4;
const AGENT_STATUS_TEXT_CHARS = 2_000;
const AGENT_STATUS_ARGS_CHARS = 4_000;
const boundAgentStatusText = (value, maxChars) => {
    const text = String(value ?? "").trim();
    if (text.length <= maxChars)
        return text;
    return `${text.slice(0, maxChars).trimEnd()}... [truncated]`;
};
const joinAssistantBlocks = (blocks, type, field) => blocks
    .flatMap((block) => block?.type === type &&
    typeof block[field] === "string" &&
    block[field].trim()
    ? [block[field].trim()]
    : [])
    .join("\n\n")
    .trim();
/**
 * Read-only `agent_status` handler. Projects a durable-thread snapshot into
 * the live status, the last few assistant messages (reasoning summaries for
 * Codex-engine threads), and the most recent tool CALL — never a tool result,
 * and never any delivery into the target thread.
 */
export const handleAgentStatus = async (ctx, args) => {
    const threadId = toOptionalString(args.thread_id);
    if (!threadId) {
        return { error: "thread_id is required" };
    }
    if (!ctx.agentApi?.readAgentThreadStatus) {
        return { error: "Agent status is not available on this device." };
    }
    const snapshot = await ctx.agentApi.readAgentThreadStatus(threadId);
    if (!snapshot) {
        return { error: `Thread not found: ${threadId}` };
    }
    // Codex surfaces reasoning summaries as its visible narration; native
    // engines author plain text blocks. Chronological walk keeps "latest
    // tool call" honest even if the store returns rows out of order.
    const isCodex = snapshot.engine === CODEX_ENGINE_ID;
    const ordered = [...snapshot.messages].sort((a, b) => a.timestamp - b.timestamp);
    const assistantMessages = [];
    let latestToolCall;
    for (const message of ordered) {
        const payload = message.payload;
        if (payload?.role !== "assistant" || !Array.isArray(payload.content)) {
            continue;
        }
        const text = joinAssistantBlocks(payload.content, "text", "text");
        const reasoning = joinAssistantBlocks(payload.content, "thinking", "thinking");
        const content = isCodex ? reasoning || text : text;
        if (content) {
            assistantMessages.push({
                timestamp: new Date(message.timestamp).toISOString(),
                content: boundAgentStatusText(content, AGENT_STATUS_TEXT_CHARS),
            });
        }
        for (const block of payload.content) {
            if (block?.type !== "toolCall")
                continue;
            let toolArguments = block.arguments ?? {};
            try {
                const serialized = JSON.stringify(toolArguments) ?? "";
                if (serialized.length > AGENT_STATUS_ARGS_CHARS) {
                    toolArguments = boundAgentStatusText(serialized, AGENT_STATUS_ARGS_CHARS);
                }
            }
            catch {
                toolArguments = "[Unserializable tool arguments]";
            }
            latestToolCall = {
                timestamp: new Date(message.timestamp).toISOString(),
                tool_name: block.name,
                arguments: toolArguments,
            };
        }
    }
    const now = Date.now();
    return {
        result: {
            thread_id: threadId,
            // Same live signal as the "# Other Threads" roster.
            status: snapshot.status,
            ...(snapshot.statusLabel && snapshot.statusLabel !== snapshot.status
                ? { status_detail: snapshot.statusLabel }
                : {}),
            ...(snapshot.description ? { description: snapshot.description } : {}),
            ...(typeof snapshot.lastActiveAt === "number"
                ? { last_active_at: new Date(snapshot.lastActiveAt).toISOString() }
                : {}),
            recent_assistant_messages: assistantMessages.slice(-AGENT_STATUS_MESSAGE_LIMIT),
            ...(latestToolCall ? { latest_tool_call: latestToolCall } : {}),
            current_time: new Date(now).toISOString(),
            note: "Read-only snapshot; the agent was NOT interrupted or messaged. To steer or ask it something, use send_input.",
        },
    };
};
export const handleSpawnAgent = async (ctx, args, context) => {
    const action = toOptionalString(args.action)?.toLowerCase();
    const explicitThreadId = toOptionalString(args.thread_id);
    if ((action === "cancel" || action === "stop") && explicitThreadId) {
        // Pin the cancel reason to a sentinel so the runner can recognize
        // orchestrator-initiated pause_agent and skip the hidden `[Task canceled]`
        // follow-up turn — that follow-up was clobbering the user-facing reply
        // because it produced an empty assistant message that overwrote the
        // orchestrator's actual response to the pause request.
        if (ctx.agentApi) {
            const canceled = await ctx.agentApi.cancelAgent(explicitThreadId, AGENT_PAUSE_CANCEL_REASON);
            if (!canceled.canceled) {
                return { error: `Thread not found: ${explicitThreadId}` };
            }
            return {
                result: {
                    thread_id: explicitThreadId,
                    status: "canceled",
                    canceled: true,
                },
            };
        }
        const localRecord = ctx.tasks.get(explicitThreadId);
        if (!localRecord)
            return { error: `Thread not found: ${explicitThreadId}` };
        localRecord.status = "error";
        localRecord.error = AGENT_PAUSE_CANCEL_REASON;
        localRecord.completedAt = Date.now();
        return {
            result: {
                thread_id: explicitThreadId,
                status: "canceled",
                canceled: true,
            },
        };
    }
    const agentType = AGENT_IDS.GENERAL;
    // The root orchestrator has no thread identity of its own, so this resolves
    // to undefined there and the spawn is top-level. A General parent always has
    // one, which is what makes its children route back to it instead of root.
    const parentAgentId = toOptionalString(context.agentId);
    const storageMode = context.storageMode ?? "local";
    const parentAgentDepth = Math.max(0, context.agentDepth ?? 0);
    const nextAgentDepth = parentAgentDepth + 1;
    const maxAgentDepth = context.maxAgentDepth;
    if (context.agentType !== AGENT_IDS.ORCHESTRATOR &&
        context.agentType !== AGENT_IDS.GENERAL) {
        return {
            error: "Only the orchestrator or a General agent can create tasks.",
        };
    }
    // agent_type was removed with the custom-agent-types story; error loudly
    // instead of silently ignoring a stale argument.
    if (toOptionalString(args.agent_type)) {
        return {
            error: "agent_type has been removed from spawn_agent. Every spawn runs the general agent; use the optional `model` parameter to pick a model or engine instead.",
        };
    }
    if (Object.prototype.hasOwnProperty.call(args, "group")) {
        return {
            error: "group has been removed from spawn_agent. Spawn a General agent and let it run its own subagents to coordinate related multi-agent work.",
        };
    }
    let modelSelection;
    try {
        modelSelection = parseSpawnAgentModel(args.model, (modelName) => {
            if (!ctx.validateSpawnModel)
                return false;
            try {
                ctx.validateSpawnModel(modelName);
                return true;
            }
            catch {
                return false;
            }
        });
    }
    catch (error) {
        return { error: error.message };
    }
    if (modelSelection.kind === "model") {
        // Fail the spawn loudly on an unroutable model — never silently fall
        // back to the configured default. A host without a validator can't
        // honor the override, which is also a loud failure, not a fallback.
        if (!ctx.validateSpawnModel && !ctx.validateSpawnModelWithMetadata) {
            return {
                error: `Cannot honor model "${modelSelection.model}": model routing is not available in this runtime. Omit the model parameter to use the configured default.`,
            };
        }
        try {
            if (ctx.validateSpawnModelWithMetadata) {
                await ctx.validateSpawnModelWithMetadata(modelSelection.model, modelSelection.reasoningEffort);
            }
            else {
                ctx.validateSpawnModel?.(modelSelection.model);
            }
        }
        catch (error) {
            return { error: error.message };
        }
    }
    if (typeof maxAgentDepth === "number" && nextAgentDepth > maxAgentDepth) {
        return {
            error: `Task depth limit reached (${maxAgentDepth}). Complete work in the current task instead of creating another subtask.`,
        };
    }
    const prompt = toOptionalString(args.prompt);
    if (!prompt) {
        return { error: "prompt is required" };
    }
    const rawDescription = toOptionalString(args.description);
    if (!rawDescription) {
        return { error: "description is required" };
    }
    const description = rawDescription;
    if (ctx.agentApi) {
        logWorkingIndicatorTrace("[stella:working-indicator:spawn_agent]", {
            conversationId: context.conversationId,
            rawDescription,
            description,
            promptPreview: prompt.slice(0, 160),
            rootRunId: context.rootRunId,
        });
        let capturedModelConfig;
        if (ctx.captureSpawnModelConfig &&
            (modelSelection.kind !== "default" ||
                context.agentType === AGENT_IDS.ORCHESTRATOR)) {
            try {
                capturedModelConfig = await ctx.captureSpawnModelConfig({
                    agentType,
                    spawnEngine: modelSelection.kind === "model"
                        ? { engine: "default" }
                        : modelSelection.kind === "engine"
                            ? modelSelection.engine
                            : { engine: "default" },
                    ...(modelSelection.kind === "default"
                        ? { useConfiguredEngine: true }
                        : {}),
                    ...(modelSelection.kind === "model"
                        ? { model: modelSelection.model }
                        : {}),
                    ...(modelSelection.reasoningEffort
                        ? { spawnReasoningEffort: modelSelection.reasoningEffort }
                        : {}),
                });
            }
            catch (error) {
                return { error: error.message };
            }
        }
        let created;
        try {
            created = await ctx.agentApi.createAgent({
                conversationId: context.conversationId,
                description,
                prompt,
                agentType,
                ...(modelSelection.kind === "model"
                    ? { model: modelSelection.model }
                    : {}),
                ...(modelSelection.kind === "model"
                    ? { spawnEngine: { engine: "default" } }
                    : {}),
                ...(modelSelection.kind === "engine"
                    ? { spawnEngine: modelSelection.engine }
                    : {}),
                ...(modelSelection.reasoningEffort
                    ? { spawnReasoningEffort: modelSelection.reasoningEffort }
                    : {}),
                ...(capturedModelConfig
                    ? { modelConfigSnapshot: capturedModelConfig }
                    : modelSelection.kind === "default" && context.modelConfigSnapshot
                        ? { modelConfigSnapshot: context.modelConfigSnapshot }
                        : {}),
                rootRunId: context.rootRunId,
                agentDepth: nextAgentDepth,
                ...(typeof maxAgentDepth === "number" ? { maxAgentDepth } : {}),
                parentAgentId,
                storageMode,
            });
        }
        catch (error) {
            // Group member caps and thread-resolution failures surface as tool
            // errors the model can act on, not as runner-level crashes.
            return { error: error.message };
        }
        const otherThreads = context.agentType === AGENT_IDS.ORCHESTRATOR && created.activeThreads
            ? buildOtherThreadsResult(created.activeThreads, created.threadId)
            : [];
        return {
            result: {
                status: "spawned_running_in_background",
                thread_id: created.threadId,
                note: "The agent is now working in the background and has NOT finished. Do not describe the task as if it never started, and do not call send_input to check on it — wait for the [Agent completed] event. In this turn, reply to the user with at most one short line, or say nothing.",
                // Back-compat booleans (kept after status/note so they can't read as "done").
                created: true,
                running_in_background: true,
                follow_up_on_completion: true,
                ...(otherThreads.length > 0 ? { other_threads: otherThreads } : {}),
            },
        };

    }
    // Fallback local in-memory task behavior (used only when no task manager is wired).
    const id = String(ctx.tasks.size + 1);
    const record = {
        id,
        description,
        status: "running",
        startedAt: Date.now(),
        completedAt: null,
    };
    ctx.tasks.set(id, record);
    const activeThreads = [...ctx.tasks.values()].slice(-16).map((task) => ({
        threadId: task.id,
        description: task.description,
        lastUsedAt: task.completedAt ?? task.startedAt,
        agentStatus: task.status,
    }));
    const otherThreads = context.agentType === AGENT_IDS.ORCHESTRATOR
        ? buildOtherThreadsResult(activeThreads, id)
        : [];
    return {
        result: {
            status: "spawned_running_in_background",
            thread_id: id,
            note: "The agent is now working in the background and has NOT finished. Do not describe the task as if it never started, and do not call send_input to check on it — wait for the [Agent completed] event. In this turn, reply to the user with at most one short line, or say nothing.",
            // Back-compat booleans (kept after status/note so they can't read as "done").
            created: true,
            running_in_background: true,
            follow_up_on_completion: true,
            ...(otherThreads.length > 0 ? { other_threads: otherThreads } : {}),
        },
    };

};
