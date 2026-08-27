import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, ChevronDown } from "@/ui/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, } from "@/ui/dropdown-menu";
import { DEFAULT_INWORLD_REALTIME_SPEED, getDefaultRealtimeVoice, getRealtimeVoiceCatalog, } from "@stella/contracts/realtime-voice-catalog";
import { resolveReadAloudProvider, resolveRealtimeUnderlyingProvider, } from "@stella/contracts/local-preferences";
import { useT } from "@/shared/i18n";
import "./VoiceCatalogPicker.css";

const SPEED_MIN = 0.5;
const SPEED_MAX = 2.0;
const LOG_SPEED_MIN = Math.log(SPEED_MIN);
const LOG_SPEED_MAX = Math.log(SPEED_MAX);
const LOG_SPEED_RANGE = LOG_SPEED_MAX - LOG_SPEED_MIN;
const speedToSliderPosition = (speed) => {
    const clamped = Math.max(SPEED_MIN, Math.min(SPEED_MAX, speed));
    return ((Math.log(clamped) - LOG_SPEED_MIN) / LOG_SPEED_RANGE) * 100;
};
const sliderPositionToSpeed = (position) => {
    const clamped = Math.max(0, Math.min(100, position));
    const raw = Math.exp(LOG_SPEED_MIN + (clamped / 100) * LOG_SPEED_RANGE);

    return Math.round(raw * 20) / 20;
};
export function VoiceCatalogPicker({ voiceProvider, stellaSubProvider, selectedVoices, inworldSpeed, onSelectVoice, onSelectStellaSubProvider, onSelectInworldSpeed, readAloudProvider, onSelectReadAloudProvider, disabled = false, }) {
    const t = useT();

    const underlyingProvider = resolveRealtimeUnderlyingProvider({
        provider: voiceProvider,
        stellaSubProvider,
    });
    const catalog = getRealtimeVoiceCatalog(underlyingProvider);

    const fallback = getDefaultRealtimeVoice(underlyingProvider);
    const activeVoiceId = selectedVoices?.[underlyingProvider]?.trim() || fallback;
    const activeIndex = useMemo(() => {
        const idx = catalog.findIndex((entry) => entry.id === activeVoiceId);
        return idx === -1 ? 0 : idx;
    }, [catalog, activeVoiceId]);
    const activeEntry = catalog[activeIndex] ?? catalog[0];
    const showSubToggle = voiceProvider === "stella";
    const showSpeed = underlyingProvider === "inworld";
    const activeSpeed = inworldSpeed ?? DEFAULT_INWORLD_REALTIME_SPEED;
    const activeReadAloud = resolveReadAloudProvider({ readAloudProvider });
    const showReadAloud = typeof onSelectReadAloudProvider === "function";

    const [draftSpeed, setDraftSpeed] = useState(activeSpeed);
    const draggingRef = useRef(false);
    useEffect(() => {
        if (!draggingRef.current) {
            setDraftSpeed(activeSpeed);
        }
    }, [activeSpeed]);
    const commitSpeed = useCallback((value) => {
        draggingRef.current = false;
        if (Math.abs(value - activeSpeed) < 0.001)
            return;
        onSelectInworldSpeed(value);
    }, [activeSpeed, onSelectInworldSpeed]);
    const cycleBy = useCallback((delta) => {
        if (disabled || catalog.length === 0)
            return;
        const next = (activeIndex + delta + catalog.length) % catalog.length;
        onSelectVoice(underlyingProvider, catalog[next].id);
    }, [activeIndex, catalog, disabled, onSelectVoice, underlyingProvider]);
    const handleDropdownPick = useCallback((voiceId) => {
        if (disabled)
            return;
        onSelectVoice(underlyingProvider, voiceId);
    }, [disabled, onSelectVoice, underlyingProvider]);
    const handleSubToggle = useCallback((sub) => {
        if (disabled || !showSubToggle)
            return;
        onSelectStellaSubProvider(sub);
    }, [disabled, onSelectStellaSubProvider, showSubToggle]);
    const handleSpeedChange = useCallback((event) => {
        if (disabled)
            return;
        const position = Number.parseFloat(event.target.value);
        if (!Number.isFinite(position))
            return;
        draggingRef.current = true;
        setDraftSpeed(sliderPositionToSpeed(position));
    }, [disabled]);
    const handleSpeedCommit = useCallback(() => {
        if (disabled)
            return;
        commitSpeed(draftSpeed);
    }, [commitSpeed, disabled, draftSpeed]);
    const handleReadAloudPick = useCallback((provider) => {
        if (disabled || !onSelectReadAloudProvider)
            return;
        if (provider === activeReadAloud)
            return;
        onSelectReadAloudProvider(provider);
    }, [activeReadAloud, disabled, onSelectReadAloudProvider]);
    const labelSourceText = underlyingProvider === "xai"
        ? t("settings.voiceCatalog.source.xai")
        : underlyingProvider === "inworld"
            ? t("settings.voiceCatalog.source.inworld")
            : t("settings.voiceCatalog.source.openai");
    return (<div className="voice-catalog-picker" data-disabled={disabled || undefined}>
      <div className="voice-catalog-picker-label">
        <span>{t("settings.voiceCatalog.label")}</span>
        {showSubToggle ? (<div className="voice-catalog-subtoggle" role="tablist" aria-label={t("settings.voiceCatalog.familyAriaLabel")}>
            <button type="button" role="tab" aria-selected={underlyingProvider === "openai"} className="voice-catalog-subtoggle-btn" data-active={underlyingProvider === "openai" || undefined} onClick={() => handleSubToggle("openai")} disabled={disabled} title={t("settings.voiceCatalog.familyTitle.openai")}>
              OpenAI
            </button>
            <button type="button" role="tab" aria-selected={underlyingProvider === "xai"} className="voice-catalog-subtoggle-btn" data-active={underlyingProvider === "xai" || undefined} onClick={() => handleSubToggle("xai")} disabled={disabled} title={t("settings.voiceCatalog.familyTitle.xai")}>
              xAI
            </button>
            <button type="button" role="tab" aria-selected={underlyingProvider === "inworld"} className="voice-catalog-subtoggle-btn" data-active={underlyingProvider === "inworld" || undefined} onClick={() => handleSubToggle("inworld")} disabled={disabled} title={t("settings.voiceCatalog.familyTitle.inworld")}>
              Inworld
            </button>
          </div>) : (<span className="voice-catalog-picker-label-source">
            {labelSourceText}
          </span>)}
      </div>

      <div className="voice-catalog-stepper-wrap">
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
            <DropdownMenuContent side="top" align="center" sideOffset={6} className="voice-catalog-menu" aria-label={t("settings.voiceCatalog.menuAriaLabel", { source: labelSourceText })}>
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
      </div>

      {showSpeed ? (<div className="voice-catalog-speed">
          <div className="voice-catalog-speed-header">
            <span className="voice-catalog-speed-label">{t("settings.voiceCatalog.speed")}</span>
            <span className="voice-catalog-speed-value">
              {draftSpeed.toFixed(2)}×
            </span>
          </div>
          <input type="range" className="voice-catalog-speed-slider" min={0} max={100} step={0.5} value={speedToSliderPosition(draftSpeed)} onChange={handleSpeedChange} onPointerUp={handleSpeedCommit} onKeyUp={handleSpeedCommit} onBlur={handleSpeedCommit} disabled={disabled} aria-label={t("settings.voiceCatalog.speedAriaLabel")} aria-valuetext={`${draftSpeed.toFixed(2)}×`}/>
          <div className="voice-catalog-speed-marks">
            <span>0.5×</span>
            <span>1.0×</span>
            <span>2.0×</span>
          </div>
        </div>) : null}

      {showReadAloud ? (<div className="voice-catalog-readaloud">
          <div className="voice-catalog-picker-label">
            <span>{t("settings.voiceCatalog.readAloud.label")}</span>
            <div className="voice-catalog-subtoggle" role="tablist" aria-label={t("settings.voiceCatalog.readAloud.ariaLabel")}>
              <button type="button" role="tab" aria-selected={activeReadAloud === "openai"} className="voice-catalog-subtoggle-btn" data-active={activeReadAloud === "openai" || undefined} onClick={() => handleReadAloudPick("openai")} disabled={disabled} title={t("settings.voiceCatalog.readAloud.openaiTitle")}>
                OpenAI
              </button>
              <button type="button" role="tab" aria-selected={activeReadAloud === "inworld"} className="voice-catalog-subtoggle-btn" data-active={activeReadAloud === "inworld" || undefined} onClick={() => handleReadAloudPick("inworld")} disabled={disabled} title={t("settings.voiceCatalog.readAloud.inworldTitle")}>
                Inworld
              </button>
            </div>
          </div>
          <p className="voice-catalog-readaloud-desc">
            {t("settings.voiceCatalog.readAloud.description")}
          </p>
        </div>) : null}
    </div>);
}
