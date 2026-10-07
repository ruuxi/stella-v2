/**
 * Inline summary pill for a realtime voice session. Replaces the raw
 * "Voice session — Duration: …" text body on the visible assistant message
 * that the voice session manager writes when it deactivates (see
 * `endVisibleVoiceSession` in `use-realtime-voice.ts`).
 *
 * It also carries the failure reason. A call that never connected still
 * writes this pill, which used to leave a bare "Voice session 0s" with no
 * hint of why nothing happened. The reason comes from the voice runtime in
 * the overlay window via `voice-session-error-state.ts`, and the backend's own
 * wording is shown as-is: "Realtime voice is part of Stella Pro.", a
 * usage-limit message, or "Voice sessions are not configured yet."
 */
import { useSyncExternalStore } from "react";
import { AudioLines, AlertCircle } from "@/ui/icons";
import { voiceSessionErrorStore } from "@/features/voice/runtime/voice-session-error-state";
import { useT } from "@/shared/i18n";
import "./voice-session-card.css";

const formatDuration = (durationMs: number): string => {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  return `${seconds}s`;
};

export function VoiceSessionCard({ durationMs }: { durationMs: number }) {
  const t = useT();
  const sessionError = useSyncExternalStore(
    voiceSessionErrorStore.subscribe,
    voiceSessionErrorStore.getSnapshot,
    voiceSessionErrorStore.getServerSnapshot,
  );

  if (sessionError) {
    return (
      <span className="voice-session-pill voice-session-pill--error">
        <AlertCircle
          className="voice-session-pill__icon"
          size={13}
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <span className="voice-session-pill__label">
          {t("app.chat.voiceSession.label")}
        </span>
        <span className="voice-session-pill__reason">{sessionError}</span>
      </span>
    );
  }

  return (
    <span className="voice-session-pill">
      <AudioLines
        className="voice-session-pill__icon"
        size={13}
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <span className="voice-session-pill__label">
        {t("app.chat.voiceSession.label")}
      </span>
      <span className="voice-session-pill__meta">
        {formatDuration(durationMs)}
      </span>
    </span>
  );
}
