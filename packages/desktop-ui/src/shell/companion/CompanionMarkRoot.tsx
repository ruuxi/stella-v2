/**
 * CompanionMarkRoot — the small always-on-top window holding the mark.
 *
 * This window is the companion's only permanent hit target: hovering it
 * summons the panel behind it (arc, composer, bubbles), clicking toggles the
 * composer, dragging moves the whole companion, right-click opens the menu.
 * It never resizes and never takes keyboard focus; everything it learns
 * about the panel (expanded, recording) arrives from main as activity.
 */
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { COMPANION_MARK_SIZE } from "@stella/contracts/desktop/companion";
import { useUiState } from "@/context/ui-state";
import { useT } from "@/shared/i18n";
import {
  StellaCharacter,
  type StellaCharacterState,
} from "@/ui/stella-character/StellaCharacter";
import type { StellaMarkHandle } from "@/ui/stella-character/rig";
import {
  useCompanionState,
  useVoiceSpeakingState,
} from "./use-companion-state";
import { useCompanionWindow, useDocumentVisible } from "./use-companion-window";
import "./companion.css";

/** Pointer travel before a press becomes a drag instead of a click. */
const DRAG_THRESHOLD_PX = 5;

export function CompanionMarkRoot() {
  const t = useT();
  const api = window.electronAPI?.companion;
  const state = useCompanionState();
  const { activity } = useCompanionWindow();
  const { state: uiState } = useUiState();
  const voiceActive = Boolean(uiState.isVoiceRtcActive);
  const voice = useVoiceSpeakingState(voiceActive);
  const documentVisible = useDocumentVisible();
  const [dragging, setDragging] = useState(false);
  const markHandleRef = useRef<StellaMarkHandle | null>(null);

  // ── Click / drag ─────────────────────────────────────────────────────
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

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
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

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const press = pressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    press.lastX = event.screenX;
    press.lastY = event.screenY;
    if (!press.moved) {
      const dx = press.lastX - press.startX;
      const dy = press.lastY - press.startY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      press.moved = true;
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
    api?.toggleExpanded();
  };

  // ── Mood ─────────────────────────────────────────────────────────────
  const markState = useMemo<StellaCharacterState>(() => {
    if (dragging) return "happy";
    if (activity.recording) return "listening";
    if (activity.transcribing) return "thinking";
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
    activity.recording,
    activity.transcribing,
    voiceActive,
    voice.isSpeaking,
    voice.isUserSpeaking,
    state.readAloudPlaying,
    state.isStreaming,
    state.workState,
  ]);

  const runningCount = state.runningAgentCount;
  const expanded = activity.expanded;

  return (
    <div
      className="companion-mark-root"
      data-hovered={activity.hovered || undefined}
      data-expanded={expanded || undefined}
      data-dragging={dragging || undefined}
      onMouseEnter={() => api?.setHovered(true)}
      onMouseLeave={() => api?.setHovered(false)}
    >
      <button
        type="button"
        className="companion-mark"
        aria-label={t(
          expanded ? "companion.mark.close" : "companion.mark.open",
        )}
        aria-expanded={expanded}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
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
          followPointer={activity.hovered || expanded}
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
  );
}
