import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Lightbulb } from "@/ui/icons";
import { ProviderModelPanel } from "@/global/settings/ProviderModelPanel";
import { EngineScopedModelList } from "@/global/settings/EngineScopedModelList";
import { ProviderOnlyPicker, type ProviderOption, } from "@/global/settings/ProviderOnlyPicker";
import { VoiceCatalogPicker } from "@/global/settings/VoiceCatalogPicker";
import { coerceRealtimeVoiceProvider, type AssistantWorkingMode, type ReadAloudVoiceProvider, type RealtimeVoicePreferences, type RealtimeVoiceUnderlyingProvider, } from "@stella/contracts/local-preferences";
import { isDeepSeekV4FlashModel } from "@stella/contracts/stella-api";
import { useModelCatalog } from "@/global/settings/hooks/use-model-catalog";
import { useCodexModelCatalog } from "@/global/settings/hooks/use-codex-model-catalog";
import { useClaudeCodeModelCatalog } from "@/global/settings/hooks/use-claude-code-model-catalog";
import { getStellaResolvedModelName } from "@/global/settings/lib/model-catalog";
import { buildModelDefaultsMap, buildResolvedModelDefaultsMap, getConfigurableAgents, getDefaultModelOptionLabel, getModelPickerDisplayLabel, getLocalModelDefaults, normalizeModelOverrides, } from "@/global/settings/lib/model-defaults";
import { REASONING_EFFORT_OPTIONS, listReasoningEffortOptions, type ReasoningEffortOptionId, } from "@/global/settings/lib/reasoning-effort-options";
import { recordRecentModel } from "@/global/settings/lib/recent-models";
import { getPlanLabel, isRestrictedModelOverrideAudience, } from "@/global/billing/audience";
import { useLlmCredentials } from "@/global/settings/hooks/use-llm-credentials";
import { showToast } from "@/ui/toast";
import { buildEngineReasoningPatch, buildEngineRoutingPatch, buildEngineTransitionReasoningPatch, buildModelSelectionPatch, codexModelSupportsFast, DEFAULT_CHATGPT_MODEL, DEFAULT_CLAUDE_CODE_MODEL, fromOpenAiCodexModelId, intersectChatGptModels, listChatGptCatalogModels, OPENAI_CODEX_PROVIDER, resolveChatGptEngineModel, type LiveCodexModel, type ModelPickerEngine, } from "@/global/settings/lib/engine-model-routing";
import "./AgentModelPicker.css";

type ImageGenerationProvider = "stella" | "openai" | "openrouter" | "fal";
type ImageGenerationPreferences = {
    provider: ImageGenerationProvider;
    model?: string;
};
type ReasoningEffort = "default" | ReasoningEffortOptionId;
type CodexServiceTier = "standard" | "fast";
type LocalModelPreferences = {
    defaultModels: Record<string, string>;
    modelOverrides: Record<string, string>;
    assistantPropagatedAgents: string[];
    reasoningEfforts: Record<string, ReasoningEffort>;
    stellaConversationModelOverrides: Record<string, string>;
    stellaConversationReasoningEfforts: Record<string, ReasoningEffort>;
    agentRuntimeEngine: ModelPickerEngine;
    codexModel: string;
    codexModelExplicit: boolean;
    codexReasoningEffort: ReasoningEffort;
    codexServiceTier: CodexServiceTier;
    claudeCodeModel: string;
    claudeCodeReasoningEffort: ReasoningEffort;
    useNativeCodexRuntime?: boolean;
    useNativeClaudeCodeRuntime?: boolean;
    maxAgentConcurrency: number;
    imageGeneration: ImageGenerationPreferences;
    realtimeVoice: RealtimeVoicePreferences;
    assistantWorkingMode: AssistantWorkingMode;
};

interface AgentModelPickerProps {
    active?: boolean;
    onSelected?: () => void;
    className?: string;
    surface?: "sidebar" | "settings";
}
const ASSISTANT_TARGET = "__assistant__";
const IMAGE_TARGET = "__image__";
const VOICE_TARGET = "__voice__";
const ENGINE_PENDING_TARGET = "__engine__";
const NATIVE_CODEX_RUNTIME_PENDING_TARGET = "__native_codex_runtime__";
const NATIVE_CLAUDE_CODE_RUNTIME_PENDING_TARGET = "__native_claude_code_runtime__";
/** Section keys for the two engine entries in the single provider list. */
const CHATGPT_SECTION_KEY = "chatgpt-engine";
const CLAUDE_CODE_SECTION_KEY = "claude-code-engine";
/** `openai-codex` is surfaced as the ChatGPT engine section, never as a
 * second catalog "OpenAI" group. */
const HIDDEN_CATALOG_PROVIDERS = ["openai-codex"];
/** Pinned front of the provider list; everything else keeps its catalog
 * (rail-priority) order after these. */
const SECTION_ORDER = [
    "stella",
    CLAUDE_CODE_SECTION_KEY,
    CHATGPT_SECTION_KEY,
    "xai",
    "meta",
    "openrouter",
];
/** Map a saved model override to its section in the provider list. */
function sectionOfModelValue(value: string): string {
    if (!value || value.startsWith("stella/"))
        return "stella";
    if (value.startsWith("codex-cli/") || value.startsWith("openai-codex/")) {
        return CHATGPT_SECTION_KEY;
    }
    if (value.startsWith("claude-code/"))
        return CLAUDE_CODE_SECTION_KEY;
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
const ASSISTANT_AGENT_KEYS: readonly string[] = ["orchestrator", "general"];
const DEFAULT_IMAGE_GENERATION: ImageGenerationPreferences = {
    provider: "stella",
};
const DEFAULT_REALTIME_VOICE: RealtimeVoicePreferences = {
    provider: "stella",
};
export const IMAGE_PROVIDER_OPTIONS: readonly ProviderOption[] = [
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
const VOICE_PROVIDER_OPTIONS: readonly ProviderOption[] = [
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
let cachedLocalPreferences: LocalModelPreferences | null = null;
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
/**
 * Inline, no-popover model picker keyed off the agent toggle at the top.
 */
export function AgentModelPicker({ active = true, onSelected, className, surface = "sidebar", }: AgentModelPickerProps) {
    const { allModels, defaults: stellaDefaultModels, groups, refresh, refreshing, audience, error: catalogError, } = useModelCatalog();
    const [preferences, setPreferencesRaw] = useState<LocalModelPreferences | null>(() => cachedLocalPreferences);
    const [pendingAgent, setPendingAgent] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const credentials = useLlmCredentials();
    const cancelOAuth = credentials.cancelOAuth;
    const validateOAuth = credentials.validateOAuth;
    const codexCatalog = useCodexModelCatalog(active);
    const [chatGptConnection, setChatGptConnection] = useState<"checking" | "connected" | "disconnected" | "needs-reauth">("checking");
    // Soft status shown when a genuinely-gone saved ChatGPT model was rerouted
    // to an available one, so the switch is never silent.
    const [chatGptRoutedNotice, setChatGptRoutedNotice] = useState<string | null>(null);
    // Engine sections report their expansion so the (IPC-backed) engine
    // catalogs only start loading once the user actually opens them.
    const [chatGptSectionOpen, setChatGptSectionOpen] = useState(false);
    const [claudeCodeSectionOpen, setClaudeCodeSectionOpen] = useState(false);
    // Mirror state writes into the module-level cache so re-mounting the
    // picker (Radix unmounts popover content on close) shows the last
    // selection immediately instead of flashing "Loading…".
    const setPreferences = useCallback((updater: LocalModelPreferences | null | ((previous: LocalModelPreferences | null) => LocalModelPreferences | null)) => {
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
        const next = new Map<string, string>();
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
    const [oauthPendingProvider, setOauthPendingProvider] = useState<string | null>(null);
    const oauthAttemptRef = useRef<{ provider: string; cancelled: boolean } | null>(null);
    const migrationAttemptedRef = useRef<string | null>(null);
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
    // (The ChatGPT connection check is triggered below, once the ChatGPT
    // section's expansion state is known.)
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
    /** Saved model override for the active tab (assistant reads orchestrator
     * with general as fallback, same as `current` below). */
    const activeModelValue = activeAssistant
        ? (overrides.orchestrator ?? overrides.general ?? "")
        : (overrides[activeAgent] ?? "");
    /** Section that holds the current selection — it opens by default. */
    const activeSectionKey = committedEngine === "codex_cli"
        ? CHATGPT_SECTION_KEY
        : committedEngine === "claude_code_local"
            ? CLAUDE_CODE_SECTION_KEY
            : sectionOfModelValue(activeModelValue);
    const claudeCodeCatalog = useClaudeCodeModelCatalog(active && (claudeCodeSectionOpen || committedEngine === "claude_code_local"));
    const claudeCodeModels = useMemo(() => claudeCodeCatalog.models?.map((model) => ({
        id: model.id,
        label: model.displayName || model.id,
        description: model.description,
    })) ?? null, [claudeCodeCatalog.models]);
    const claudeCodeModelsLoading = claudeCodeCatalog.loading;
    const visiblePickerError = error ??
        claudeCodeCatalog.error ??
        catalogError ??
        ((chatGptSectionOpen || committedEngine === "codex_cli") &&
            codexCatalog.error
            ? `ChatGPT models could not be verified: ${codexCatalog.error}`
            : null);
    const visiblePickerErrorTitle = error
        ? "Couldn't update model settings"
        : "Couldn't refresh models";
    const lastToastedErrorRef = useRef<string | null>(null);
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
        if (!active ||
            (!chatGptSectionOpen && committedEngine !== "codex_cli")) {
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
    }, [active, chatGptSectionOpen, committedEngine, validateOAuth]);
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
    const handleSelect = useCallback(async (value: string) => {
        if (!preferences || pendingAgent)
            return;
        // The patch may revert a committed ChatGPT/Claude Code engine
        // (selection implies engine), so the migration guard resets with it.
        if (preferences.agentRuntimeEngine !== "default")
            migrationAttemptedRef.current = null;
        const patch = buildModelSelectionPatch(preferences, value, activeAssistant
            ? {
                assistant: true,
                configurableAgentKeys: configurableAgents.map((agent) => agent.key),
            }
            : { agentKey: activeAgent });
        setPendingAgent(activeAgent);
        setPreferences({ ...preferences, ...patch });
        try {
            const saved = await window.electronAPI?.system?.setLocalModelPreferences?.(patch);
            if (saved)
                setPreferences(saved);
            // Let other model listeners pick up the new override without remounting.
            window.dispatchEvent(new CustomEvent("stella:local-model-preferences-changed"));
            // Real catalog picks feed the Recent list in the composer's mini
            // picker; the empty "default" pick is never recorded.
            if (value)
                recordRecentModel(value);
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
        configurableAgents,
        onSelected,
        pendingAgent,
        preferences,
        setPreferences,
    ]);
    const commitEngineSelection = useCallback(async (engine: ModelPickerEngine, modelId?: string, options?: { explicit?: boolean }): Promise<boolean> => {
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
        let oauthAttempt: { provider: string; cancelled: boolean } | null = null;
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
            const patch: Partial<LocalModelPreferences> = {
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
    const handleEngineModelSelect = useCallback(async (engine: ModelPickerEngine, modelId: string) => {
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
    const handleImageProviderSelect = useCallback(async (providerKey: string) => {
        if (!preferences || pendingAgent)
            return;
        const previousImageGeneration = preferences.imageGeneration ?? DEFAULT_IMAGE_GENERATION;
        const nextImageGeneration: ImageGenerationPreferences = providerKey === "openai"
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
    const patchRealtimeVoice = useCallback(async (next: RealtimeVoicePreferences, errorLabel: string) => {
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
    const handleVoiceSelect = useCallback((underlyingProvider: RealtimeVoiceUnderlyingProvider, voiceId: string) => {
        const previous = preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
        void patchRealtimeVoice({
            ...previous,
            voices: { ...(previous.voices ?? {}), [underlyingProvider]: voiceId },
        }, "Failed to update voice setting.");
    }, [patchRealtimeVoice, preferences]);
    const handleInworldSpeedSelect = useCallback((speed: number) => {
        const previous = preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
        const clamped = Math.min(2.0, Math.max(0.5, speed));
        if (typeof previous.inworldSpeed === "number" &&
            Math.abs(previous.inworldSpeed - clamped) < 0.001) {
            return;
        }
        void patchRealtimeVoice({ ...previous, inworldSpeed: clamped }, "Failed to update Inworld speed.");
    }, [patchRealtimeVoice, preferences]);
    const handleStellaSubProviderSelect = useCallback((subProvider: RealtimeVoiceUnderlyingProvider) => {
        const previous = preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
        if (previous.stellaSubProvider === subProvider)
            return;
        void patchRealtimeVoice({ ...previous, stellaSubProvider: subProvider }, "Failed to update voice family.");
    }, [patchRealtimeVoice, preferences]);
    const handleReadAloudProviderSelect = useCallback((provider: ReadAloudVoiceProvider) => {
        const previous = preferences?.realtimeVoice ?? DEFAULT_REALTIME_VOICE;
        if ((previous.readAloudProvider ?? "inworld") === provider)
            return;
        void patchRealtimeVoice({ ...previous, readAloudProvider: provider }, "Failed to update read-aloud provider.");
    }, [patchRealtimeVoice, preferences]);
    const handleVoiceProviderSelect = useCallback(async (providerKey: string) => {
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
    const handleReasoningEffortSelect = useCallback(async (effort: ReasoningEffort) => {
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
            // Effort changes surface in the composer's mini picker too, so
            // announce them like model changes.
            window.dispatchEvent(new CustomEvent("stella:local-model-preferences-changed"));
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
    const handleCodexServiceTierSelect = useCallback(async (serviceTier: CodexServiceTier) => {
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
    const handleNativeRuntimeChange = useCallback(async (preference: "useNativeCodexRuntime" | "useNativeClaudeCodeRuntime", enabled: boolean) => {
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
    // These persisted handlers remain part of the current implementation even
    // though their controls are temporarily absent from this surface.
    void handleCodexServiceTierSelect;
    void handleNativeRuntimeChange;
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
    const defaultModelId = resolvedDefaultModelMap[canonicalAgentKey] ??
        defaultModelMap[canonicalAgentKey] ??
        "";
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
        ? (selectedChatGptLiveModel as (LiveCodexModel & { defaultReasoningEffort?: string }) | null)?.defaultReasoningEffort
        : null;
    const selectedStellaModelId = current || defaultModelId;
    const selectedStellaCatalogModel = allModels.find((model) => model.id === selectedStellaModelId ||
        model.upstreamModel === selectedStellaModelId);
    const selectedModelDefaultsToXhigh = committedEngine === "default" &&
        (isDeepSeekV4FlashModel(selectedStellaModelId) ||
            isDeepSeekV4FlashModel(selectedStellaCatalogModel?.upstreamModel));
    const effectiveDefaultReasoningEffort = REASONING_EFFORT_OPTIONS.some((option) => option.id === reportedDefaultReasoningEffort)
        ? reportedDefaultReasoningEffort
        : selectedModelDefaultsToXhigh
            ? "xhigh"
            : "medium";
    const currentReasoningEffort = savedReasoningEffort === "default"
        ? effectiveDefaultReasoningEffort
        : savedReasoningEffort;
    const reasoningEffortOptions = listReasoningEffortOptions(committedEngine);
    const reasoningDisabled = pendingAgent !== null ||
        (committedEngine === "codex_cli" &&
            (chatGptConnection !== "connected" || codexCatalog.loading));
    /** Reasoning effort rides directly under the selected model row instead
     * of living in a detached footer. */
    const reasoningControl = (<div className="agent-model-picker-reasoning">
        <Lightbulb size={14} strokeWidth={1.75} className="agent-model-picker-reasoning-icon" aria-hidden/>
        <div className="agent-model-picker-reasoning-options" role="radiogroup" aria-label="Reasoning effort">
          {reasoningEffortOptions.map((option) => (<button key={option.id} type="button" role="radio" aria-checked={currentReasoningEffort === option.id} data-active={currentReasoningEffort === option.id || undefined} disabled={reasoningDisabled} onClick={() => void handleReasoningEffortSelect(option.id)}>
              {option.label}
            </button>))}
        </div>
      </div>);
    /**
     * ChatGPT and Claude Code are engines, not catalog providers. They render
     * as their own collapsible sections beside the OpenAI / Anthropic API
     * sections in the single provider list. `content` is a render-prop so a
     * collapsed engine never mounts its list.
     */
    const handleExtraSectionExpanded = useCallback((key: string, expanded: boolean) => {
        if (key === CHATGPT_SECTION_KEY) {
            if (!expanded && oauthPendingProvider)
                void cancelPendingOAuth();
            setChatGptSectionOpen(expanded);
        }
        else if (key === CLAUDE_CODE_SECTION_KEY) {
            setClaudeCodeSectionOpen(expanded);
        }
    }, [cancelPendingOAuth, oauthPendingProvider]);
    const handleCatalogRefresh = useCallback(() => {
        migrationAttemptedRef.current = null;
        const jobs: Promise<unknown>[] = [refresh()];
        if (chatGptSectionOpen || committedEngine === "codex_cli")
            jobs.push(codexCatalog.refresh());
        if (claudeCodeSectionOpen || committedEngine === "claude_code_local")
            jobs.push(claudeCodeCatalog.refresh());
        void Promise.all(jobs);
    }, [chatGptSectionOpen, claudeCodeCatalog, claudeCodeSectionOpen, codexCatalog, committedEngine, refresh]);
    /**
     * On free / anonymous / Go plans the backend silently coerces any
     * non-default Stella-provider pick back to the recommended model.
     * Surface that up front by disabling those rows in the picker (the
     * default row + every BYOK provider stay enabled).
     */
    const restrictedStellaPicks = isRestrictedModelOverrideAudience(audience);
    const restrictedPlanLabel = audience ? getPlanLabel(audience) : null;
    const tabButton = (key: string, label: string, title: string, isActive: boolean) => (<button key={key} type="button" role="tab" aria-selected={isActive} className="agent-model-picker-toggle-btn" data-active={isActive || undefined} onClick={() => {
            if (oauthPendingProvider) {
                void cancelPendingOAuth();
            }
            setActiveAgent(key);
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
            <ProviderModelPanel value={current} defaultLabel={defaultLabel} currentLabel={currentLabel} groups={groups} disabled={!ready || pendingAgent !== null} restrictStellaPicks={restrictedStellaPicks} restrictedPlanLabel={restrictedPlanLabel} ariaLabel="Assistant model picker" onSelect={handleSelect} hideSelectedTitle hideDefaultRow selectedRowExtra={reasoningControl} collapsibleGroups activeSectionKey={activeSectionKey} hiddenProviders={HIDDEN_CATALOG_PROVIDERS} sectionOrder={SECTION_ORDER} onExtraSectionExpanded={handleExtraSectionExpanded} onRefresh={handleCatalogRefresh} refreshing={refreshing || claudeCodeModelsLoading || codexCatalog.loading} extraSections={[
                {
                    key: CLAUDE_CODE_SECTION_KEY,
                    label: "Claude Code",
                    brandKey: "anthropic",
                    selected: committedEngine === "claude_code_local",
                    content: () => (<EngineScopedModelList engineLabel="Claude Code" hideHead selectedRowExtra={reasoningControl} models={claudeCodeModelsWithCurrent} value={committedEngine === "claude_code_local"
                            ? selectedClaudeCodeModel
                            : ""} onSelect={(modelId) => void handleEngineModelSelect("claude_code_local", modelId)} loading={claudeCodeModelsLoading} disabled={!preferences || pendingAgent !== null}/>),
                },
                {
                    key: CHATGPT_SECTION_KEY,
                    label: "ChatGPT/Codex",
                    brandKey: "openai",
                    selected: committedEngine === "codex_cli",
                    content: () => (<>
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
                        <EngineScopedModelList engineLabel="ChatGPT" hideHead selectedRowExtra={reasoningControl} models={chatGptDisplayModels} value={committedEngine === "codex_cli" ? selectedChatGptModel : ""} onSelect={(modelId) => void handleEngineModelSelect("codex_cli", modelId)} emptyMessage={null} disabled={!preferences ||
                            pendingAgent !== null ||
                            codexCatalog.loading}/>
                      </>),
                },
            ]}/>
          </>)}

      </div>

    </div>);
}
