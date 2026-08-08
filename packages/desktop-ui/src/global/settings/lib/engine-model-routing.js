import { DEFAULT_CODEX_MODEL } from "@stella/contracts/agent-engine";
export const OPENAI_CODEX_PROVIDER = "openai-codex";
export const DEFAULT_CHATGPT_MODEL = DEFAULT_CODEX_MODEL;
export const DEFAULT_CLAUDE_CODE_MODEL = "default";
const CONVERSATION_AGENT_KEYS = ["orchestrator", "general"];
export function listChatGptCatalogModels(models) {
    return models.filter((model) => model.provider === OPENAI_CODEX_PROVIDER);
}
export function codexModelSupportsFast(model) {
    if (!model)
        return false;
    return (model.serviceTiers?.some((tier) => tier.id === "priority") === true ||
        model.additionalSpeedTiers?.includes("fast") === true);
}
/** Only models accepted by both the OAuth orchestrator and Codex runtime. */
export function intersectChatGptModels(catalog, liveModels) {
    const liveIds = new Set(liveModels.filter((model) => !model.hidden).map((model) => model.id));
    return listChatGptCatalogModels(catalog).filter((model) => liveIds.has(model.modelId));
}
/**
 * ChatGPT is directly selectable: the only real gate is OpenAI auth, never a
 * forced model pick. When the requested/saved model isn't in the live catalog
 * we auto-match to the closest available OpenAI model instead of dead-ending
 * the user — preferring the exact request, then the default, then the first
 * available id. Returns null only when the catalog is genuinely empty.
 */
export function resolveChatGptModelSelection(requested, available, fallback) {
    if (available.length === 0)
        return null;
    const req = requested?.trim();
    if (req && available.includes(req))
        return req;
    const fb = fallback.trim();
    if (fb && available.includes(fb))
        return fb;
    return available[0];
}
/**
 * Classify how a ChatGPT model selection should resolve. A saved model that is
 * only missing from the live list (but still in the static registry) is treated
 * as a transient gap and preserved — we only permanently reroute when the saved
 * id is genuinely gone from BOTH sources, and then only with a surfaced notice.
 */
export function resolveChatGptEngineModel(savedModel, liveIds, registryIds, fallback) {
    const saved = savedModel?.trim();
    if (saved && liveIds.includes(saved)) {
        return { kind: "available", modelId: saved };
    }
    if (saved && registryIds.includes(saved)) {
        return { kind: "transient-gap", modelId: saved };
    }
    const resolved = resolveChatGptModelSelection(saved, liveIds, fallback);
    if (!resolved)
        return { kind: "unavailable" };
    return { kind: "rerouted", modelId: resolved, savedModel: saved ?? "" };
}
export function normalizeClaudeCodeReasoningEffort(effort) {
    return effort === "minimal" ? "low" : effort;
}
export function toOpenAiCodexModelId(modelId) {
    const trimmed = modelId.trim();
    return trimmed.startsWith(`${OPENAI_CODEX_PROVIDER}/`)
        ? trimmed
        : `${OPENAI_CODEX_PROVIDER}/${trimmed}`;
}
export function fromOpenAiCodexModelId(modelId) {
    const prefix = `${OPENAI_CODEX_PROVIDER}/`;
    return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : null;
}
/**
 * Build the single preference write that changes the runtime engine and its
 * conversation model routing. ChatGPT is intentionally asymmetric:
 * orchestrator resolves through the existing OpenAI OAuth provider, while
 * general is intercepted by the Codex runtime through `agentRuntimeEngine`.
 * Both overrides stay routable so preparation succeeds before the general
 * agent hands off to Codex.
 */
export function buildEngineRoutingPatch(preferences, engine, modelId) {
    const nextOverrides = { ...preferences.modelOverrides };
    const stellaOverrides = { ...preferences.stellaConversationModelOverrides };
    const nextPropagated = preferences.assistantPropagatedAgents.filter((key) => !CONVERSATION_AGENT_KEYS.some((agentKey) => agentKey === key));
    for (const key of CONVERSATION_AGENT_KEYS) {
        const shouldCapture = preferences.agentRuntimeEngine === "default" ||
            !Object.prototype.hasOwnProperty.call(stellaOverrides, key);
        if (shouldCapture) {
            if (nextOverrides[key] &&
                fromOpenAiCodexModelId(nextOverrides[key]) === null) {
                stellaOverrides[key] = nextOverrides[key];
            }
            else
                delete stellaOverrides[key];
        }
    }
    if (engine === "codex_cli") {
        const selectedModel = modelId?.trim() || preferences.codexModel;
        const routeModel = toOpenAiCodexModelId(selectedModel);
        nextOverrides.orchestrator = routeModel;
        nextOverrides.general = routeModel;
        return {
            agentRuntimeEngine: engine,
            codexModel: selectedModel,
            modelOverrides: nextOverrides,
            stellaConversationModelOverrides: stellaOverrides,
            assistantPropagatedAgents: nextPropagated,
        };
    }
    for (const key of CONVERSATION_AGENT_KEYS) {
        if (stellaOverrides[key])
            nextOverrides[key] = stellaOverrides[key];
        else
            delete nextOverrides[key];
    }
    return {
        agentRuntimeEngine: engine,
        ...(engine === "claude_code_local" && modelId?.trim()
            ? { claudeCodeModel: modelId.trim() }
            : {}),
        modelOverrides: nextOverrides,
        stellaConversationModelOverrides: stellaOverrides,
        assistantPropagatedAgents: nextPropagated,
    };
}
const isStellaModelId = (modelId) => modelId === "" || modelId.startsWith("stella/");
/**
 * Full preference patch for picking a catalog model (extracted from the
 * sidebar picker so the composer's pinned mini picker applies selections
 * identically). Picking any model outside the engine panels routes back
 * through Stella's own runtime, so a committed ChatGPT/Claude Code engine is
 * reverted in the same write (selection implies engine).
 *
 * `target` is either the Assistant surface
 * (`{ assistant: true, configurableAgentKeys }`) — which dual-writes
 * orchestrator + general and broadcasts non-Stella picks to every other
 * configurable agent — or a single Settings tab (`{ agentKey }`).
 */
export function buildModelSelectionPatch(preferences, value, target) {
    const engineRevertPatch = preferences.agentRuntimeEngine !== "default"
        ? {
            ...buildEngineRoutingPatch(preferences, "default"),
            ...buildEngineTransitionReasoningPatch(preferences, "default"),
        }
        : null;
    const basePreferences = engineRevertPatch
        ? { ...preferences, ...engineRevertPatch }
        : preferences;
    const previousOverrides = { ...basePreferences.modelOverrides };
    const previousPropagated = [
        ...(basePreferences.assistantPropagatedAgents ?? []),
    ];
    const nextOverrides = { ...previousOverrides };
    let nextPropagated = previousPropagated;
    if (target.assistant) {
        // Rebuild propagation from scratch on every Assistant pick: first
        // unwind whatever the last propagation wrote (so switching from
        // Anthropic -> Stella cleans every previously-broadcasted agent),
        // then re-apply against the new pick. User-intentional per-agent
        // overrides are left alone because they were never in
        // `previousPropagated` to begin with.
        for (const propagatedKey of previousPropagated) {
            delete nextOverrides[propagatedKey];
        }
        for (const key of CONVERSATION_AGENT_KEYS) {
            if (value === "") {
                delete nextOverrides[key];
            }
            else {
                nextOverrides[key] = value;
            }
        }
        if (value !== "" && !isStellaModelId(value)) {
            // Broadcast to every other configurable agent that doesn't have
            // an explicit user-intentional override.
            const propagateTargets = target.configurableAgentKeys.filter((key) => !CONVERSATION_AGENT_KEYS.some((agentKey) => agentKey === key));
            const written = [];
            for (const key of propagateTargets) {
                const hadManualOverride = previousOverrides[key] !== undefined &&
                    !previousPropagated.includes(key);
                if (hadManualOverride)
                    continue;
                nextOverrides[key] = value;
                written.push(key);
            }
            nextPropagated = written;
        }
        else {
            nextPropagated = [];
        }
    }
    else {
        // Single-agent path (Settings tabs other than Assistant). The user
        // is explicitly setting this agent, so remove it from the
        // propagated set — it's owned by them now.
        if (value === "") {
            delete nextOverrides[target.agentKey];
        }
        else {
            nextOverrides[target.agentKey] = value;
        }
        nextPropagated = previousPropagated.filter((key) => key !== target.agentKey);
    }
    // After the (possible) engine revert the effective engine is always
    // "default", so the Stella conversation mirror syncs unconditionally.
    const nextStellaConversationModelOverrides = {
        ...(basePreferences.stellaConversationModelOverrides ?? {}),
    };
    for (const key of CONVERSATION_AGENT_KEYS) {
        if (nextOverrides[key]) {
            nextStellaConversationModelOverrides[key] = nextOverrides[key];
        }
        else {
            delete nextStellaConversationModelOverrides[key];
        }
    }
    return {
        ...(engineRevertPatch ?? {}),
        modelOverrides: nextOverrides,
        assistantPropagatedAgents: nextPropagated,
        stellaConversationModelOverrides: nextStellaConversationModelOverrides,
    };
}
export function buildEngineReasoningPatch(preferences, engine, effort, agentKeys) {
    const nextReasoning = { ...preferences.reasoningEfforts };
    const stellaReasoning = {
        ...preferences.stellaConversationReasoningEfforts,
    };
    if (engine === "default") {
        for (const key of agentKeys) {
            if (effort === "default")
                delete nextReasoning[key];
            else
                nextReasoning[key] = effort;
        }
        for (const key of agentKeys) {
            if (nextReasoning[key])
                stellaReasoning[key] = nextReasoning[key];
            else
                delete stellaReasoning[key];
        }
        return {
            reasoningEfforts: nextReasoning,
            stellaConversationReasoningEfforts: stellaReasoning,
        };
    }
    if (engine === "codex_cli") {
        delete nextReasoning.general;
        if (effort === "default")
            delete nextReasoning.orchestrator;
        else
            nextReasoning.orchestrator = effort;
        return {
            reasoningEfforts: nextReasoning,
            codexReasoningEffort: effort,
        };
    }
    for (const key of agentKeys)
        delete nextReasoning[key];
    return {
        reasoningEfforts: nextReasoning,
        claudeCodeReasoningEffort: normalizeClaudeCodeReasoningEffort(effort),
    };
}
export function buildEngineTransitionReasoningPatch(preferences, engine) {
    const next = { ...preferences.reasoningEfforts };
    const stellaReasoning = {
        ...preferences.stellaConversationReasoningEfforts,
    };
    for (const key of CONVERSATION_AGENT_KEYS) {
        const shouldCapture = preferences.agentRuntimeEngine === "default" ||
            !Object.prototype.hasOwnProperty.call(stellaReasoning, key);
        if (shouldCapture) {
            const effort = next[key];
            if (effort && effort !== "default")
                stellaReasoning[key] = effort;
            else
                delete stellaReasoning[key];
        }
    }
    if (engine === "default") {
        for (const key of CONVERSATION_AGENT_KEYS) {
            const effort = stellaReasoning[key];
            if (effort && effort !== "default")
                next[key] = effort;
            else
                delete next[key];
        }
    }
    else if (engine === "codex_cli") {
        delete next.general;
        if (preferences.codexReasoningEffort === "default")
            delete next.orchestrator;
        else
            next.orchestrator = preferences.codexReasoningEffort;
    }
    else {
        delete next.orchestrator;
        delete next.general;
    }
    return {
        reasoningEfforts: next,
        stellaConversationReasoningEfforts: stellaReasoning,
    };
}
