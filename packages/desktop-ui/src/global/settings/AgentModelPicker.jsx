import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, KeyRound, Lightbulb, LogOut, RefreshCw, Search } from "@/ui/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, } from "@/ui/dropdown-menu";
import { ProviderModelPanel } from "@/global/settings/ProviderModelPanel";
import { EngineScopedModelList, } from "@/global/settings/EngineScopedModelList";
import { ProviderOnlyPicker, } from "@/global/settings/ProviderOnlyPicker";
import { VoiceCatalogPicker } from "@/global/settings/VoiceCatalogPicker";
import { coerceRealtimeVoiceProvider } from "@stella/contracts/local-preferences";
import { useModelCatalog } from "@/global/settings/hooks/use-model-catalog";
import { useCodexModelCatalog } from "@/global/settings/hooks/use-codex-model-catalog";
import { useClaudeCodeModelCatalog } from "@/global/settings/hooks/use-claude-code-model-catalog";
import { BrandIcon } from "@/ui/brand-icon";
import { useEdgeFadeRef } from "@/shared/hooks/use-edge-fade";
import { compareProviderRailOrder, getLlmProviderEntry, LLM_PROVIDERS, } from "@/global/settings/lib/llm-providers";
import { getStellaResolvedModelName } from "@/global/settings/lib/model-catalog";
import { buildModelDefaultsMap, buildResolvedModelDefaultsMap, getConfigurableAgents, getDefaultModelOptionLabel, getModelDisplayLabel, getLocalModelDefaults, normalizeModelOverrides, } from "@/global/settings/lib/model-defaults";
import { getPlanLabel, isRestrictedModelOverrideAudience, } from "@/global/billing/audience";
import { findApiKey, findOauthCredential, useLlmCredentials, } from "@/global/settings/hooks/use-llm-credentials";
import { showToast } from "@/ui/toast";
import { buildEngineReasoningPatch, buildEngineRoutingPatch, buildEngineTransitionReasoningPatch, codexModelSupportsFast, DEFAULT_CHATGPT_MODEL, DEFAULT_CLAUDE_CODE_MODEL, fromOpenAiCodexModelId, intersectChatGptModels, listChatGptCatalogModels, OPENAI_CODEX_PROVIDER, resolveChatGptEngineModel, } from "@/global/settings/lib/engine-model-routing";
import "./AgentModelPicker.css";
const REASONING_EFFORT_OPTIONS = [
    { id: "minimal", label: "Minimal" },
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "xhigh", label: "Extra" },
];
const ASSISTANT_TARGET = "__assistant__";
const IMAGE_TARGET = "__image__";
const VOICE_TARGET = "__voice__";
const ENGINE_PENDING_TARGET = "__engine__";
const NATIVE_CODEX_RUNTIME_PENDING_TARGET = "__native_codex_runtime__";
const NATIVE_CLAUDE_CODE_RUNTIME_PENDING_TARGET = "__native_claude_code_runtime__";
/** Map a saved model override to the brand it belongs to in the icon rail. */
function brandOfModelValue(value) {
    if (!value || value.startsWith("stella/"))
        return "stella";
    if (value.startsWith("codex-cli/") || value.startsWith("openai-codex/")) {
        return "openai";
    }
    if (value.startsWith("claude-code/"))
        return "anthropic";
    const slash = value.indexOf("/");
    return slash > 0 ? value.slice(0, slash) : "stella";
}
/**
 * The Assistant tab in the sidebar picker writes to both the orchestrator
 * and general agent keys, since users overwhelmingly want them to move
 * together. Splitting them is available in Settings -> Models -> Advanced.
 *
 * Picking a non-Stella model on the Assistant tab ALSO auto-propagates
 * the same model to every other configurable agent.
 * Propagated writes are tracked in `assistantPropagatedAgents` so
 * switching Assistant back to Stella cleans up only those writes and
 * never touches user-intentional per-agent picks.
 */
const ASSISTANT_AGENT_KEYS = ["orchestrator", "general"];
const isStellaModelId = (modelId) => modelId === "" || modelId.startsWith("stella/");
const DEFAULT_IMAGE_GENERATION = {
    provider: "stella",
};
const DEFAULT_REALTIME_VOICE = {
    provider: "stella",
};
export const IMAGE_PROVIDER_OPTIONS = [
    {
        key: "stella",
        label: "Stella",
    },
    {
        key: "openai",
        label: "OpenAI",
        description: "Use your own OpenAI API key.",
    },
    {
        key: "openrouter",
        label: "OpenRouter",
        description: "Use your own OpenRouter API key.",
    },
    {
        key: "fal",
        label: "fal",
        description: "Use your own fal API key.",
    },
];
const VOICE_PROVIDER_OPTIONS = [
    {
        key: "stella",
        label: "Stella",
    },
    {
        key: "openai",
        label: "OpenAI",
        description: "Use your own OpenAI API key.",
    },
    {
        key: "xai",
        label: "xAI",
        description: "Use your own xAI API key.",
    },
    {
        key: "inworld",
        label: "Inworld",
        description: "Use your own Inworld API key.",
    },
];
/**
 * Last-known local model preferences, used to seed `useState` so re-opening
 * the picker doesn't flash a loading state while the IPC roundtrip lands.
 * Mutated whenever the picker successfully loads or saves preferences.
 */
let cachedLocalPreferences = null;
/** Intent-hover warm: start the preferences IPC before the popover opens. */
export function warmAgentModelPickerCache() {
    if (cachedLocalPreferences)
        return;
    void window.electronAPI?.system
        ?.getLocalModelPreferences?.()
        .then((next) => {
        if (next)
            cachedLocalPreferences = next;
    })
        .catch(() => undefined);
}
/** Friendly names for Claude Code CLI model aliases. */
const CLAUDE_CODE_ALIAS_LABELS = {
    default: "Default",
    best: "Best",
    fable: "Fable",
    opus: "Opus",
    sonnet: "Sonnet",
    haiku: "Haiku",
    opusplan: "Opus Plan",
    "sonnet[1m]": "Sonnet · 1M",
    "opus[1m]": "Opus · 1M",
};
function getModelPickerDisplayLabel(modelId, modelNamesById) {
    if (modelId.startsWith("claude-code/")) {
        const engineModel = modelId.slice("claude-code/".length);
        return `Claude Code · ${CLAUDE_CODE_ALIAS_LABELS[engineModel] ?? engineModel}`;
    }
    if (modelId.startsWith("codex-cli/")) {
        return `ChatGPT · ${modelId.slice("codex-cli/".length)}`;
    }
    if (modelId.startsWith("local/")) {
        const localId = modelId.slice("local/".length);
        const slash = localId.indexOf("/");
        if (slash > 0) {
            const maybeBaseUrl = decodeURIComponent(localId.slice(0, slash));
            const customModel = localId.slice(slash + 1).trim();
            if (/^https?:\/\//i.test(maybeBaseUrl) && customModel) {
                return `Local ${customModel}`;
            }
        }
        return `Local ${localId}`;
    }
    return getModelDisplayLabel(modelId, modelNamesById);
}
/**
 * Inline, no-popover model picker keyed off the agent toggle at the top.
 */
export function AgentModelPicker({ active = true, onSelected, className, surface = "sidebar", }) {
    const { allModels, defaults: stellaDefaultModels, groups, refresh, refreshing, audience, error: catalogError, } = useModelCatalog();
    const [preferences, setPreferencesRaw] = useState(() => cachedLocalPreferences);
    const [pendingAgent, setPendingAgent] = useState(null);
    const [error, setError] = useState(null);
    const credentials = useLlmCredentials();
    const cancelOAuth = credentials.cancelOAuth;
    const validateOAuth = credentials.validateOAuth;
    const codexCatalog = useCodexModelCatalog(active);
    const [chatGptConnection, setChatGptConnection] = useState("checking");
    // Soft status shown when a genuinely-gone saved ChatGPT model was rerouted
    // to an available one, so the switch is never silent.
    const [chatGptRoutedNotice, setChatGptRoutedNotice] = useState(null);
    // Scroll-edge fade for the brand rail: `data-at-start` / `data-at-end`
    // drive the tapered mask so the cut-off icon signals more to scroll.
    const brandRailRef = useEdgeFadeRef();
    // Icon-rail navigation state. `null` means "derive from preferences":
    // the committed engine (ChatGPT/Claude Code) or the active override's
    // provider decides which brand panel shows when the picker opens.
    const [activeBrandRaw, setActiveBrandRaw] = useState(null);
    const [openaiSourceRaw, setOpenaiSourceRaw] = useState(null);
    const [anthropicSourceRaw, setAnthropicSourceRaw] = useState(null);
    // Mirror state writes into the module-level cache so re-mounting the
    // picker (Radix unmounts popover content on close) shows the last
    // selection immediately instead of flashing "Loading…".
    const setPreferences = useCallback((updater) => {
        setPreferencesRaw((current) => {
            const next = typeof updater === "function" ? updater(current) : updater;
            if (next)
                cachedLocalPreferences = next;
            return next;
        });
    }, []);
    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const next = await window.electronAPI?.system?.getLocalModelPreferences?.();
                if (!cancelled && next) {
                    cachedLocalPreferences = next;
                    setPreferences(next);
                    setError(null);
                }
            }
            catch (caught) {
                if (!cancelled) {
                    setError(caught instanceof Error
                        ? caught.message
                        : "Failed to load model settings.");
                }
            }
        };
        void load();
        const onExternalChange = () => {
            void load();
        };
        window.addEventListener("stella:local-model-preferences-changed", onExternalChange);
        return () => {
            cancelled = true;
            window.removeEventListener("stella:local-model-preferences-changed", onExternalChange);
        };
    }, [setPreferences]);
    const modelDefaults = useMemo(() => {
        if (!preferences)
            return undefined;
        return getLocalModelDefaults(preferences.defaultModels, stellaDefaultModels);
    }, [preferences, stellaDefaultModels]);
    // Labels come from the FULL merged catalog so BYOK / local override ids
    // (openrouter/…, anthropic/…, local/…) render their display names too.
    const modelNamesById = useMemo(() => {
        const next = new Map();
        for (const model of allModels) {
            const label = model.provider === "stella"
                ? getStellaResolvedModelName(model)
                : model.name;
            next.set(model.id, label);
            if (model.upstreamModel)
                next.set(model.upstreamModel, label);
        }
        return next;
    }, [allModels]);
    const chatGptCatalogModels = useMemo(() => codexCatalog.models
        ? intersectChatGptModels(allModels, codexCatalog.models)
        : [], [allModels, codexCatalog.models]);
    const chatGptModels = useMemo(() => chatGptCatalogModels.map((model) => ({
        id: model.modelId,
        label: model.name || model.modelId,
        description: model.modelId,
    })), [chatGptCatalogModels]);
    // Every openai-codex id known to the static registry (independent of the
    // live model/list) so we can tell a genuinely-removed model from a
    // transient live-list gap.
    const chatGptRegistryIds = useMemo(() => listChatGptCatalogModels(allModels).map((model) => model.modelId), [allModels]);
    const savedChatGptOverride = preferences
        ? fromOpenAiCodexModelId(preferences.modelOverrides.orchestrator ??
            preferences.modelOverrides.general ??
            "")
        : null;
    const selectedChatGptModel = savedChatGptOverride ?? preferences?.codexModel ?? DEFAULT_CHATGPT_MODEL;
    const selectedChatGptLiveModel = codexCatalog.models?.find((model) => model.id === selectedChatGptModel) ??
        null;
    const selectedChatGptSupportsFast = codexModelSupportsFast(selectedChatGptLiveModel);
    const chatGptCatalogSettled = !codexCatalog.loading && codexCatalog.models !== null;
    const selectedChatGptModelUnavailable = chatGptCatalogSettled &&
        Boolean(selectedChatGptModel) &&
        !chatGptModels.some((model) => model.id === selectedChatGptModel);
    const chatGptModelsWithCurrent = useMemo(() => {
        if (!chatGptCatalogSettled ||
            !selectedChatGptModel ||
            chatGptModels.some((model) => model.id === selectedChatGptModel)) {
            return chatGptModels;
        }
        return [
            ...chatGptModels,
            {
                id: selectedChatGptModel,
                label: selectedChatGptModel,
                description: "Unavailable — choose another model",
                unavailable: true,
            },
        ];
    }, [chatGptCatalogSettled, chatGptModels, selectedChatGptModel]);
    // Even without a ChatGPT connection the static registry knows which
    // OpenAI models the ChatGPT engine can route — show those instead of an
    // empty wall. Picking one starts the OAuth flow.
    const chatGptRegistryOptions = useMemo(() => listChatGptCatalogModels(allModels).map((model) => ({
        id: model.modelId,
        label: model.name || model.modelId,
        description: model.modelId,
    })), [allModels]);
    const chatGptDisplayModels = chatGptModels.length > 0
        ? chatGptModelsWithCurrent
        : chatGptRegistryOptions;
    const selectedClaudeCodeModel = preferences?.claudeCodeModel || DEFAULT_CLAUDE_CODE_MODEL;
    const committedEngine = preferences?.agentRuntimeEngine ?? "default";
    const [oauthPendingProvider, setOauthPendingProvider] = useState(null);
    const oauthAttemptRef = useRef(null);
    const migrationAttemptedRef = useRef(null);
    useEffect(() => () => {
        const attempt = oauthAttemptRef.current;
        if (attempt) {
            attempt.cancelled = true;
            void cancelOAuth(attempt.provider);
        }
    }, [cancelOAuth]);
    const cancelPendingOAuth = useCallback(async () => {
        const attempt = oauthAttemptRef.current;
        if (!attempt)
            return;
        attempt.cancelled = true;
        setOauthPendingProvider(null);
        await cancelOAuth(attempt.provider);
    }, [cancelOAuth]);
    // (The ChatGPT connection check is triggered below, once the active
    // brand/source panel is derived.)
    useEffect(() => {
        if (!preferences ||
            pendingAgent !== null ||
            preferences.agentRuntimeEngine !== "codex_cli" ||
            chatGptConnection !== "connected" ||
            !chatGptModels.some((model) => model.id === selectedChatGptModel)) {
            return;
        }
        const route = `${OPENAI_CODEX_PROVIDER}/${selectedChatGptModel}`;
        if (preferences.modelOverrides.orchestrator === route &&
            preferences.modelOverrides.general === route) {
            return;
        }
        const migrationKey = `${selectedChatGptModel}:${preferences.modelOverrides.orchestrator ?? ""}:${preferences.modelOverrides.general ?? ""}`;
        if (migrationAttemptedRef.current === migrationKey)
            return;
        migrationAttemptedRef.current = migrationKey;
        setPendingAgent(ENGINE_PENDING_TARGET);
        const patch = {
            ...buildEngineRoutingPatch(preferences, "codex_cli", selectedChatGptModel),
            ...buildEngineTransitionReasoningPatch(preferences, "codex_cli"),
        };
        void (async () => {
            try {
                const saved = await window.electronAPI?.system?.setLocalModelPreferences?.(patch);
                if (saved)
                    setPreferences(saved);
                window.dispatchEvent(new CustomEvent("stella:local-model-preferences-changed"));
            }
            catch (caught) {
                setError(caught instanceof Error
                    ? caught.message
                    : "ChatGPT routing migration failed.");
            }
            finally {
                setPendingAgent(null);
            }
        })();
    }, [
        chatGptConnection,
        chatGptModels,
        pendingAgent,
        preferences,
        selectedChatGptModel,
        setPreferences,
    ]);
    const defaultModelMap = useMemo(() => buildModelDefaultsMap(modelDefaults), [modelDefaults]);
    const resolvedDefaultModelMap = useMemo(() => buildResolvedModelDefaultsMap(modelDefaults), [modelDefaults]);
    const overrides = useMemo(() => {
        if (!preferences)
            return {};
        return normalizeModelOverrides(preferences.modelOverrides);
    }, [preferences]);
    /**
     * Sidebar: only Assistant/Image/Voice tabs render (Assistant dual-writes
     * orchestrator + general). Settings: every configurable agent gets its
     * own tab, so users can decouple orchestrator vs general (and tune the
     * rest) without leaving the same picker layout.
     */
    const configurableAgents = useMemo(() => getConfigurableAgents(modelDefaults), [modelDefaults]);
    const initialActiveAgent = surface === "settings"
        ? (configurableAgents[0]?.key ?? "orchestrator")
        : ASSISTANT_TARGET;
    const [activeAgent, setActiveAgent] = useState(initialActiveAgent);
    // Snap to a known agent key if the catalog loads after first render and
    // the initially-chosen key isn't in it (Settings surface only).
    useEffect(() => {
        if (surface !== "settings")
            return;
        if (configurableAgents.length === 0)
            return;
        if (activeAgent === IMAGE_TARGET ||
            activeAgent === VOICE_TARGET ||
            configurableAgents.some((entry) => entry.key === activeAgent)) {
            return;
        }
        setActiveAgent(configurableAgents[0].key);
    }, [activeAgent, configurableAgents, surface]);
    const activeAssistant = activeAgent === ASSISTANT_TARGET;
    const activeImage = activeAgent === IMAGE_TARGET;
    const activeVoice = activeAgent === VOICE_TARGET;
    const activeProviderSetting = activeImage || activeVoice;
    /**
     * Brand icon rail: one entry per configured or catalog provider, with
     * `openai-codex` folded into OpenAI (it's the same brand through the
     * ChatGPT subscription). Configured providers remain reachable while the
     * runtime catalog is loading so users can connect them first.
     */
    const railBrands = useMemo(() => {
        const labels = new Map();
        for (const group of groups) {
            if (group.models.length === 0)
                continue;
            const key = group.provider === OPENAI_CODEX_PROVIDER ? "openai" : group.provider;
            if (!labels.has(key))
                labels.set(key, group.providerName);
        }
        for (const entry of LLM_PROVIDERS) {
            const key = entry.key === OPENAI_CODEX_PROVIDER ? "openai" : entry.key;
            if (!labels.has(key)) {
                labels.set(key, entry.label);
            }
        }
        if (!labels.has("stella"))
            labels.set("stella", getLlmProviderEntry("stella")?.label ?? "Stella");
        return Array.from(labels, ([key, label]) => ({ key, label })).sort((a, b) => compareProviderRailOrder(a.key, b.key, a.label, b.label));
    }, [groups]);
    /** Saved model override for the active tab (assistant reads orchestrator
     * with general as fallback, same as `current` below). */
    const activeModelValue = activeAssistant
        ? (overrides.orchestrator ?? overrides.general ?? "")
        : (overrides[activeAgent] ?? "");
    const derivedBrand = committedEngine === "codex_cli"
        ? "openai"
        : committedEngine === "claude_code_local"
            ? "anthropic"
            : brandOfModelValue(activeModelValue);
    const activeBrand = activeBrandRaw ?? derivedBrand;
    // Subscription source is the default; the API-key source is derived only
    // from an actual API-provider override so re-opening the picker lands on
    // whatever the user last committed.
    const openaiSource = openaiSourceRaw ??
        (committedEngine !== "codex_cli" && activeModelValue.startsWith("openai/")
            ? "api"
            : "app");
    const anthropicSource = anthropicSourceRaw ??
        (committedEngine !== "claude_code_local" &&
            activeModelValue.startsWith("anthropic/")
            ? "api"
            : "app");
    const showChatGptPanel = !activeProviderSetting &&
        activeBrand === "openai" &&
        openaiSource === "app";
    const showClaudeCodePanel = !activeProviderSetting &&
        activeBrand === "anthropic" &&
        anthropicSource === "app";
    const claudeCodeCatalog = useClaudeCodeModelCatalog(active && (showClaudeCodePanel || committedEngine === "claude_code_local"));
    const claudeCodeModels = useMemo(() => claudeCodeCatalog.models?.map((model) => ({
        id: model.id,
        label: model.displayName || model.id,
        description: model.description,
    })) ?? null, [claudeCodeCatalog.models]);
    const claudeCodeModelsLoading = claudeCodeCatalog.loading;
    const visiblePickerError = error ??
        claudeCodeCatalog.error ??
        catalogError ??
        (showChatGptPanel && codexCatalog.error
            ? `ChatGPT models could not be verified: ${codexCatalog.error}`
            : null);
    const visiblePickerErrorTitle = error
        ? "Couldn't update model settings"
        : "Couldn't refresh models";
    const lastToastedErrorRef = useRef(null);
    useEffect(() => {
        if (!visiblePickerError) {
            lastToastedErrorRef.current = null;
            return;
        }
        if (!active || lastToastedErrorRef.current === visiblePickerError)
            return;
        lastToastedErrorRef.current = visiblePickerError;
        showToast({
            title: visiblePickerErrorTitle,
            description: visiblePickerError,
            variant: "error",
        });
    }, [active, visiblePickerError, visiblePickerErrorTitle]);
    // Check the ChatGPT OAuth session whenever its panel is on screen (so the
    // connect notice is accurate before any commit), and always while the
    // committed engine is ChatGPT (the auto-migration effect depends on it).
    useEffect(() => {
        if (!active || (!showChatGptPanel && committedEngine !== "codex_cli")) {
            return;
        }
        let cancelled = false;
        void validateOAuth(OPENAI_CODEX_PROVIDER).then((result) => {
            if (!cancelled) {
                setChatGptConnection(result.connected
                    ? "connected"
                    : result.needsReauth
                        ? "needs-reauth"
                        : "disconnected");
            }
        });
        return () => {
            cancelled = true;
        };
    }, [active, committedEngine, showChatGptPanel, validateOAuth]);
    /**
     * The sidebar Assistant tab writes to both orchestrator and general (and
     * reads from orchestrator with general as a fallback). Settings always
     * writes to a single agent key — even orchestrator and general are
     * separate tabs there.
     */
    const assistantWriteKeys = ASSISTANT_AGENT_KEYS;
    const canonicalAgentKey = activeAssistant
        ? ASSISTANT_AGENT_KEYS[0]
        : activeAgent;
    const handleSelect = useCallback(async (value) => {
        if (!preferences || pendingAgent)
            return;
        // Picking any model outside the engine panels routes back through
        // Stella's own runtime, so a committed ChatGPT/Claude Code engine is
        // reverted in the same write (selection implies engine).
        const engineRevertPatch = preferences.agentRuntimeEngine !== "default"
            ? {
                ...buildEngineRoutingPatch(preferences, "default"),
                ...buildEngineTransitionReasoningPatch(preferences, "default"),
            }
            : null;
        if (engineRevertPatch)
            migrationAttemptedRef.current = null;
        const basePreferences = engineRevertPatch
            ? { ...preferences, ...engineRevertPatch }
            : preferences;
        const previousOverrides = { ...basePreferences.modelOverrides };
        const previousPropagated = [
            ...(basePreferences.assistantPropagatedAgents ?? []),
        ];
        const nextOverrides = { ...previousOverrides };
        let nextPropagated = previousPropagated;
        if (activeAssistant) {
            // Rebuild propagation from scratch on every Assistant pick: first
            // unwind whatever the last propagation wrote (so switching from
            // Anthropic -> Stella cleans every previously-broadcasted agent),
            // then re-apply against the new pick. User-intentional per-agent
            // overrides are left alone because they were never in
            // `previousPropagated` to begin with.
            for (const propagatedKey of previousPropagated) {
                delete nextOverrides[propagatedKey];
            }
            for (const key of assistantWriteKeys) {
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
                const propagateTargets = configurableAgents
                    .map((agent) => agent.key)
                    .filter((key) => !assistantWriteKeys.includes(key));
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
                delete nextOverrides[activeAgent];
            }
            else {
                nextOverrides[activeAgent] = value;
            }
            nextPropagated = previousPropagated.filter((key) => key !== activeAgent);
        }
        setPendingAgent(activeAgent);
        // After the (possible) engine revert the effective engine is always
        // "default", so the Stella conversation mirror syncs unconditionally.
        const nextStellaConversationModelOverrides = {
            ...(basePreferences.stellaConversationModelOverrides ?? {}),
        };
        for (const key of ASSISTANT_AGENT_KEYS) {
            if (nextOverrides[key]) {
                nextStellaConversationModelOverrides[key] = nextOverrides[key];
            }
            else {
                delete nextStellaConversationModelOverrides[key];
            }
        }
        setPreferences({
            ...basePreferences,
            modelOverrides: nextOverrides,
            assistantPropagatedAgents: nextPropagated,
            stellaConversationModelOverrides: nextStellaConversationModelOverrides,
        });
        try {
            const saved = await window.electronAPI?.system?.setLocalModelPreferences?.({
                ...(engineRevertPatch ?? {}),
                modelOverrides: nextOverrides,
                assistantPropagatedAgents: nextPropagated,
                stellaConversationModelOverrides: nextStellaConversationModelOverrides,
            });
            if (saved)
                setPreferences(saved);
            // Let other model listeners pick up the new override without remounting.
            window.dispatchEvent(new CustomEvent("stella:local-model-preferences-changed"));
            setError(null);
            // Restricted-tier picks used to fire a toast here. The picker
            // now disables Stella-provider models that aren't available on
            // the user's plan up front, so reaching this path means the
            // selection is allowed and no toast is needed.
            onSelected?.();
        }
        catch (caught) {
            // Full restore: the optimistic write may have included an engine
            // revert, so partial rollbacks would leave mixed state.
            setPreferences(preferences);
            setError(caught instanceof Error
                ? caught.message
                : "Failed to update model setting.");
        }
        finally {
            setPendingAgent(null);
        }
    }, [
        activeAgent,
        activeAssistant,
        assistantWriteKeys,
        configurableAgents,
        onSelected,
        pendingAgent,
        preferences,
        setPreferences,
    ]);
    const commitEngineSelection = useCallback(async (engine, modelId, options) => {
        if (!preferences || pendingAgent)
            return false;
        migrationAttemptedRef.current = null;
        const previous = preferences;
        setPendingAgent(ENGINE_PENDING_TARGET);
        setError(null);
        setChatGptRoutedNotice(null);
        // ChatGPT auto-matches to an available OpenAI model; the model id passed
        // into the routing patch is resolved below so selection never dead-ends
        // on a "choose a model" gate. Auth is the only real interruption.
        let effectiveModelId = modelId;
        let oauthAttempt = null;
        try {
            if (engine === "codex_cli") {
                if (codexCatalog.loading) {
                    throw new Error("Wait for ChatGPT models to finish verifying.");
                }
                const selectedModel = modelId?.trim() || preferences.codexModel;
                setChatGptConnection("checking");
                let validation = await credentials.validateOAuth(OPENAI_CODEX_PROVIDER);
                if (!validation.connected) {
                    oauthAttempt = {
                        provider: OPENAI_CODEX_PROVIDER,
                        cancelled: false,
                    };
                    oauthAttemptRef.current = oauthAttempt;
                    setOauthPendingProvider(OPENAI_CODEX_PROVIDER);
                    await credentials.loginOAuth(OPENAI_CODEX_PROVIDER, {
                        announceConnection: false,
                    });
                    if (oauthAttemptRef.current === oauthAttempt) {
                        oauthAttemptRef.current = null;
                        setOauthPendingProvider(null);
                    }
                    validation = await credentials.validateOAuth(OPENAI_CODEX_PROVIDER);
                }
                if (!validation.connected) {
                    setChatGptConnection(validation.needsReauth ? "needs-reauth" : "disconnected");
                    throw new Error("ChatGPT needs to be connected before selection.");
                }
                setChatGptConnection("connected");
                const resolution = resolveChatGptEngineModel(selectedModel, chatGptModels.map((model) => model.id), chatGptRegistryIds, DEFAULT_CHATGPT_MODEL);
                if (resolution.kind === "unavailable") {
                    throw new Error(codexCatalog.error ??
                        "No ChatGPT models are currently available.");
                }
                // transient-gap keeps the saved (registry-routable) model rather than
                // silently switching on a flaky live-list miss; rerouted surfaces a
                // notice so a genuine switch is never silent.
                effectiveModelId = resolution.modelId;
                if (resolution.kind === "rerouted") {
                    setChatGptRoutedNotice(`Routed to ${resolution.modelId} (saved model unavailable).`);
                }
            }
            const patch = {
                ...buildEngineRoutingPatch(preferences, engine, effectiveModelId),
                ...buildEngineTransitionReasoningPatch(preferences, engine),
                ...(engine === "codex_cli" &&
                    effectiveModelId &&
                    codexCatalog.models?.some((model) => model.id === effectiveModelId && !codexModelSupportsFast(model))
                    ? { codexServiceTier: "standard" }
                    : {}),
                // Record provenance only for an explicit ChatGPT model pick so
                // Stella Light honors it; engine switches / auto-matches leave the
                // marker untouched.
                ...(engine === "codex_cli" && options?.explicit
                    ? { codexModelExplicit: true }
                    : {}),
            };
            const optimistic = { ...preferences, ...patch };
            setPreferences(optimistic);
            const saved = await window.electronAPI?.system?.setLocalModelPreferences?.(patch);
            if (saved)
                setPreferences(saved);
            window.dispatchEvent(new CustomEvent("stella:local-model-preferences-changed"));
            return true;
        }
        catch (caught) {
            const oauthWasCancelled = oauthAttempt?.cancelled === true;
            if (oauthAttemptRef.current === oauthAttempt) {
                oauthAttemptRef.current = null;
                setOauthPendingProvider(null);
            }
            setPreferences(previous);
            if (!oauthWasCancelled) {
                setError(caught instanceof Error && caught.message.trim()
                    ? caught.message
                    : engine === "codex_cli"
                        ? "Failed to connect ChatGPT."
                        : "Failed to update the engine.");
            }
            return false;
        }
        finally {
            if (oauthAttemptRef.current === oauthAttempt) {
                oauthAttemptRef.current = null;
                setOauthPendingProvider(null);
            }
            setPendingAgent(null);
        }
    }, [
        chatGptModels,
        chatGptRegistryIds,
        codexCatalog.error,
        codexCatalog.loading,
        codexCatalog.models,
        credentials,
        pendingAgent,
        preferences,
        setPreferences,
    ]);
    const handleEngineModelSelect = useCallback(async (engine, modelId) => {
        if (!preferences)
            return;
        // Selecting a row from an engine panel is an explicit user pick and
        // commits that engine (selection implies engine).
        const saved = await commitEngineSelection(engine, modelId, {
            explicit: true,
        });
        if (saved)
            onSelected?.();
    }, [commitEngineSelection, onSelected, preferences]);
    const handleImageProviderSelect = useCallback(async (providerKey) => {
        if (!preferences || pendingAgent)
            return;
        const previousImageGeneration = preferences.imageGeneration ?? DEFAULT_IMAGE_GENERATION;
        const nextImageGeneration = providerKey === "openai"
            ? { provider: "openai" }
            : providerKey === "openrouter"
                ? { provider: "openrouter" }
                : providerKey === "fal"
                    ? { provider: "fal" }
                    : { provider: "stella" };
        setPendingAgent(IMAGE_TARGET);
        setPreferences({
            ...preferences,
            imageGeneration: nextImageGeneration,
        });
        try {
            const saved = await window.electronAPI?.system?.setLocalModelPreferences?.({
                imageGeneration: nextImageGeneration,
            });
            if (saved)
                setPreferences(saved);
            setError(null);
            onSelected?.();
        }
        catch (caught) {
            setPreferences((current) => current
                ? { ...current, imageGeneration: previousImageGeneration }
                : current);
            setError(caught instanceof Error
                ? caught.message
                : "Failed to update image setting.");
        }
        finally {
            setPendingAgent(null);
        }
    }, [onSelected, pendingAgent, preferences, setPreferences]);
    /**
     * Optimistic patch of just the `realtimeVoice` slice. Voice catalog
     * changes (voice id, speed, sub-family) are tiny and idempotent, so we
     * deliberately skip the pendingAgent gate that would flicker the whole
     * picker on every click. The caller passes the next slice and an
     * error label; we apply locally, write through IPC, and revert on
     * failure.
     */
    const patchRealtimeVoice = useCallback(async (next, errorLabel) => {
        if (!preferences)
            return;
        const previous = preferences.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
        setPreferences({ ...preferences, realtimeVoice: next });
        try {
            await window.electronAPI?.system?.setLocalModelPreferences?.({
                realtimeVoice: next,
            });
            setError(null);
        }
        catch (caught) {
            setPreferences((current) => current ? { ...current, realtimeVoice: previous } : current);
            setError(caught instanceof Error ? caught.message : errorLabel);
        }
    }, [preferences, setPreferences]);
    const handleVoiceSelect = useCallback((underlyingProvider, voiceId) => {
        const previous = preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
        void patchRealtimeVoice({
            ...previous,
            voices: { ...(previous.voices ?? {}), [underlyingProvider]: voiceId },
        }, "Failed to update voice setting.");
    }, [patchRealtimeVoice, preferences]);
    const handleInworldSpeedSelect = useCallback((speed) => {
        const previous = preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
        const clamped = Math.min(2.0, Math.max(0.5, speed));
        if (typeof previous.inworldSpeed === "number" &&
            Math.abs(previous.inworldSpeed - clamped) < 0.001) {
            return;
        }
        void patchRealtimeVoice({ ...previous, inworldSpeed: clamped }, "Failed to update Inworld speed.");
    }, [patchRealtimeVoice, preferences]);
    const handleStellaSubProviderSelect = useCallback((subProvider) => {
        const previous = preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
        if (previous.stellaSubProvider === subProvider)
            return;
        void patchRealtimeVoice({ ...previous, stellaSubProvider: subProvider }, "Failed to update voice family.");
    }, [patchRealtimeVoice, preferences]);
    const handleReadAloudProviderSelect = useCallback((provider) => {
        const previous = preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
        if ((previous.readAloudProvider ?? "inworld") === provider)
            return;
        void patchRealtimeVoice({ ...previous, readAloudProvider: provider }, "Failed to update read-aloud provider.");
    }, [patchRealtimeVoice, preferences]);
    const handleVoiceProviderSelect = useCallback(async (providerKey) => {
        if (!preferences || pendingAgent)
            return;
        const previous = preferences.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
        // Preserve catalog choices (voice id, sub-family, speed) when
        // switching provider mode so a Stella → BYOK round-trip doesn't
        // wipe the user's selections. `model` is intentionally dropped:
        // the kernel re-selects the right default for the new provider.
        const next = {
            provider: coerceRealtimeVoiceProvider(providerKey),
            ...(previous.voices ? { voices: previous.voices } : {}),
            ...(previous.stellaSubProvider
                ? { stellaSubProvider: previous.stellaSubProvider }
                : {}),
            ...(typeof previous.inworldSpeed === "number"
                ? { inworldSpeed: previous.inworldSpeed }
                : {}),
        };
        setPendingAgent(VOICE_TARGET);
        setPreferences({ ...preferences, realtimeVoice: next });
        try {
            const saved = await window.electronAPI?.system?.setLocalModelPreferences?.({
                realtimeVoice: next,
            });
            if (saved)
                setPreferences(saved);
            setError(null);
            onSelected?.();
        }
        catch (caught) {
            setPreferences((current) => current ? { ...current, realtimeVoice: previous } : current);
            setError(caught instanceof Error
                ? caught.message
                : "Failed to update voice setting.");
        }
        finally {
            setPendingAgent(null);
        }
    }, [onSelected, pendingAgent, preferences, setPreferences]);
    const handleReasoningEffortSelect = useCallback(async (effort) => {
        if (!preferences || pendingAgent)
            return;
        migrationAttemptedRef.current = null;
        const selectedEngine = preferences.agentRuntimeEngine;
        const writeKeys = activeAssistant ? assistantWriteKeys : [activeAgent];
        const previousReasoningEfforts = {
            ...(preferences.reasoningEfforts ?? {}),
        };
        const patch = buildEngineReasoningPatch(preferences, selectedEngine, effort, writeKeys);
        setPendingAgent(activeAgent);
        setPreferences({
            ...preferences,
            ...patch,
        });
        try {
            const saved = await window.electronAPI?.system?.setLocalModelPreferences?.(patch);
            if (saved)
                setPreferences(saved);
            setError(null);
            onSelected?.();
        }
        catch (caught) {
            setPreferences((current) => current
                ? {
                    ...current,
                    reasoningEfforts: previousReasoningEfforts,
                    codexReasoningEffort: preferences.codexReasoningEffort,
                    claudeCodeReasoningEffort: preferences.claudeCodeReasoningEffort,
                }
                : current);
            setError(caught instanceof Error
                ? caught.message
                : "Failed to update reasoning effort.");
        }
        finally {
            setPendingAgent(null);
        }
    }, [
        activeAgent,
        activeAssistant,
        assistantWriteKeys,
        onSelected,
        pendingAgent,
        preferences,
        setPreferences,
    ]);
    const handleCodexServiceTierSelect = useCallback(async (serviceTier) => {
        if (!preferences ||
            pendingAgent ||
            preferences.agentRuntimeEngine !== "codex_cli" ||
            (serviceTier === "fast" && !selectedChatGptSupportsFast)) {
            return;
        }
        const previousServiceTier = preferences.codexServiceTier;
        const patch = {
            codexServiceTier: serviceTier,
        };
        setPendingAgent(ENGINE_PENDING_TARGET);
        setPreferences({ ...preferences, ...patch });
        try {
            const saved = await window.electronAPI?.system?.setLocalModelPreferences?.(patch);
            if (saved)
                setPreferences(saved);
            window.dispatchEvent(new CustomEvent("stella:local-model-preferences-changed"));
            setError(null);
            onSelected?.();
        }
        catch (caught) {
            setPreferences((current) => current
                ? { ...current, codexServiceTier: previousServiceTier }
                : current);
            setError(caught instanceof Error
                ? caught.message
                : "Failed to update ChatGPT speed.");
        }
        finally {
            setPendingAgent(null);
        }
    }, [
        onSelected,
        pendingAgent,
        preferences,
        selectedChatGptSupportsFast,
        setPreferences,
    ]);
    const handleNativeRuntimeChange = useCallback(async (preference, enabled) => {
        if (!preferences || pendingAgent)
            return;
        const previous = preferences[preference] === true;
        const runtimeLabel = preference === "useNativeCodexRuntime" ? "Codex" : "Claude Code";
        setPendingAgent(preference === "useNativeCodexRuntime"
            ? NATIVE_CODEX_RUNTIME_PENDING_TARGET
            : NATIVE_CLAUDE_CODE_RUNTIME_PENDING_TARGET);
        setError(null);
        const patch = { [preference]: enabled };
        setPreferences({ ...preferences, ...patch });
        try {
            const saved = await window.electronAPI?.system?.setLocalModelPreferences?.(patch);
            if (saved)
                setPreferences(saved);
            window.dispatchEvent(new CustomEvent("stella:local-model-preferences-changed"));
        }
        catch (caught) {
            setPreferences((current) => current ? { ...current, [preference]: previous } : current);
            setError(caught instanceof Error
                ? caught.message
                : `Failed to update direct ${runtimeLabel} setting.`);
        }
        finally {
            setPendingAgent(null);
        }
    }, [pendingAgent, preferences, setPreferences]);
    const ready = preferences !== null &&
        (activeProviderSetting || modelDefaults !== undefined);
    const imagePreferences = preferences?.imageGeneration ?? DEFAULT_IMAGE_GENERATION;
    const voicePreferences = preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
    /**
     * Selected value for the active tab. For the assistant tab we prefer the
     * orchestrator key, falling back to general so a "split" Advanced setup
     * still shows something coherent. For image/voice we surface the provider
     * key directly (no model id) because those tabs are provider-only.
     */
    const current = activeAssistant
        ? (overrides.orchestrator ?? overrides.general ?? "")
        : activeImage
            ? imagePreferences.provider
            : activeVoice
                ? voicePreferences.provider
                : (overrides[activeAgent] ?? "");
    // The default row is a routing choice, not another copy of its currently
    // resolved model. Keep its label stable while the explicit model rows below
    // show the actual choices.
    const defaultLabel = activeProviderSetting
        ? "Stella"
        : !ready
            ? "Default"
            : activeAssistant
                ? "Stella Default"
                : getDefaultModelOptionLabel(canonicalAgentKey, defaultModelMap, resolvedDefaultModelMap, modelNamesById);
    const defaultModelId = activeAssistant
        ? (resolvedDefaultModelMap[canonicalAgentKey] ??
            defaultModelMap[canonicalAgentKey] ??
            "")
        : "";
    const currentLabel = activeProviderSetting
        ? (IMAGE_PROVIDER_OPTIONS.find((entry) => entry.key === current)?.label ??
            VOICE_PROVIDER_OPTIONS.find((entry) => entry.key === current)?.label ??
            "Stella")
        : ready
            ? current
                ? getModelPickerDisplayLabel(current, modelNamesById)
                : activeAssistant
                    ? getModelPickerDisplayLabel(defaultModelId, modelNamesById)
                    : defaultLabel
            : "Loading…";
    const claudeCodeModelsWithCurrent = useMemo(() => {
        const models = claudeCodeModels ?? [];
        if (claudeCodeModels === null ||
            !selectedClaudeCodeModel ||
            models.some((model) => model.id === selectedClaudeCodeModel)) {
            return models;
        }
        return [
            ...models,
            {
                id: selectedClaudeCodeModel,
                label: selectedClaudeCodeModel,
                description: "Unavailable",
                unavailable: true,
            },
        ];
    }, [claudeCodeModels, selectedClaudeCodeModel]);
    const savedReasoningEffort = committedEngine === "codex_cli"
        ? (preferences?.codexReasoningEffort ?? "default")
        : committedEngine === "claude_code_local"
            ? (preferences?.claudeCodeReasoningEffort ?? "default")
            : activeAssistant
                ? (preferences?.reasoningEfforts?.orchestrator ??
                    preferences?.reasoningEfforts?.general ??
                    "default")
                : (preferences?.reasoningEfforts?.[activeAgent] ?? "default");
    const reportedDefaultReasoningEffort = committedEngine === "codex_cli"
        ? selectedChatGptLiveModel?.defaultReasoningEffort
        : null;
    const effectiveDefaultReasoningEffort = REASONING_EFFORT_OPTIONS.some((option) => option.id === reportedDefaultReasoningEffort)
        ? reportedDefaultReasoningEffort
        : "medium";
    const currentReasoningEffort = savedReasoningEffort === "default"
        ? effectiveDefaultReasoningEffort
        : savedReasoningEffort;
    const reasoningEffortOptions = REASONING_EFFORT_OPTIONS.filter((option) => committedEngine !== "claude_code_local" || option.id !== "minimal");
    const reasoningDisabled = pendingAgent !== null ||
        (committedEngine === "codex_cli" &&
            (chatGptConnection !== "connected" || codexCatalog.loading));
    /**
     * Active brand header: names the scoped provider (the icon rail alone
     * left the list contextless), carries the subscription/API-key source
     * as a compact dropdown for OpenAI/Anthropic, shows the BYOK connection
     * state inline, and owns the catalog refresh button.
     */
    const activeBrandInfo = railBrands.find((brand) => brand.key === activeBrand) ?? { key: activeBrand, label: activeBrand };
    const brandHasSources = activeBrand === "openai" || activeBrand === "anthropic";
    const brandSourceOptions = activeBrand === "openai"
        ? [
            { value: "app", label: "Sign in with ChatGPT" },
            { value: "api", label: "Use API key" },
        ]
        : [
            { value: "app", label: "Use Claude Code" },
            { value: "api", label: "Use API key" },
        ];
    const [brandAuthOpenRequest, setBrandAuthOpenRequest] = useState(0);
    const handleBrandSource = (next) => {
        if (activeBrand === "openai") {
            setOpenaiSourceRaw(next);
        }
        else {
            setAnthropicSourceRaw(next);
        }
        if (next === "api") {
            setBrandAuthOpenRequest((request) => request + 1);
            return;
        }
        if (activeBrand === "openai") {
            void commitEngineSelection("codex_cli", selectedChatGptModel);
        }
        else {
            void commitEngineSelection("claude_code_local", selectedClaudeCodeModel);
        }
    };
    const brandCredentialKey = activeBrand === "openai" ? "openai-codex" : activeBrand;
    const brandConnected = Boolean(findApiKey(credentials.apiKeys, brandCredentialKey)) ||
        Boolean(findOauthCredential(credentials.oauthCredentials, brandCredentialKey)) ||
        (activeBrand === "openai" &&
            (Boolean(findApiKey(credentials.apiKeys, "openai")) ||
                Boolean(findOauthCredential(credentials.oauthCredentials, "openai"))));
    const brandIsByok = activeBrand !== "stella" && !brandHasSources;
    const brandSubtitle = activeBrand === "stella"
        ? null
        : brandHasSources
            ? null
            : brandIsByok
                ? brandConnected
                    ? "API key · Connected"
                    : "API key"
                : null;
    /** The scoped panel below needs its own connect/sign-out affordance —
     * rendering them here in the header keeps them off the list's head row
     * (which otherwise left a one-sided gap when hidden). */
    const [brandHeaderActions, setBrandHeaderActions] = useState(null);
    // The panel's "Add key" / "Sign in" action is a labeled pill, which
    // looked mismatched beside the icon buttons — swap its label for a key
    // glyph (the form it expands is labeled "API key", so the icon stays
    // meaningful).
    // Sign-in / Add-key is a primary action, not a utility glyph — render
    // it as a labeled button that anchors the header, while search/refresh
    // stay ghost icons.
    const normalizedBrandHeaderActions = brandHeaderActions ? (<>
        {brandHeaderActions.connect ? (<button type="button" className="agent-model-picker-connect-btn" onClick={brandHeaderActions.connect.onClick} disabled={brandHeaderActions.connect.disabled}>
            <KeyRound size={13} strokeWidth={1.75} aria-hidden/>
            {brandHeaderActions.connect.label}
          </button>) : null}
        {brandHeaderActions.signOut ? (<button type="button" className="model-picker-group-signout" data-armed={brandHeaderActions.signOut.armed || undefined} disabled={brandHeaderActions.signOut.disabled} aria-label={brandHeaderActions.signOut.label} title={brandHeaderActions.signOut.title} onClick={brandHeaderActions.signOut.onClick}>
            {brandHeaderActions.signOut.armed ? (<Check size={13} strokeWidth={2} aria-hidden/>) : (<LogOut size={13} strokeWidth={1.75} aria-hidden/>)}
          </button>) : null}
      </>) : null;
    const [brandSearchOpen, setBrandSearchOpen] = useState(false);
    useEffect(() => {
        setBrandSearchOpen(false);
    }, [activeBrand]);
    const brandHeader = !activeProviderSetting ? (<div className="agent-model-picker-brand-header">
          <span className="agent-model-picker-brand-heading">
            <BrandIcon brand={activeBrandInfo.key} size={15}/>
            <span className="agent-model-picker-brand-heading-text">
              <span className="agent-model-picker-brand-title">
                {activeBrandInfo.label}
              </span>
              {brandSubtitle ? (<span className={[
                "agent-model-picker-brand-subtitle",
                brandIsByok
                    ? brandConnected
                        ? "is-connected"
                        : "is-disconnected"
                    : "",
            ].filter(Boolean).join(" ")}>
                  {brandSubtitle}
                </span>) : null}
            </span>
          </span>
          <span className="agent-model-picker-brand-actions">
            {!showChatGptPanel && !showClaudeCodePanel ? (<button type="button" className="agent-model-picker-brand-action" data-active={brandSearchOpen || undefined} aria-label="Search models" title="Search models" aria-pressed={brandSearchOpen} disabled={pendingAgent !== null} onClick={() => setBrandSearchOpen((open) => !open)}>
                <Search size={14} strokeWidth={1.75} aria-hidden/>
              </button>) : null}
            <button type="button" className="agent-model-picker-brand-action" onClick={() => {
            if (showClaudeCodePanel) {
                void claudeCodeCatalog.refresh();
            }
            else if (showChatGptPanel) {
                migrationAttemptedRef.current = null;
                void Promise.all([codexCatalog.refresh(), refresh()]);
            }
            else {
                void refresh();
            }
        }} disabled={pendingAgent !== null ||
            refreshing ||
            claudeCodeModelsLoading ||
            codexCatalog.loading} title={showClaudeCodePanel
            ? "Refresh Claude Code models"
            : "Refresh model catalog"} aria-label={showClaudeCodePanel
            ? "Refresh Claude Code models"
            : "Refresh model catalog"}>
              <RefreshCw size={13} strokeWidth={1.75} data-spinning={refreshing || claudeCodeModelsLoading || undefined}/>
            </button>
            {brandHasSources ? (<DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className="agent-model-picker-connect-btn" aria-label={`Sign in to ${activeBrandInfo.label}`} disabled={pendingAgent !== null}>
                    Sign in
                    <ChevronDown size={12} strokeWidth={1.75} aria-hidden/>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="end" sideOffset={4}>
                  {brandSourceOptions.map((option) => (<DropdownMenuItem key={option.value} onSelect={() => handleBrandSource(option.value)}>
                        {option.label}
                      </DropdownMenuItem>))}
                </DropdownMenuContent>
              </DropdownMenu>) : null}
            {normalizedBrandHeaderActions}
          </span>
        </div>) : null;
    /**
     * On free / anonymous / Go plans the backend silently coerces any
     * non-default Stella-provider pick back to the recommended model.
     * Surface that up front by disabling those rows in the picker (the
     * default row + every BYOK provider stay enabled).
     */
    const restrictedStellaPicks = isRestrictedModelOverrideAudience(audience);
    const restrictedPlanLabel = audience ? getPlanLabel(audience) : null;
    const tabButton = (key, label, title, isActive) => (<button key={key} type="button" role="tab" aria-selected={isActive} className="agent-model-picker-toggle-btn" data-active={isActive || undefined} onClick={() => {
            if (oauthPendingProvider) {
                void cancelPendingOAuth();
            }
            setActiveAgent(key);
            // Each tab re-derives its brand/source from saved preferences.
            setActiveBrandRaw(null);
            setOpenaiSourceRaw(null);
            setAnthropicSourceRaw(null);
        }} disabled={pendingAgent !== null && !oauthPendingProvider} title={title}>
      {label}
    </button>);
    return (<div className={["agent-model-picker", className].filter(Boolean).join(" ")}>
      <div className="agent-model-picker-header">
          <div className="agent-model-picker-toggle" role="tablist" aria-label="Surface" data-surface={surface}>
            {surface === "settings"
            ? [
                ...configurableAgents.map((agent) => tabButton(agent.key, agent.label, agent.desc, agent.key === activeAgent)),
                tabButton(IMAGE_TARGET, "Image", "Image generation provider", activeImage),
                tabButton(VOICE_TARGET, "Voice", "Realtime voice provider", activeVoice),
            ]
            : [
                tabButton(ASSISTANT_TARGET, "Assistant", "Stella's main assistant", activeAssistant),
                tabButton(IMAGE_TARGET, "Image", "Image generation provider", activeImage),
                tabButton(VOICE_TARGET, "Voice", "Realtime voice provider", activeVoice),
            ]}
          </div>
        </div>

      <div className="agent-model-picker-body">
        {pendingAgent === ENGINE_PENDING_TARGET && oauthPendingProvider ? (<p className="agent-model-picker-connection" role="status">
            Waiting for ChatGPT…{" "}
            <button type="button" onClick={() => void cancelPendingOAuth()}>
              Cancel
            </button>
          </p>) : null}

        {activeImage ? (<ProviderOnlyPicker providers={IMAGE_PROVIDER_OPTIONS} value={current || "stella"} onSelect={(key) => void handleImageProviderSelect(key)} disabled={!preferences || pendingAgent !== null} ariaLabel="Image provider"/>) : activeVoice ? (<>
            <ProviderOnlyPicker providers={VOICE_PROVIDER_OPTIONS} value={current || "stella"} onSelect={(key) => void handleVoiceProviderSelect(key)} disabled={!preferences || pendingAgent !== null} ariaLabel="Voice provider"/>
            <VoiceCatalogPicker voiceProvider={voicePreferences.provider} stellaSubProvider={voicePreferences.stellaSubProvider} selectedVoices={voicePreferences.voices} inworldSpeed={voicePreferences.inworldSpeed} readAloudProvider={voicePreferences.readAloudProvider} onSelectVoice={(underlyingProvider, voiceId) => void handleVoiceSelect(underlyingProvider, voiceId)} onSelectStellaSubProvider={(sub) => void handleStellaSubProviderSelect(sub)} onSelectInworldSpeed={(speed) => void handleInworldSpeedSelect(speed)} onSelectReadAloudProvider={(provider) => void handleReadAloudProviderSelect(provider)} disabled={!preferences || pendingAgent !== null}/>
          </>) : (<>
            <div ref={brandRailRef} className="agent-model-picker-brands" role="tablist" aria-label="Provider">
              {railBrands.map((brand) => (<button key={brand.key} type="button" role="tab" aria-selected={brand.key === activeBrand} aria-label={brand.label} title={brand.label} className="agent-model-picker-brand" data-active={brand.key === activeBrand || undefined} onClick={() => {
                  if (oauthPendingProvider) {
                      void cancelPendingOAuth();
                  }
                  setActiveBrandRaw(brand.key);
              }} disabled={pendingAgent !== null && !oauthPendingProvider}>
                  <BrandIcon brand={brand.key} size={17}/>
                </button>))}
            </div>
            {brandHeader}
            {showChatGptPanel ? (<>
                {codexCatalog.loading ? (<p className="agent-model-picker-connection" role="status">
                    Verifying ChatGPT models…
                  </p>) : chatGptDisplayModels.length === 0 ? (<p className="agent-model-picker-connection" role="status">
                    No models are currently available to both ChatGPT and Codex.
                  </p>) : chatGptConnection === "connected" &&
                    selectedChatGptModelUnavailable ? (<p className="agent-model-picker-connection" role="status">
                    The saved model is unavailable. Choose another model.
                  </p>) : chatGptRoutedNotice ? (<p className="agent-model-picker-connection" role="status">
                    {chatGptRoutedNotice}
                  </p>) : null}
                <EngineScopedModelList engineLabel="ChatGPT" hideHead models={chatGptDisplayModels} value={committedEngine === "codex_cli" ? selectedChatGptModel : ""} onSelect={(modelId) => void handleEngineModelSelect("codex_cli", modelId)} emptyMessage={null} disabled={!preferences ||
                    pendingAgent !== null ||
                    codexCatalog.loading}/>
              </>) : showClaudeCodePanel ? (<EngineScopedModelList engineLabel="Claude Code" hideHead models={claudeCodeModelsWithCurrent} value={committedEngine === "claude_code_local"
                    ? selectedClaudeCodeModel
                    : ""} onSelect={(modelId) => void handleEngineModelSelect("claude_code_local", modelId)} loading={claudeCodeModelsLoading} disabled={!preferences || pendingAgent !== null}/>) : (<ProviderModelPanel value={current} defaultLabel={defaultLabel} currentLabel={currentLabel} groups={groups} disabled={!ready || pendingAgent !== null} restrictStellaPicks={restrictedStellaPicks} restrictedPlanLabel={restrictedPlanLabel} ariaLabel="Assistant model picker" onSelect={handleSelect} visibleProviders={[activeBrand]} hideSelectedTitle hideProviderLabel hideSearch={!brandSearchOpen} hideGroupHead={brandHasSources} headerActionsTarget={setBrandHeaderActions} authOpenRequest={brandAuthOpenRequest} onRequestSearchClose={() => setBrandSearchOpen(false)}/>)}
          </>)}

      </div>

      {activeProviderSetting ? null : (<div className="agent-model-picker-footer">
          <div className="agent-model-picker-footer-main">
            <div className="agent-model-picker-controls">
              <div className="agent-model-picker-reasoning">
                <Lightbulb size={14} strokeWidth={1.75} className="agent-model-picker-reasoning-icon" aria-hidden/>
                <div className="agent-model-picker-reasoning-options" role="radiogroup" aria-label="Reasoning effort">
                  {reasoningEffortOptions.map((option) => (<button key={option.id} type="button" role="radio" aria-checked={currentReasoningEffort === option.id} data-active={currentReasoningEffort === option.id || undefined} disabled={reasoningDisabled} onClick={() => void handleReasoningEffortSelect(option.id)}>
                      {option.label}
                    </button>))}
                </div>
              </div>
            </div>
          </div>
        </div>)}
    </div>);
}
