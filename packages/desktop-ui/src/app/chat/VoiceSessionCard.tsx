import { AudioLines } from "@/ui/icons";
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
