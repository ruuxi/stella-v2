/**
 * MiniModelPicker — the pinned model control in the composer's expanded
 * toolbar (shown while the Work footer's "Show in composer" toggle is on).
 *
 * The trigger shows the active model's display name; the popover opens
 * above it (the composer sits at the bottom of the screen) with the
 * reasoning-effort pills and the freshest recent models. Selections apply
 * exactly like the sidebar picker's Assistant tab — same preference patch,
 * same `stella:local-model-preferences-changed` announcement.
 *
 * It deliberately stays a shortcut, not a second picker: anything beyond
 * "switch back to a model I just used" hands off to the full picker
 * through the last row.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Lightbulb, SlidersHorizontal } from "@/ui/icons";
import { BrandIcon } from "@/ui/brand-icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { openModelPicker } from "@/features/workspace-display/default-tabs";
import {
  isDeepSeekV4FlashModel,
  isMuseSpark13ContributorModel,
} from "@stella/contracts/stella-api";
import { useModelCatalog } from "@/global/settings/hooks/use-model-catalog";
import { getStellaResolvedModelName } from "@/global/settings/lib/model-catalog";
import { buildModelDefaultsMap, buildResolvedModelDefaultsMap, getConfigurableAgents, getLocalModelDefaults, getModelPickerDisplayLabel, normalizeModelOverrides, } from "@/global/settings/lib/model-defaults";
import { buildEngineReasoningPatch, buildRecentModelSelectionPatch, DEFAULT_CHATGPT_MODEL, DEFAULT_CLAUDE_CODE_MODEL, } from "@/global/settings/lib/engine-model-routing";
import { listReasoningEffortOptions } from "@/global/settings/lib/reasoning-effort-options";
import { buildRecentModelRows, createKnownModelIdPredicate, readRecentModels, recordRecentModel, } from "@/global/settings/lib/recent-models";
import { showToast } from "@/ui/toast";
import { useT } from "@/shared/i18n";
import "./mini-model-picker.css";
/** Mirrors the sidebar Assistant tab's dual orchestrator + general write. */
const ASSISTANT_AGENT_KEYS = ["orchestrator", "general"];
const NO_EXCLUDED_IDS = new Set();
/**
 * Brand glyph for a row. Engine aliases carry the engine's vendor; catalog
 * ids resolve through the merged catalog's provider key (the same key
 * `BrandIcon` takes elsewhere), and anything unresolved falls back to the
 * id's own namespace so BYOK/local rows still get a stable mark.
 */
const getModelBrandKey = (modelId, providersById) => {
    if (modelId.startsWith("claude-code/"))
        return "anthropic";
    if (modelId.startsWith("codex-cli/"))
        return "openai";
    return (providersById.get(modelId) ?? modelId.split("/")[0] ?? "stella");
};
/**
 * Last-known local model preferences, so re-mounting the pinned control
 * (composer remounts on conversation switches) doesn't flash a loading
 * label while the IPC roundtrip lands.
 */
let cachedMiniPickerPreferences = null;
export function MiniModelPicker() {
    const t = useT();
    const { allModels, defaults: stellaDefaultModels } = useModelCatalog();
    const [preferences, setPreferencesRaw] = useState(cachedMiniPickerPreferences);
    const [recentIds, setRecentIds] = useState(() => readRecentModels());
    const [open, setOpen] = useState(false);
    const [pending, setPending] = useState(false);
    const setPreferences = useCallback((next) => {
        if (next)
            cachedMiniPickerPreferences = next;
        setPreferencesRaw(next);
    }, []);
    useEffect(() => {
        let cancelled = false;
        const loadPreferences = async () => {
            const next = await window.electronAPI?.system?.getLocalModelPreferences?.();
            if (cancelled || !next)
                return;
            cachedMiniPickerPreferences = next;
            setPreferencesRaw(next);
        };
        void loadPreferences().catch(() => undefined);
        const handlePreferencesChanged = () => {
            void loadPreferences().catch(() => undefined);
        };
        window.addEventListener("stella:local-model-preferences-changed", handlePreferencesChanged);
        return () => {
            cancelled = true;
            window.removeEventListener("stella:local-model-preferences-changed", handlePreferencesChanged);
        };
    }, []);
    // Recents are re-read on every open so picks recorded by the sidebar
    // picker (same uiState store) show up without an event channel.
    useEffect(() => {
        if (open)
            setRecentIds(readRecentModels());
    }, [open]);
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
    const modelProvidersById = useMemo(() => {
        const next = new Map();
        for (const model of allModels) {
            next.set(model.id, model.provider);
            if (model.upstreamModel)
                next.set(model.upstreamModel, model.provider);
        }
        return next;
    }, [allModels]);
    const modelDefaults = useMemo(() => {
        if (!preferences)
            return undefined;
        return getLocalModelDefaults(preferences.defaultModels, stellaDefaultModels);
    }, [preferences, stellaDefaultModels]);
    const configurableAgentKeys = useMemo(() => getConfigurableAgents(modelDefaults).map((agent) => agent.key), [modelDefaults]);
    const overrides = useMemo(() => {
        if (!preferences)
            return {};
        return normalizeModelOverrides(preferences.modelOverrides);
    }, [preferences]);
    const committedEngine = preferences?.agentRuntimeEngine ?? "default";
    /** Current selection as an override id, engine routes included — the
     * same id family the recents store persists. */
    const currentId = committedEngine === "codex_cli"
        ? `codex-cli/${preferences?.codexModel || DEFAULT_CHATGPT_MODEL}`
        : committedEngine === "claude_code_local"
            ? `claude-code/${preferences?.claudeCodeModel || DEFAULT_CLAUDE_CODE_MODEL}`
            : (overrides.orchestrator ?? overrides.general ?? "");
    const defaultModelId = useMemo(() => buildResolvedModelDefaultsMap(modelDefaults).orchestrator ??
        buildModelDefaultsMap(modelDefaults).orchestrator ??
        "", [modelDefaults]);
    const triggerLabel = preferences === null
        ? t("app.chat.miniModelPicker.loading")
        : getModelPickerDisplayLabel(currentId || defaultModelId, modelNamesById);
    const reasoningEffortOptions = listReasoningEffortOptions(committedEngine);
    const savedReasoningEffort = committedEngine === "codex_cli"
        ? (preferences?.codexReasoningEffort ?? "default")
        : committedEngine === "claude_code_local"
            ? (preferences?.claudeCodeReasoningEffort ?? "default")
            : (preferences?.reasoningEfforts?.orchestrator ??
                preferences?.reasoningEfforts?.general ??
                "default");
    const reportedDefaultReasoningEffort = null;
    const selectedStellaModelId = currentId || defaultModelId;
    const selectedStellaCatalogModel = allModels.find((model) => model.id === selectedStellaModelId ||
        model.upstreamModel === selectedStellaModelId);
    const selectedModelDefaultsToXhigh = committedEngine === "default" &&
        ((isDeepSeekV4FlashModel(selectedStellaModelId) ||
            isDeepSeekV4FlashModel(selectedStellaCatalogModel?.upstreamModel)) ||
            (isMuseSpark13ContributorModel(selectedStellaModelId) ||
                isMuseSpark13ContributorModel(selectedStellaCatalogModel?.upstreamModel)));
    // Mirrors the sidebar picker's `effectiveDefaultReasoningEffort`: a
    // live-reported ChatGPT default wins when it maps to a known option.
    const effectiveDefaultReasoningEffort = reasoningEffortOptions.some((option) => option.id === reportedDefaultReasoningEffort)
        ? reportedDefaultReasoningEffort
        : selectedModelDefaultsToXhigh
            ? "xhigh"
            : "medium";
    const currentReasoningEffort = savedReasoningEffort === "default"
        ? effectiveDefaultReasoningEffort
        : savedReasoningEffort;
    const isKnownModelId = useMemo(() => createKnownModelIdPredicate(new Set(allModels.map((model) => model.id))), [allModels]);
    const recentRows = useMemo(() => buildRecentModelRows({
        currentId,
        recentIds,
        excludeIds: NO_EXCLUDED_IDS,
        isKnownModelId,
        limit: 5,
    }), [currentId, isKnownModelId, recentIds]);
    const applyPreferencesPatch = useCallback(async (patch, errorLabel) => {
        if (!preferences || pending)
            return;
        const previous = preferences;
        setPending(true);
        setPreferences({ ...preferences, ...patch });
        try {
            const saved = await window.electronAPI?.system?.setLocalModelPreferences?.(patch);
            if (saved)
                setPreferences(saved);
            // Let the sidebar picker and mention menu pick up the change.
            window.dispatchEvent(new CustomEvent("stella:local-model-preferences-changed"));
        }
        catch (caught) {
            setPreferences(previous);
            showToast({
                title: t("app.chat.miniModelPicker.updateFailedTitle"),
                description: caught instanceof Error ? caught.message : errorLabel,
                variant: "error",
            });
        }
        finally {
            setPending(false);
        }
    }, [pending, preferences, setPreferences, t]);
    const handleReasoningEffortSelect = useCallback((effort) => {
        if (!preferences)
            return;
        const patch = buildEngineReasoningPatch(preferences, preferences.agentRuntimeEngine, effort, ASSISTANT_AGENT_KEYS);
        void applyPreferencesPatch(patch, t("app.chat.miniModelPicker.reasoningUpdateFailed"));
    }, [applyPreferencesPatch, preferences, t]);
    const handleRecentSelect = useCallback((row) => {
        if (!preferences)
            return;
        setOpen(false);
        if (row.id === currentId || row.unavailable)
            return;
        const patch = buildRecentModelSelectionPatch(preferences, row.id, {
            assistant: true,
            configurableAgentKeys,
        });
        setRecentIds(recordRecentModel(row.id));
        void applyPreferencesPatch(patch, t("app.chat.miniModelPicker.modelUpdateFailed"));
    }, [applyPreferencesPatch, configurableAgentKeys, currentId, preferences, t]);
    const handleOpenFullPicker = useCallback(() => {
        setOpen(false);
        openModelPicker();
    }, []);
    const triggerBrand = getModelBrandKey(currentId || defaultModelId, modelProvidersById);
    return (<Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="pill-btn mini-model-picker-trigger" data-active={open || undefined} title={triggerLabel} aria-label={t("app.chat.miniModelPicker.triggerLabel", { model: triggerLabel })}>
          <BrandIcon brand={triggerBrand} size={13} className="mini-model-picker-trigger-brand"/>
          <span className="mini-model-picker-trigger-label">{triggerLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="mini-model-picker-popover" aria-label={t("app.chat.miniModelPicker.popoverLabel")}>
        <div className="mini-model-picker-reasoning">
          <Lightbulb size={14} strokeWidth={1.75} className="mini-model-picker-reasoning-icon" aria-hidden/>
          <div className="mini-model-picker-reasoning-options" role="radiogroup" aria-label={t("app.chat.miniModelPicker.reasoningEffortLabel")}>
            {reasoningEffortOptions.map((option) => (<button key={option.id} type="button" role="radio" aria-checked={currentReasoningEffort === option.id} data-active={currentReasoningEffort === option.id || undefined} disabled={!preferences || pending} onClick={() => handleReasoningEffortSelect(option.id)}>
                {option.label}
              </button>))}
          </div>
        </div>
        {recentRows.length > 0 ? (<div className="mini-model-picker-rows" role="listbox" aria-label={t("app.chat.miniModelPicker.modelsLabel")}>
            {recentRows.map((row) => {
                const selected = row.id === currentId;
                return (<button key={row.id} type="button" role="option" aria-selected={selected} aria-disabled={row.unavailable || undefined} data-selected={selected || undefined} disabled={pending || row.unavailable} onClick={() => handleRecentSelect(row)}>
                <BrandIcon brand={getModelBrandKey(row.id, modelProvidersById)} size={14} className="mini-model-picker-row-brand"/>
                <span className="mini-model-picker-row-name">
                  {getModelPickerDisplayLabel(row.id, modelNamesById)}
                </span>
                {row.unavailable ? (<span className="mini-model-picker-row-note">
                    {t("app.chat.miniModelPicker.unavailable")}
                  </span>) : null}
              </button>);
            })}
          </div>) : null}
        <div className="mini-model-picker-rows mini-model-picker-rows--more">
          <button type="button" className="mini-model-picker-more" onClick={handleOpenFullPicker}>
            <SlidersHorizontal size={14} strokeWidth={1.75} className="mini-model-picker-row-brand" aria-hidden/>
            <span className="mini-model-picker-row-name">
              {t("app.chat.miniModelPicker.moreModels")}
            </span>
          </button>
        </div>
      </PopoverContent>
    </Popover>);
}
