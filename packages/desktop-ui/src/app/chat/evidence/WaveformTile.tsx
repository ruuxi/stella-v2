import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play } from "@/ui/icons";
import { localMediaUrl } from "@/shared/hooks/local-media-url";
import { useLocalMediaFailure } from "@/shared/hooks/use-local-media-failure";

const CANVAS_HEIGHT = 44;
const BAR_GAP = 1;

export const WaveformTile = ({
  peaks,
  filePath,
  durationLabel,
}: {
  peaks: number[];
  filePath: string;
  durationLabel?: string;
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const [armed, setArmed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const { failure, onError } = useLocalMediaFailure(filePath, "audio file");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || peaks.length === 0) return;
    const width = canvas.clientWidth;
    if (width <= 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(CANVAS_HEIGHT * ratio);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);
    context.fillStyle = getComputedStyle(canvas).color;
    const step = width / peaks.length;
    const barWidth = Math.max(1, step - BAR_GAP);
    for (let index = 0; index < peaks.length; index += 1) {
      const amplitude = Math.max(0.04, peaks[index] ?? 0);
      const barHeight = amplitude * CANVAS_HEIGHT;
      context.fillRect(
        index * step,
        (CANVAS_HEIGHT - barHeight) / 2,
        barWidth,
        barHeight,
      );
    }
  }, [peaks]);

  const stopTicking = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const tick = useCallback(() => {
    const audio = audioRef.current;
    const cursor = cursorRef.current;
    if (!audio || !cursor) return;
    const progress =
      audio.duration > 0 ? Math.min(1, audio.currentTime / audio.duration) : 0;
    cursor.style.transform = `translate3d(${(progress * 100).toFixed(3)}%, 0, 0)`;
    frameRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => stopTicking, [stopTicking]);

  useEffect(() => {
    if (!armed) return;
    const audio = audioRef.current;
    if (audio) void audio.play().catch(() => setPlaying(false));
  }, [armed]);

  return (
    <div className="media-tile__wave">
      <button
        type="button"
        className="media-tile__wave-toggle"
        aria-label={playing ? "Pause" : "Play"}
        onClick={() => {
          const audio = audioRef.current;
          if (!armed) {
            setArmed(true);
            return;
          }
          if (!audio) return;
          if (audio.paused) void audio.play().catch(() => undefined);
          else audio.pause();
        }}
      >
        {playing ? <Pause size={12} /> : <Play size={12} />}
      </button>
      <div className="media-tile__wave-plot">
        <canvas ref={canvasRef} className="media-tile__wave-canvas" />
        <div ref={cursorRef} className="media-tile__wave-cursor" aria-hidden="true" />
      </div>
      {failure ? (
        <span className="media-tile__wave-time" role="status" title={failure}>
          Unavailable
        </span>
      ) : durationLabel ? (
        <span className="media-tile__wave-time">{durationLabel}</span>
      ) : null}
      {armed ? (
        <audio
          ref={audioRef}
          src={localMediaUrl(filePath)}
          preload="auto"
          onError={() => {
            setPlaying(false);
            stopTicking();
            onError();
          }}
          onPlay={() => {
            setPlaying(true);
            stopTicking();
            frameRef.current = requestAnimationFrame(tick);
          }}
          onPause={() => {
            setPlaying(false);
            stopTicking();
          }}
          onEnded={() => {
            setPlaying(false);
            stopTicking();
            if (cursorRef.current) {
              cursorRef.current.style.transform = "translate3d(0, 0, 0)";
            }
          }}
        />
      ) : null}
    </div>
  );
};
