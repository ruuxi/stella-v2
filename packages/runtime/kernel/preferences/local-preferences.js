/**
 * Local preferences — reads/writes `~/.stella/preferences.json`.
 *
 * Serves as the local source of truth for user preferences. Model routing
 * preferences live here only; Convex does not own or sync them.
 */
import fs from "fs";
import path from "path";
import { ensurePrivateDirSync, writePrivateFileSync, } from "../shared/private-fs.js";
import { coerceAssistantWorkingMode, coerceRealtimeVoiceProvider } from "@stella/contracts/local-preferences";
import { coerceAgentRuntimeEngine, DEFAULT_CODEX_MODEL, DEFAULT_CODEX_SERVICE_TIER } from "@stella/contracts/agent-engine";
import { isKnownPersonalityId } from "@stella/contracts/personality";
export { DEFAULT_CODEX_MODEL } from "@stella/contracts/agent-engine";
export const DEFAULT_CLAUDE_CODE_MODEL = "default";
export { resolveRealtimeUnderlyingProvider, resolveReadAloudProvider } from "@stella/contracts/local-preferences";
const DEFAULT_MAX_AGENT_CONCURRENCY = 24;
const MAX_AGENT_CONCURRENCY_CEILING = 48;
const DEFAULT_PREFERENCES = {
    defaultModels: {},
    modelOverrides: {},
    assistantPropagatedAgents: [],
    // Missing entries use the selected model's own default reasoning effort.
    reasoningEfforts: {},
    stellaConversationModelOverrides: {},
    stellaConversationReasoningEfforts: {},
    agentRuntimeEngine: "default",
    useNativeCodexRuntime: false,
    useNativeClaudeCodeRuntime: false,
    codexModel: DEFAULT_CODEX_MODEL,
    codexModelExplicit: false,
    codexReasoningEffort: "default",
    codexServiceTier: DEFAULT_CODEX_SERVICE_TIER,
    claudeCodeModel: DEFAULT_CLAUDE_CODE_MODEL,
    claudeCodeReasoningEffort: "default",
    maxAgentConcurrency: DEFAULT_MAX_AGENT_CONCURRENCY,
    imageGeneration: { provider: "stella" },
    realtimeVoice: { provider: "stella" },
    assistantWorkingMode: "direct",
    syncMode: "off",
    dictationShortcut: "Alt",
    voiceRtcShortcut: "CommandOrControl+Shift+D",
    preventComputerSleep: false,
    lockedComputerUseEnabled: false,
    soundNotificationsEnabled: true,
    dictationSoundEffectsEnabled: true,
    wakeWordEnabled: false,
    onboardingCompleted: false,
    wakeWordThreshold: 0.6,
    readAloudEnabled: false,
    personalityVoiceId: undefined,
};
const LEGACY_STELLA_DEFAULT_MODEL = "stella/default";
const RETIRED_MODEL_PROVIDERS = new Set([
    "google-antigravity",
    "google-gemini-cli",
    "groq",
    "mistral",
    "fal",
]);
let _cached = null;
let _cachedMtime = null;
const prefsPath = (stellaDataDir) => path.join(stellaDataDir, "preferences.json");
export const loadLocalPreferences = (stellaDataDir) => {
    const filePath = prefsPath(stellaDataDir);
    try {
        const stat = fs.statSync(filePath);
        if (_cached && _cachedMtime === stat.mtimeMs) {
            return _cached;
        }
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        const prefs = {
            ...DEFAULT_PREFERENCES,
            defaultModels: normalizeModelPreferenceMap(parsed.defaultModels),
            modelOverrides: normalizeModelPreferenceMap(parsed.modelOverrides),
            assistantPropagatedAgents: normalizeAssistantPropagatedAgents(parsed.assistantPropagatedAgents),
            reasoningEfforts: normalizeReasoningEfforts(parsed.reasoningEfforts),
            stellaConversationModelOverrides: normalizeModelPreferenceMap(parsed.stellaConversationModelOverrides),
            stellaConversationReasoningEfforts: normalizeReasoningEfforts(parsed.stellaConversationReasoningEfforts),
            agentRuntimeEngine: normalizeEngine(parsed.agentRuntimeEngine),
            // The short-lived global native-runtime opt-out is migrated per engine
            // only when that engine's replacement key is absent. Its default false
            // (and the older `subscriptionHarnessEnabled` key) never change the new
            // harness-by-default behavior. Saving the normalized object strips both
            // retired keys.
            useNativeCodexRuntime: typeof parsed.useNativeCodexRuntime === "boolean"
                ? parsed.useNativeCodexRuntime
                : parsed.useNativeAgentRuntimes === true,
            useNativeClaudeCodeRuntime: typeof parsed.useNativeClaudeCodeRuntime === "boolean"
                ? parsed.useNativeClaudeCodeRuntime
                : parsed.useNativeAgentRuntimes === true,
            codexModel: normalizeCodexModel(parsed.codexModel),
            codexModelExplicit: parsed.codexModelExplicit === true,
            codexReasoningEffort: normalizeReasoningEffort(parsed.codexReasoningEffort),
            codexServiceTier: normalizeCodexServiceTier(parsed.codexServiceTier),
            claudeCodeModel: normalizeClaudeCodeModel(parsed.claudeCodeModel),
            claudeCodeReasoningEffort: normalizeReasoningEffort(parsed.claudeCodeReasoningEffort) === "minimal"
                ? "low"
                : normalizeReasoningEffort(parsed.claudeCodeReasoningEffort),
            maxAgentConcurrency: normalizeConcurrency(parsed.maxAgentConcurrency),
            imageGeneration: normalizeImageGenerationPreferences(parsed.imageGeneration),
            realtimeVoice: normalizeRealtimeVoicePreferences(parsed.realtimeVoice),
            assistantWorkingMode: coerceAssistantWorkingMode(parsed.assistantWorkingMode),
            syncMode: parsed.syncMode === "on" ? "on" : "off",
            dictationShortcut: typeof parsed.dictationShortcut === "string"
                ? parsed.dictationShortcut
                : DEFAULT_PREFERENCES.dictationShortcut,
            voiceRtcShortcut: typeof parsed.voiceRtcShortcut === "string"
                ? parsed.voiceRtcShortcut
                : DEFAULT_PREFERENCES.voiceRtcShortcut,
            preventComputerSleep: parsed.preventComputerSleep === true,
            lockedComputerUseEnabled: parsed.lockedComputerUseEnabled === true,
            soundNotificationsEnabled: parsed.soundNotificationsEnabled !== false,
            dictationSoundEffectsEnabled: parsed.dictationSoundEffectsEnabled !== false,
            wakeWordEnabled: typeof parsed.wakeWordEnabled === "boolean"
                ? parsed.wakeWordEnabled
                : DEFAULT_PREFERENCES.wakeWordEnabled,
            onboardingCompleted: parsed.onboardingCompleted === true,
            wakeWordThreshold: typeof parsed.wakeWordThreshold === "number" &&
                Number.isFinite(parsed.wakeWordThreshold) &&
                parsed.wakeWordThreshold > 0 &&
                parsed.wakeWordThreshold <= 1
                ? parsed.wakeWordThreshold
                : DEFAULT_PREFERENCES.wakeWordThreshold,
            readAloudEnabled: parsed.readAloudEnabled === true,
            personalityVoiceId: isKnownPersonalityId(parsed.personalityVoiceId)
                ? parsed.personalityVoiceId
                : DEFAULT_PREFERENCES.personalityVoiceId,
        };
        _cached = prefs;
        _cachedMtime = stat.mtimeMs;
        return prefs;
    }
    catch {
        return { ...DEFAULT_PREFERENCES };
    }
};
export const saveLocalPreferences = (stellaDataDir, prefs) => {
    const filePath = prefsPath(stellaDataDir);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        ensurePrivateDirSync(dir);
    }
    writePrivateFileSync(filePath, JSON.stringify(prefs, null, 2));
    _cached = prefs;
    try {
        _cachedMtime = fs.statSync(filePath).mtimeMs;
    }
    catch {
        _cachedMtime = null;
    }
};
export const getModelOverride = (stellaDataDir, agentType) => {
    const prefs = loadLocalPreferences(stellaDataDir);
    return prefs.modelOverrides[agentType];
};
export const getReasoningEffort = (stellaDataDir, agentType) => {
    const prefs = loadLocalPreferences(stellaDataDir);
    return normalizeReasoningEffort(prefs.reasoningEfforts[agentType]);
};
export const getAgentRuntimeEngine = (stellaDataDir) => {
    return loadLocalPreferences(stellaDataDir).agentRuntimeEngine;
};
export const getSubscriptionHarnessEnabled = (stellaDataDir, engine) => {
    const prefs = loadLocalPreferences(stellaDataDir);
    if (engine === "codex_cli")
        return !prefs.useNativeCodexRuntime;
    if (engine === "claude_code_local") {
        return !prefs.useNativeClaudeCodeRuntime;
    }
    return false;
};
export const getMaxAgentConcurrency = (stellaDataDir) => {
    return loadLocalPreferences(stellaDataDir).maxAgentConcurrency;
};
export const getImageGenerationPreferences = (stellaDataDir) => {
    return normalizeImageGenerationPreferences(loadLocalPreferences(stellaDataDir).imageGeneration);
};
export const getRealtimeVoicePreferences = (stellaDataDir) => {
    return normalizeRealtimeVoicePreferences(loadLocalPreferences(stellaDataDir).realtimeVoice);
};
export const getAssistantWorkingMode = (stellaDataDir) => {
    return coerceAssistantWorkingMode(loadLocalPreferences(stellaDataDir).assistantWorkingMode);
};
export const getLocalModelPreferences = (stellaDataDir) => {
    const prefs = loadLocalPreferences(stellaDataDir);
    return {
        defaultModels: { ...prefs.defaultModels },
        modelOverrides: { ...prefs.modelOverrides },
        assistantPropagatedAgents: [...prefs.assistantPropagatedAgents],
        reasoningEfforts: { ...prefs.reasoningEfforts },
        stellaConversationModelOverrides: {
            ...prefs.stellaConversationModelOverrides,
        },
        stellaConversationReasoningEfforts: {
            ...prefs.stellaConversationReasoningEfforts,
        },
        agentRuntimeEngine: prefs.agentRuntimeEngine,
        useNativeCodexRuntime: prefs.useNativeCodexRuntime,
        useNativeClaudeCodeRuntime: prefs.useNativeClaudeCodeRuntime,
        codexModel: prefs.codexModel,
        codexModelExplicit: prefs.codexModelExplicit,
        codexReasoningEffort: prefs.codexReasoningEffort,
        codexServiceTier: prefs.codexServiceTier,
        claudeCodeModel: prefs.claudeCodeModel,
        claudeCodeReasoningEffort: prefs.claudeCodeReasoningEffort,
        maxAgentConcurrency: prefs.maxAgentConcurrency,
        imageGeneration: { ...prefs.imageGeneration },
        realtimeVoice: { ...prefs.realtimeVoice },
        assistantWorkingMode: prefs.assistantWorkingMode,
    };
};
export const updateLocalModelPreferences = (stellaDataDir, patch) => {
    const prefs = loadLocalPreferences(stellaDataDir);
    const next = {
        ...prefs,
        defaultModels: patch.defaultModels === undefined
            ? prefs.defaultModels
            : normalizeModelPreferenceMap(patch.defaultModels),
        modelOverrides: patch.modelOverrides === undefined
            ? prefs.modelOverrides
            : normalizeModelPreferenceMap(patch.modelOverrides),
        assistantPropagatedAgents: patch.assistantPropagatedAgents === undefined
            ? prefs.assistantPropagatedAgents
            : normalizeAssistantPropagatedAgents(patch.assistantPropagatedAgents),
        reasoningEfforts: patch.reasoningEfforts === undefined
            ? prefs.reasoningEfforts
            : normalizeReasoningEfforts(patch.reasoningEfforts),
        stellaConversationModelOverrides: patch.stellaConversationModelOverrides === undefined
            ? prefs.stellaConversationModelOverrides
            : normalizeModelPreferenceMap(patch.stellaConversationModelOverrides),
        stellaConversationReasoningEfforts: patch.stellaConversationReasoningEfforts === undefined
            ? prefs.stellaConversationReasoningEfforts
            : normalizeReasoningEfforts(patch.stellaConversationReasoningEfforts),
        agentRuntimeEngine: patch.agentRuntimeEngine === undefined
            ? prefs.agentRuntimeEngine
            : normalizeEngine(patch.agentRuntimeEngine),
        useNativeCodexRuntime: patch.useNativeCodexRuntime === undefined
            ? prefs.useNativeCodexRuntime
            : patch.useNativeCodexRuntime === true,
        useNativeClaudeCodeRuntime: patch.useNativeClaudeCodeRuntime === undefined
            ? prefs.useNativeClaudeCodeRuntime
            : patch.useNativeClaudeCodeRuntime === true,
        codexModel: patch.codexModel === undefined
            ? prefs.codexModel
            : normalizeCodexModel(patch.codexModel),
        codexModelExplicit: patch.codexModelExplicit === undefined
            ? prefs.codexModelExplicit
            : patch.codexModelExplicit === true,
        codexReasoningEffort: patch.codexReasoningEffort === undefined
            ? prefs.codexReasoningEffort
            : normalizeReasoningEffort(patch.codexReasoningEffort),
        codexServiceTier: patch.codexServiceTier === undefined
            ? prefs.codexServiceTier
            : normalizeCodexServiceTier(patch.codexServiceTier),
        claudeCodeModel: patch.claudeCodeModel === undefined
            ? prefs.claudeCodeModel
            : normalizeClaudeCodeModel(patch.claudeCodeModel),
        claudeCodeReasoningEffort: patch.claudeCodeReasoningEffort === undefined
            ? prefs.claudeCodeReasoningEffort
            : normalizeReasoningEffort(patch.claudeCodeReasoningEffort) ===
                "minimal"
                ? "low"
                : normalizeReasoningEffort(patch.claudeCodeReasoningEffort),
        maxAgentConcurrency: patch.maxAgentConcurrency === undefined
            ? prefs.maxAgentConcurrency
            : normalizeConcurrency(patch.maxAgentConcurrency),
        imageGeneration: patch.imageGeneration === undefined
            ? prefs.imageGeneration
            : normalizeImageGenerationPreferences(patch.imageGeneration),
        realtimeVoice: patch.realtimeVoice === undefined
            ? prefs.realtimeVoice
            : normalizeRealtimeVoicePreferences(patch.realtimeVoice),
        assistantWorkingMode: patch.assistantWorkingMode === undefined
            ? prefs.assistantWorkingMode
            : coerceAssistantWorkingMode(patch.assistantWorkingMode),
    };
    saveLocalPreferences(stellaDataDir, next);
    return getLocalModelPreferences(stellaDataDir);
};
/**
 * Resolve the model name for the Explore agent. Prefers an explicit override
 * (modelOverrides["explore"]), then returns undefined to let resolveLlmRoute
 * fall back to Stella's backend-owned default.
 *
 * Explore is meant to be a fast cheap pass over ~/.stella/. Users who want to
 * spend more should set modelOverrides["explore"] explicitly.
 */
export const getExploreModel = (stellaDataDir) => {
    const prefs = loadLocalPreferences(stellaDataDir);
    return prefs.modelOverrides["explore"];
};
export const getSyncMode = (stellaDataDir) => {
    return loadLocalPreferences(stellaDataDir).syncMode;
};
export const getPreventComputerSleep = (stellaDataDir) => {
    return loadLocalPreferences(stellaDataDir).preventComputerSleep;
};
export const getLockedComputerUseEnabled = (stellaDataDir) => {
    return loadLocalPreferences(stellaDataDir).lockedComputerUseEnabled;
};
export const getSoundNotificationsEnabled = (stellaDataDir) => {
    return loadLocalPreferences(stellaDataDir).soundNotificationsEnabled;
};
export const getDictationSoundEffectsEnabled = (stellaDataDir) => {
    return loadLocalPreferences(stellaDataDir).dictationSoundEffectsEnabled;
};
export const getReadAloudEnabled = (stellaDataDir) => {
    return loadLocalPreferences(stellaDataDir).readAloudEnabled;
};
export const setReadAloudEnabled = (stellaDataDir, enabled) => {
    const prefs = loadLocalPreferences(stellaDataDir);
    saveLocalPreferences(stellaDataDir, { ...prefs, readAloudEnabled: enabled });
};
export const getPersonalityVoiceId = (stellaDataDir) => loadLocalPreferences(stellaDataDir).personalityVoiceId;
export const setPersonalityVoiceId = (stellaDataDir, id) => {
    const prefs = loadLocalPreferences(stellaDataDir);
    saveLocalPreferences(stellaDataDir, { ...prefs, personalityVoiceId: id });
};
export const getOnboardingCompleted = (stellaDataDir) => loadLocalPreferences(stellaDataDir).onboardingCompleted;
export const setOnboardingCompleted = (stellaDataDir, completed) => {
    const prefs = loadLocalPreferences(stellaDataDir);
    saveLocalPreferences(stellaDataDir, {
        ...prefs,
        onboardingCompleted: completed,
    });
};
// ── Normalization helpers ─────────────────────────────────────────────────
const normalizeEngine = (value) => {
    return coerceAgentRuntimeEngine(value);
};
const normalizeCodexModel = (value) => {
    if (typeof value !== "string")
        return DEFAULT_CODEX_MODEL;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : DEFAULT_CODEX_MODEL;
};
const normalizeClaudeCodeModel = (value) => {
    if (typeof value !== "string")
        return DEFAULT_CLAUDE_CODE_MODEL;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : DEFAULT_CLAUDE_CODE_MODEL;
};
const normalizeReasoningEffort = (value) => {
    if (value === "default" ||
        value === "minimal" ||
        value === "low" ||
        value === "medium" ||
        value === "high" ||
        value === "xhigh") {
        return value;
    }
    return "default";
};
export const normalizeCodexServiceTier = (value) => value === "fast" ? "fast" : DEFAULT_CODEX_SERVICE_TIER;
const normalizeAssistantPropagatedAgents = (value) => {
    if (!Array.isArray(value))
        return [];
    const seen = new Set();
    const out = [];
    for (const entry of value) {
        if (typeof entry !== "string")
            continue;
        const trimmed = entry.trim();
        if (!trimmed || seen.has(trimmed))
            continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
};
const normalizeModelPreferenceMap = (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return {};
    }
    const normalized = {};
    for (const [agentType, model] of Object.entries(value)) {
        const trimmedAgentType = agentType.trim();
        const trimmedModel = typeof model === "string" ? model.trim() : "";
        if (!trimmedAgentType || !trimmedModel)
            continue;
        if (trimmedModel === LEGACY_STELLA_DEFAULT_MODEL)
            continue;
        if (RETIRED_MODEL_PROVIDERS.has(trimmedModel.split("/", 1)[0] ?? "")) {
            continue;
        }
        normalized[trimmedAgentType] = trimmedModel;
    }
    return normalized;
};
const normalizeReasoningEfforts = (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return {};
    }
    const normalized = {};
    for (const [agentType, effort] of Object.entries(value)) {
        const trimmedAgentType = agentType.trim();
        if (!trimmedAgentType)
            continue;
        normalized[trimmedAgentType] = normalizeReasoningEffort(effort);
    }
    return normalized;
};
const normalizeConcurrency = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return DEFAULT_MAX_AGENT_CONCURRENCY;
    }
    const rounded = Math.floor(parsed);
    return Math.min(MAX_AGENT_CONCURRENCY_CEILING, rounded);
};
export const normalizeImageGenerationPreferences = (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { provider: "stella" };
    }
    const record = value;
    const provider = record.provider === "openai" ||
        record.provider === "openrouter" ||
        record.provider === "fal"
        ? record.provider
        : "stella";
    const model = typeof record.model === "string" && record.model.trim().length > 0
        ? record.model.trim()
        : undefined;
    return provider === "stella"
        ? { provider }
        : { provider, ...(model ? { model } : {}) };
};
const normalizeRealtimeVoiceSelections = (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const record = value;
    const out = {};
    if (typeof record.openai === "string" && record.openai.trim().length > 0) {
        out.openai = record.openai.trim();
    }
    if (typeof record.xai === "string" && record.xai.trim().length > 0) {
        out.xai = record.xai.trim();
    }
    if (typeof record.inworld === "string" && record.inworld.trim().length > 0) {
        out.inworld = record.inworld.trim();
    }
    return Object.keys(out).length > 0 ? out : undefined;
};
const UNDERLYING_PROVIDERS = [
    "openai",
    "xai",
    "inworld",
];
const coerceUnderlyingProvider = (value) => typeof value === "string" &&
    UNDERLYING_PROVIDERS.includes(value)
    ? value
    : undefined;
const INWORLD_SPEED_MIN = 0.5;
const INWORLD_SPEED_MAX = 2.0;
export const normalizeRealtimeVoicePreferences = (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { provider: "stella" };
    }
    const record = value;
    const provider = coerceRealtimeVoiceProvider(typeof record.provider === "string" ? record.provider : "");
    const model = typeof record.model === "string" && record.model.trim().length > 0
        ? record.model.trim()
        : undefined;
    const voices = normalizeRealtimeVoiceSelections(record.voices);
    const stellaSubProvider = coerceUnderlyingProvider(record.stellaSubProvider);
    const inworldSpeed = typeof record.inworldSpeed === "number" &&
        Number.isFinite(record.inworldSpeed)
        ? Math.min(INWORLD_SPEED_MAX, Math.max(INWORLD_SPEED_MIN, record.inworldSpeed))
        : undefined;
    const readAloudProvider = record.readAloudProvider === "openai" ||
        record.readAloudProvider === "inworld"
        ? record.readAloudProvider
        : undefined;
    const result = { provider };
    if (provider !== "stella" && model)
        result.model = model;
    if (voices)
        result.voices = voices;
    if (stellaSubProvider)
        result.stellaSubProvider = stellaSubProvider;
    if (inworldSpeed !== undefined)
        result.inworldSpeed = inworldSpeed;
    if (readAloudProvider)
        result.readAloudProvider = readAloudProvider;
    return result;
};
/**
 * Resolve the voice id that should be used for the active session, given
 * the user's preferences and the underlying provider that will actually
 * run the session.
 */
export const resolveRealtimeVoiceId = (prefs, underlyingProvider, fallback) => {
    const stored = prefs.voices?.[underlyingProvider]?.trim();
    return stored && stored.length > 0 ? stored : fallback;
};
