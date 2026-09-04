/**
 * CompanionRoot — the floating desktop Stella.
 *
 * One window, three layers stacked upward from the mark's anchor point:
 *
 *   ┌ bubbles: the latest exchange, iMessage style, fading after a dwell
 *   ├ composer: the prompt pill, open on click / dictation
 *   └ hull: an invisible disc around the mark that carries the arc of buttons
 *           (read aloud · dictate · voice) so moving from the mark to a
 *           button never crosses a gap that would end the hover
 *
 * The mark is the only permanent hit target. Hover grows the window (via
 * main) so the arc has room; leaving the hull collapses it after a grace
 * period. Click toggles the composer, drag moves the anchor, right-click
 * opens the native menu.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  COMPANION_MARK_BOTTOM_INSET,
  COMPANION_MARK_SIDE_INSET,
  COMPANION_MARK_SIZE,
  COMPANION_MARK_TOP_INSET,
  type CompanionEdgeH,
  type CompanionEdgeV,
  type CompanionLayout,
  type CompanionLayoutMode,
} from "@stella/contracts/desktop/companion";
import { useUiState } from "@/context/ui-state";
import { useComposerMessageState } from "@/features/chat/hooks/use-composer-message-state";
import { useDictation } from "@/features/dictation/hooks/use-dictation";
import { setReadAloudEnabled } from "@/features/voice/services/read-aloud/read-aloud-pref";
import { platformCapabilities } from "@/platform/capabilities";
import { useT } from "@/shared/i18n";
import { useDictationToggleBridge } from "@/shell/root-chrome/use-dictation-toggle-bridge";
import { AudioLines, Mic, Volume2 } from "@/ui/icons";
import {
  StellaCharacter,
  type StellaCharacterState,
} from "@/ui/stella-character/StellaCharacter";
import type { StellaMarkHandle } from "@/ui/stella-character/rig";
import { CompanionComposer } from "./CompanionComposer";
import { useCompanionBubbles } from "./use-companion-bubbles";
import {
  useCompanionState,
  useReadAloudEnabled,
  useVoiceSpeakingState,
} from "./use-companion-state";
import "./companion.css";

/** Hover survives this long after the pointer leaves the hull. */
const HOVER_LEAVE_GRACE_MS = 340;
/** Pointer travel before a press becomes a drag instead of a click. */
const DRAG_THRESHOLD_PX = 5;
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

const useDocumentVisible = (): boolean => {
  const [visible, setVisible] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
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
 * with `100%` so it re-resolves on every resize without waiting for main.
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

export function CompanionRoot() {
  const t = useT();
  const api = window.electronAPI?.companion;
  const state = useCompanionState();
  const { state: uiState } = useUiState();
  const voiceActive = Boolean(uiState.isVoiceRtcActive);
  const voice = useVoiceSpeakingState(voiceActive);
  const readAloudEnabled = useReadAloudEnabled();
  const documentVisible = useDocumentVisible();

  const [layout, setLayout] = useState<CompanionLayout | null>(null);
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [bubblesHovered, setBubblesHovered] = useState(false);
  const [focusRequestId, setFocusRequestId] = useState(0);
  const markHandleRef = useRef<StellaMarkHandle | null>(null);

  useDictationToggleBridge();

  // ── Composer + dictation (lifted so the shortcut works while collapsed) ──
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

  // ── Layout negotiation with main ─────────────────────────────────────
  const { bubbles, visible: bubblesVisible } = useCompanionBubbles(
    state,
    hovered || expanded || bubblesHovered,
  );
  const mode: CompanionLayoutMode = dragging
    ? "compact"
    : hovered || expanded || bubbles.length > 0
      ? "full"
      : "compact";

  useEffect(() => {
    api?.setLayout(mode);
  }, [api, mode]);

  useEffect(() => api?.onLayout(setLayout), [api]);

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
      setHovered(false);
      if (!focusedSinceExpandRef.current) return;
      if (!dictationActiveRef.current) setExpanded(false);
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const collapse = useCallback(() => {
    if (dictationActiveRef.current) {
      dictation.cancel();
    }
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

  // ── Hover with grace ─────────────────────────────────────────────────
  const leaveTimerRef = useRef<number | null>(null);
  const clearLeaveTimer = () => {
    if (leaveTimerRef.current !== null) {
      window.clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
  };
  const onHullEnter = () => {
    clearLeaveTimer();
    setHovered(true);
  };
  const onHullLeave = () => {
    clearLeaveTimer();
    leaveTimerRef.current = window.setTimeout(() => {
      leaveTimerRef.current = null;
      setHovered(false);
    }, HOVER_LEAVE_GRACE_MS);
  };
  useEffect(() => clearLeaveTimer, []);

  // ── Click / drag on the mark ─────────────────────────────────────────
  const pressRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
    lastX: number;
    lastY: number;
    frame: number | null;
  } | null>(null);

  const flushDragMove = useCallback(() => {
    const press = pressRef.current;
    if (!press) return;
    press.frame = null;
    api?.dragMove({ screenX: press.lastX, screenY: press.lastY });
  }, [api]);

  const onMarkPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pressRef.current = {
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
      lastX: event.screenX,
      lastY: event.screenY,
      moved: false,
      frame: null,
    };
  };

  const onMarkPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const press = pressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    press.lastX = event.screenX;
    press.lastY = event.screenY;
    if (!press.moved) {
      const dx = press.lastX - press.startX;
      const dy = press.lastY - press.startY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      press.moved = true;
      clearLeaveTimer();
      setHovered(false);
      setExpanded(false);
      setDragging(true);
      api?.dragStart({ screenX: press.startX, screenY: press.startY });
    }
    if (press.frame === null) {
      press.frame = requestAnimationFrame(flushDragMove);
    }
  };

  const endPress = (
    event: ReactPointerEvent<HTMLButtonElement>,
    cancelled: boolean,
  ) => {
    const press = pressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    pressRef.current = null;
    if (press.frame !== null) cancelAnimationFrame(press.frame);
    if (press.moved) {
      api?.dragMove({ screenX: press.lastX, screenY: press.lastY });
      api?.dragEnd();
      setDragging(false);
      return;
    }
    if (cancelled) return;
    markHandleRef.current?.sparkle();
    setExpanded((prev) => {
      if (prev) collapseAfterSendRef.current = false;
      return !prev;
    });
  };

  // ── Mark mood ────────────────────────────────────────────────────────
  const markState = useMemo<StellaCharacterState>(() => {
    if (dragging) return "happy";
    if (dictation.isRecording) return "listening";
    if (dictation.isTranscribing) return "thinking";
    if (voiceActive) {
      if (voice.isSpeaking) return "speaking";
      if (voice.isUserSpeaking) return "listening";
      return "waking";
    }
    if (state.readAloudPlaying) return "speaking";
    if (state.isStreaming) return state.workState ?? "thinking";
    return "idle";
  }, [
    dragging,
    dictation.isRecording,
    dictation.isTranscribing,
    voiceActive,
    voice.isSpeaking,
    voice.isUserSpeaking,
    state.readAloudPlaying,
    state.isStreaming,
    state.workState,
  ]);

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
  const rootStyle = anchorVars(edgeH, edgeV);

  const runningCount = state.runningAgentCount;

  return (
    <div
      className="companion-root"
      data-mode={mode}
      data-hovered={hovered || undefined}
      data-expanded={expanded || undefined}
      data-dragging={dragging || undefined}
      data-edge-h={edgeH}
      data-edge-v={edgeV}
      style={rootStyle}
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
            voiceActive={voiceActive}
            showVoice={showVoice}
            onSend={sendCurrent}
            onStop={() => api?.stop()}
            onToggleVoice={toggleVoice}
            onEscape={collapse}
          />
        ) : null}
      </div>

      <div
        className="companion-hull"
        data-active={arcVisible || undefined}
        onMouseEnter={onHullEnter}
        onMouseLeave={onHullLeave}
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
          className="companion-mark"
          aria-label={t(
            expanded ? "companion.mark.close" : "companion.mark.open",
          )}
          aria-expanded={expanded}
          onPointerDown={onMarkPointerDown}
          onPointerMove={onMarkPointerMove}
          onPointerUp={(event) => endPress(event, false)}
          onPointerCancel={(event) => endPress(event, true)}
          onContextMenu={(event) => {
            event.preventDefault();
            api?.showContextMenu();
          }}
        >
          <StellaCharacter
            size={COMPANION_MARK_SIZE}
            state={markState}
            shape="star"
            ink="aurora"
            glow
            eyeColor="var(--card)"
            followPointer={hovered || expanded}
            paused={!documentVisible}
            handleRef={markHandleRef}
          />
          {runningCount > 0 ? (
            <span
              className="companion-badge"
              title={t("companion.badge.running", { count: runningCount })}
              aria-label={t("companion.badge.running", { count: runningCount })}
            >
              {runningCount > 99 ? "99+" : runningCount}
            </span>
          ) : null}
        </button>
      </div>
    </div>
  );
}
