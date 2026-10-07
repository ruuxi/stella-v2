import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play } from "@/ui/icons";
import { useMediaObjectUrl } from "@/features/chat/hooks/use-media-object-url";

const CANVAS_HEIGHT = 36;
const BAR_GAP = 1;

export const WaveformCard = ({
  peaks,
  filePath,
  mimeType,
  durationLabel,
}: {
  peaks: number[];
  filePath: string;
  mimeType?: string;
  durationLabel?: string;
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const [armed, setArmed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const objectUrl = useMediaObjectUrl(filePath, mimeType, armed);

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
    const style = getComputedStyle(canvas);
    context.fillStyle = style.color;
    const barWidth = Math.max(1, width / peaks.length - BAR_GAP);
    const step = width / peaks.length;
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
    const audio = audioRef.current;
    if (!audio || !objectUrl || !armed) return;
    void audio.play().catch(() => setPlaying(false));
  }, [objectUrl, armed]);

  return (
    <div className="evidence-wave">
      <button
        type="button"
        className="evidence-wave__toggle"
        aria-label={playing ? "Pause" : "Play"}
        onClick={(event) => {
          event.stopPropagation();
          const audio = audioRef.current;
          if (!armed) {
            setArmed(true);
            setPlaying(true);
            return;
          }
          if (!audio) return;
          if (audio.paused) {
            void audio.play().catch(() => undefined);
          } else {
            audio.pause();
          }
        }}
      >
        {playing ? <Pause size={13} /> : <Play size={13} />}
      </button>
      <div className="evidence-wave__plot">
        <canvas ref={canvasRef} className="evidence-wave__canvas" />
        <div ref={cursorRef} className="evidence-wave__cursor" aria-hidden="true" />
      </div>
      {durationLabel ? (
        <span className="evidence-wave__duration">{durationLabel}</span>
      ) : null}
      {armed && objectUrl ? (
        <audio
          ref={audioRef}
          src={objectUrl}
          preload="auto"
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
