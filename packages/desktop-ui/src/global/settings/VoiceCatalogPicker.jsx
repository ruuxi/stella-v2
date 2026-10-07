/**
 * VoiceCatalogPicker — voice selector that appears below the provider
 * list on the Voice tab of the model picker.
 *
 * Layout, top to bottom:
 *   - Label row with a static source label ("Stella voices" / "OpenAI
 *     voices" / "Grok voices"). Managed Stella mode always runs on
 *     GPT-Live, so there is no voice family to choose.
 *   - Voice stepper: a single horizontal box with left/right chevrons
 *     on either side of the current voice label. Chevrons cycle through
 *     the active catalog; clicking the label opens a dropdown listing
 *     every voice with its tone description.
 *   - Read-aloud provider toggle (Gemini / OpenAI). Gemini read-aloud has
 *     its own voice stepper, stored at `realtimeVoice.voices.gemini`;
 *     OpenAI read-aloud reuses the OpenAI voice above.
 */
import { useCallback, useMemo } from "react";
import { Check, ChevronLeft, ChevronRight, ChevronDown } from "@/ui/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, } from "@/ui/dropdown-menu";
import { DEFAULT_GEMINI_TTS_VOICE, GEMINI_TTS_VOICES, getDefaultRealtimeVoice, getRealtimeVoiceCatalog, } from "@stella/contracts/realtime-voice-catalog";
import { resolveReadAloudProvider, resolveRealtimeUnderlyingProvider, } from "@stella/contracts/local-preferences";
import { useT } from "@/shared/i18n";
import "./VoiceCatalogPicker.css";
/**
 * Chevron stepper + dropdown over one voice catalog. `activeVoiceId` is
 * display-only when it is a fallback: the server applies the real default.
 */
function VoiceStepper({ catalog, activeVoiceId, sourceLabel, onPick, disabled }) {
    const t = useT();
    const activeIndex = useMemo(() => {
        const idx = catalog.findIndex((entry) => entry.id === activeVoiceId);
        return idx === -1 ? 0 : idx;
    }, [catalog, activeVoiceId]);
    const activeEntry = catalog[activeIndex] ?? catalog[0];
    const cycleBy = useCallback((delta) => {
        if (disabled || catalog.length === 0)
            return;
        const next = (activeIndex + delta + catalog.length) % catalog.length;
        onPick(catalog[next].id);
    }, [activeIndex, catalog, disabled, onPick]);
    const handleDropdownPick = useCallback((voiceId) => {
        if (disabled)
            return;
        onPick(voiceId);
    }, [disabled, onPick]);
    return (<div className="voice-catalog-stepper-wrap">
        <div className="voice-catalog-stepper" role="group" aria-label={t("settings.voiceCatalog.label")}>
          <button type="button" className="voice-catalog-stepper-arrow" onClick={() => cycleBy(-1)} disabled={disabled || catalog.length < 2} aria-label={t("settings.voiceCatalog.previousVoice")}>
            <ChevronLeft size={14} strokeWidth={2}/>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="voice-catalog-stepper-current" disabled={disabled}>
                <span className="voice-catalog-stepper-name">
                  {activeEntry?.label ?? "—"}
                </span>
                <ChevronDown size={12} strokeWidth={2}/>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="center" sideOffset={6} className="voice-catalog-menu" aria-label={t("settings.voiceCatalog.menuAriaLabel", { source: sourceLabel })}>
              {catalog.map((voice) => {
            const selected = voice.id === activeVoiceId;
            return (<DropdownMenuItem key={voice.id} onSelect={() => handleDropdownPick(voice.id)} disabled={disabled} data-selected={selected || undefined} className="voice-catalog-menu-item">
                    <span className="voice-catalog-menu-item-text">
                      <span className="voice-catalog-menu-item-name">
                        {voice.label}
                      </span>
                      <span className="voice-catalog-menu-item-desc">
                        {voice.description}
                      </span>
                    </span>
                    {selected ? (<Check size={13} className="voice-catalog-menu-item-check"/>) : null}
                  </DropdownMenuItem>);
        })}
            </DropdownMenuContent>
          </DropdownMenu>
          <button type="button" className="voice-catalog-stepper-arrow" onClick={() => cycleBy(1)} disabled={disabled || catalog.length < 2} aria-label={t("settings.voiceCatalog.nextVoice")}>
            <ChevronRight size={14} strokeWidth={2}/>
          </button>
        </div>
        {activeEntry?.description ? (<p className="voice-catalog-stepper-desc">{activeEntry.description}</p>) : null}
      </div>);
}
export function VoiceCatalogPicker({ voiceProvider, selectedVoices, onSelectVoice, readAloudProvider, onSelectReadAloudProvider, onSelectReadAloudVoice, disabled = false, }) {
    const t = useT();
    // Pinned per top-level provider: BYOK modes keep their own Realtime
    // families and managed Stella mode is always GPT-Live.
    const underlyingProvider = resolveRealtimeUnderlyingProvider({
        provider: voiceProvider,
    });
    const catalog = getRealtimeVoiceCatalog(underlyingProvider);
    // DISPLAY-ONLY: which voice to highlight when the user hasn't picked one.
    // The real default is server-authoritative (the client omits the voice and
    // the backend applies it), so this bundled constant only affects which chip
    // is pre-highlighted in the picker — never what actually gets synthesized.
    // If it drifts from the server default, only the badge is wrong, not audio.
    const fallback = getDefaultRealtimeVoice(underlyingProvider);
    const activeVoiceId = selectedVoices?.[underlyingProvider]?.trim() || fallback;
    const activeReadAloud = resolveReadAloudProvider({ readAloudProvider });
    const showReadAloud = typeof onSelectReadAloudProvider === "function";
    const handleVoicePick = useCallback((voiceId) => {
        onSelectVoice(underlyingProvider, voiceId);
    }, [onSelectVoice, underlyingProvider]);
    const handleReadAloudVoicePick = useCallback((voiceId) => {
        onSelectReadAloudVoice?.(voiceId);
    }, [onSelectReadAloudVoice]);
    const activeReadAloudVoiceId = selectedVoices?.gemini?.trim() || DEFAULT_GEMINI_TTS_VOICE;
    const handleReadAloudPick = useCallback((provider) => {
        if (disabled || !onSelectReadAloudProvider)
            return;
        if (provider === activeReadAloud)
            return;
        onSelectReadAloudProvider(provider);
    }, [activeReadAloud, disabled, onSelectReadAloudProvider]);
    const labelSourceText = underlyingProvider === "xai"
        ? t("settings.voiceCatalog.source.xai")
        : underlyingProvider === "openai"
            ? t("settings.voiceCatalog.source.openai")
            : t("settings.voiceCatalog.source.gptlive");
    return (<div className="voice-catalog-picker" data-disabled={disabled || undefined}>
      <div className="voice-catalog-picker-label">
        <span>{t("settings.voiceCatalog.label")}</span>
        <span className="voice-catalog-picker-label-source">
          {labelSourceText}
        </span>
      </div>

      <VoiceStepper catalog={catalog} activeVoiceId={activeVoiceId} sourceLabel={labelSourceText} onPick={handleVoicePick} disabled={disabled}/>
      {showReadAloud ? (<div className="voice-catalog-readaloud">
          <div className="voice-catalog-picker-label">
            <span>{t("settings.voiceCatalog.readAloud.label")}</span>
            <div className="voice-catalog-subtoggle" role="tablist" aria-label={t("settings.voiceCatalog.readAloud.ariaLabel")}>
              <button type="button" role="tab" aria-selected={activeReadAloud === "gemini"} className="voice-catalog-subtoggle-btn" data-active={activeReadAloud === "gemini" || undefined} onClick={() => handleReadAloudPick("gemini")} disabled={disabled} title={t("settings.voiceCatalog.readAloud.geminiTitle")}>
                Gemini
              </button>
              <button type="button" role="tab" aria-selected={activeReadAloud === "openai"} className="voice-catalog-subtoggle-btn" data-active={activeReadAloud === "openai" || undefined} onClick={() => handleReadAloudPick("openai")} disabled={disabled} title={t("settings.voiceCatalog.readAloud.openaiTitle")}>
                OpenAI
              </button>
            </div>
          </div>
          {activeReadAloud === "gemini" ? (<VoiceStepper catalog={GEMINI_TTS_VOICES} activeVoiceId={activeReadAloudVoiceId} sourceLabel={t("settings.voiceCatalog.source.gemini")} onPick={handleReadAloudVoicePick} disabled={disabled || !onSelectReadAloudVoice}/>) : null}
          <p className="voice-catalog-readaloud-desc">
            {t("settings.voiceCatalog.readAloud.description")}
          </p>
        </div>) : null}
    </div>);
}
