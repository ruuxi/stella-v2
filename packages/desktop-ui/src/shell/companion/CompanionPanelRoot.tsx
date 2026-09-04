/**
 * CompanionPanelRoot — the fixed-size window behind the mark that carries
 * everything but the mark itself:
 *
 *   ┌ bubbles: the latest exchange, iMessage style, fading after a dwell
 *   ├ composer: the prompt pill, open on click / dictation
 *   └ hull: a disc around the mark's spot holding the arc of buttons
 *           (read aloud · dictate · voice); the mark window sits on top of
 *           its center, so moving mark → button never crosses a gap
 *
 * Main keeps this window click-through until the mark is hovered or the
 * panel reports it has something to show, so its transparent area never
 * blocks the apps underneath while idle. The window is positioned so that
 * one horizontal and one vertical edge coincide with the mark window's; the
 * layout message says which, and everything is pinned to those edges.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  COMPANION_MARK_BOTTOM_INSET,
  COMPANION_MARK_SIDE_INSET,
  COMPANION_MARK_SIZE,
  COMPANION_MARK_TOP_INSET,
  type CompanionEdgeH,
  type CompanionEdgeV,
} from "@stella/contracts/desktop/companion";
import { useUiState } from "@/context/ui-state";
import { useComposerMessageState } from "@/features/chat/hooks/use-composer-message-state";
import { useDictation } from "@/features/dictation/hooks/use-dictation";
import { setReadAloudEnabled } from "@/features/voice/services/read-aloud/read-aloud-pref";
import { platformCapabilities } from "@/platform/capabilities";
import { useT } from "@/shared/i18n";
import { useDictationToggleBridge } from "@/shell/root-chrome/use-dictation-toggle-bridge";
import { AudioLines, Mic, Volume2 } from "@/ui/icons";
import { CompanionComposer } from "./CompanionComposer";
import { useCompanionBubbles } from "./use-companion-bubbles";
import { useCompanionState, useReadAloudEnabled } from "./use-companion-state";
import { useCompanionWindow } from "./use-companion-window";
import { useMarkPress } from "./use-mark-press";
import "./companion.css";

/** Arc geometry, in px around the mark's center. The arc opens toward the
 *  screen center (away from the anchored edges) so every button stays inside
 *  the window. */
const ARC_RADIUS = 72;
const ARC_ANGLES_BY_EDGE: Record<
  CompanionEdgeH,
  readonly [number, number, number]
> = {
  right: [172, 131, 90],
  left: [8, 49, 90],
};

const arcButtonStyle = (
  index: number,
  edgeH: CompanionEdgeH,
  edgeV: CompanionEdgeV,
): CSSProperties => {
  const angle = (ARC_ANGLES_BY_EDGE[edgeH][index] ?? 90) * (Math.PI / 180);
  const flipY = edgeV === "top" ? -1 : 1;
  return {
    "--arc-x": `${Math.cos(angle) * ARC_RADIUS}px`,
    "--arc-y": `${-Math.sin(angle) * ARC_RADIUS * flipY}px`,
    "--arc-i": index,
  } as CSSProperties;
};

/**
 * Mark position as CSS, relative to the two anchored window edges. Expressed
 * with `100%` so it re-resolves without waiting for main.
 */
const anchorVars = (
  edgeH: CompanionEdgeH,
  edgeV: CompanionEdgeV,
): CSSProperties => {
  const half = COMPANION_MARK_SIZE / 2;
  const centerFromSide = COMPANION_MARK_SIDE_INSET + half;
  return {
    "--companion-anchor-x":
      edgeH === "right"
        ? `calc(100% - ${centerFromSide}px)`
        : `${centerFromSide}px`,
    "--companion-anchor-y":
      edgeV === "bottom"
        ? `calc(100% - ${COMPANION_MARK_BOTTOM_INSET}px)`
        : `${COMPANION_MARK_TOP_INSET + COMPANION_MARK_SIZE}px`,
    "--companion-mark-size": `${COMPANION_MARK_SIZE}px`,
  } as CSSProperties;
};

export function CompanionPanelRoot() {
  const t = useT();
  const api = window.electronAPI?.companion;
  const state = useCompanionState();
  const { layout, activity } = useCompanionWindow();
  const { state: uiState } = useUiState();
  const voiceActive = Boolean(uiState.isVoiceRtcActive);
  const readAloudEnabled = useReadAloudEnabled();

  const [expanded, setExpanded] = useState(false);
  const [bubblesHovered, setBubblesHovered] = useState(false);
  const [focusRequestId, setFocusRequestId] = useState(0);
  const hovered = activity.hovered;

  useDictationToggleBridge();

  // ── Composer + dictation ─────────────────────────────────────────────
  const { message, setMessage, messageRef } = useComposerMessageState();
  /** Collapse once the send lands when dictation opened the composer. */
  const collapseAfterSendRef = useRef(false);

  const sendCurrent = useCallback(() => {
    const text = messageRef.current.trim();
    if (!text) return;
    api?.send({ text });
    setMessage("");
    if (collapseAfterSendRef.current) {
      collapseAfterSendRef.current = false;
      setExpanded(false);
    }
  }, [api, messageRef, setMessage]);

  const dictation = useDictation({
    message,
    setMessage,
    commitOnShortcutStop: true,
    onCommit: sendCurrent,
  });
  const dictationActive = dictation.isRecording || dictation.isTranscribing;
  const dictationActiveRef = useRef(dictationActive);
  dictationActiveRef.current = dictationActive;

  useEffect(() => {
    if (!dictation.isRecording) return;
    setExpanded((prev) => {
      if (!prev) collapseAfterSendRef.current = true;
      return true;
    });
  }, [dictation.isRecording]);

  // Main relays the mark's click (and closes us when a drag starts).
  useEffect(() => {
    if (!api) return;
    return api.onSetExpanded(({ expanded: next }) => {
      if (!next) collapseAfterSendRef.current = false;
      setExpanded(next === true);
    });
  }, [api]);

  // ── Bubbles + what main needs to know ────────────────────────────────
  const { bubbles, visible: bubblesVisible } = useCompanionBubbles(
    state,
    hovered || expanded || bubblesHovered,
  );
  const wantsVisible = expanded || bubbles.length > 0 || dictationActive;

  useEffect(() => {
    api?.reportPanelStatus({
      expanded,
      recording: dictation.isRecording,
      transcribing: dictation.isTranscribing,
      wantsVisible,
    });
  }, [
    api,
    expanded,
    dictation.isRecording,
    dictation.isTranscribing,
    wantsVisible,
  ]);

  useEffect(() => {
    if (!expanded) return;
    api?.focus();
    setFocusRequestId((id) => id + 1);
  }, [api, expanded]);

  // Losing OS focus closes the composer — unless a recording is in flight,
  // which the user may have started with the shortcut from another app, or
  // the window manager never granted us focus in the first place (a blur we
  // never earned would otherwise snap the composer shut as it opens).
  const focusedSinceExpandRef = useRef(false);
  useEffect(() => {
    if (expanded) focusedSinceExpandRef.current = document.hasFocus();
  }, [expanded]);
  useEffect(() => {
    const onFocus = () => {
      focusedSinceExpandRef.current = true;
    };
    const onBlur = () => {
      if (!focusedSinceExpandRef.current) return;
      if (!dictationActiveRef.current) {
        collapseAfterSendRef.current = false;
        setExpanded(false);
      }
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const collapse = useCallback(() => {
    if (dictationActiveRef.current) dictation.cancel();
    collapseAfterSendRef.current = false;
    setExpanded(false);
  }, [dictation]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") collapse();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [collapse]);

  // The panel may end up stacked above the mark window (compositors differ),
  // so it carries its own hit area at the mark's spot with the same
  // click-or-drag behaviour; whichever window is on top responds.
  const { dragging, handlers: markPressHandlers } = useMarkPress();

  // ── Arc actions ──────────────────────────────────────────────────────
  const arcVisible = hovered || expanded;
  const showVoice = platformCapabilities.realtimeVoice;
  const toggleVoice = useCallback(() => {
    window.electronAPI?.voice?.toggleRtc?.();
  }, []);
  const toggleReadAloud = useCallback(() => {
    void setReadAloudEnabled(!readAloudEnabled);
  }, [readAloudEnabled]);

  const edgeH: CompanionEdgeH = layout?.edgeH ?? "right";
  const edgeV: CompanionEdgeV = layout?.edgeV ?? "bottom";

  return (
    <div
      className="companion-root"
      data-hovered={hovered || undefined}
      data-expanded={expanded || undefined}
      data-dragging={dragging || undefined}
      data-edge-h={edgeH}
      data-edge-v={edgeV}
      style={anchorVars(edgeH, edgeV)}
    >
      <div className="companion-stack">
        {bubbles.length > 0 ? (
          <div
            className="companion-bubbles"
            data-visible={bubblesVisible || undefined}
            onMouseEnter={() => setBubblesHovered(true)}
            onMouseLeave={() => setBubblesHovered(false)}
          >
            {bubbles.map((bubble) => (
              <button
                key={bubble.key}
                type="button"
                className="companion-bubble"
                data-role={bubble.role}
                data-streaming={bubble.streaming || undefined}
                title={t("companion.bubble.openStella")}
                onClick={() => api?.openMain()}
              >
                {bubble.text ? (
                  <span className="companion-bubble__text">{bubble.text}</span>
                ) : (
                  <span
                    className="companion-bubble__typing"
                    aria-label={t("companion.bubble.typing")}
                  >
                    <i />
                    <i />
                    <i />
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : null}

        {expanded ? (
          <CompanionComposer
            message={message}
            setMessage={setMessage}
            dictation={dictation}
            isStreaming={state.isStreaming}
            focusRequestId={focusRequestId}
            onSend={sendCurrent}
            onStop={() => api?.stop()}
            onEscape={collapse}
          />
        ) : null}
      </div>

      <div
        className="companion-hull"
        data-active={arcVisible || undefined}
        onMouseEnter={() => api?.setHovered(true)}
        onMouseLeave={() => api?.setHovered(false)}
      >
        <div
          className="companion-arc"
          data-visible={arcVisible || undefined}
          aria-hidden={!arcVisible}
        >
          <button
            type="button"
            className="companion-arc__button"
            style={arcButtonStyle(0, edgeH, edgeV)}
            aria-pressed={readAloudEnabled}
            data-live={state.readAloudPlaying || undefined}
            tabIndex={arcVisible ? 0 : -1}
            title={t(
              readAloudEnabled
                ? "companion.arc.readAloudOn"
                : "companion.arc.readAloudOff",
            )}
            aria-label={t(
              readAloudEnabled
                ? "companion.arc.readAloudOn"
                : "companion.arc.readAloudOff",
            )}
            onClick={toggleReadAloud}
          >
            <Volume2 size={17} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className="companion-arc__button"
            style={arcButtonStyle(1, edgeH, edgeV)}
            aria-pressed={dictation.isRecording}
            data-live={dictation.isRecording || undefined}
            disabled={dictation.isTranscribing}
            tabIndex={arcVisible ? 0 : -1}
            title={t(
              dictation.isRecording
                ? "companion.arc.dictateStop"
                : "companion.arc.dictate",
            )}
            aria-label={t(
              dictation.isRecording
                ? "companion.arc.dictateStop"
                : "companion.arc.dictate",
            )}
            onClick={dictation.toggle}
          >
            <Mic size={17} strokeWidth={1.75} />
          </button>
          {showVoice ? (
            <button
              type="button"
              className="companion-arc__button"
              style={arcButtonStyle(2, edgeH, edgeV)}
              aria-pressed={voiceActive}
              data-live={voiceActive || undefined}
              tabIndex={arcVisible ? 0 : -1}
              title={t(
                voiceActive ? "companion.arc.voiceStop" : "companion.arc.voice",
              )}
              aria-label={t(
                voiceActive ? "companion.arc.voiceStop" : "companion.arc.voice",
              )}
              onClick={toggleVoice}
            >
              <AudioLines size={17} strokeWidth={1.75} />
            </button>
          ) : null}
        </div>
        <button
          type="button"
          className="companion-mark-hit"
          aria-label={t(
            expanded ? "companion.mark.close" : "companion.mark.open",
          )}
          aria-expanded={expanded}
          tabIndex={-1}
          {...markPressHandlers}
        />
      </div>
    </div>
  );
}
