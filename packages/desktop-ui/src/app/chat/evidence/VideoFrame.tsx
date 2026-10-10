import { useCallback, useRef, useState } from "react";
import { Play } from "@/ui/icons";
import { localMediaUrl } from "@/shared/hooks/local-media-url";
import { useLocalMediaFailure } from "@/shared/hooks/use-local-media-failure";

export const VideoFrame = ({
  poster,
  filePath,
  durationMs,
  title,
}: {
  poster?: string;
  filePath: string;
  mimeType?: string;
  durationMs?: number;
  title: string;
}) => {
  const [engaged, setEngaged] = useState(false);
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const boundsRef = useRef<{ left: number; width: number } | null>(null);
  const streamUrl = localMediaUrl(filePath);
  const { failure, onError } = useLocalMediaFailure(filePath, "video");

  const scrub = useCallback(
    (clientX: number) => {
      const video = videoRef.current;
      const bounds = boundsRef.current;
      if (!video || !bounds || bounds.width <= 0 || playing) return;
      const duration = Number.isFinite(video.duration)
        ? video.duration
        : (durationMs ?? 0) / 1000;
      if (duration <= 0) return;
      const ratio = Math.min(
        1,
        Math.max(0, (clientX - bounds.left) / bounds.width),
      );
      video.currentTime = ratio * duration;
    },
    [durationMs, playing],
  );

  return (
    <div
      className="evidence-video"
      data-engaged={engaged ? "true" : undefined}
      onPointerEnter={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        boundsRef.current = { left: rect.left, width: rect.width };
        setEngaged(true);
      }}
      onPointerLeave={() => {
        if (playing) return;
        setEngaged(false);
      }}
      onPointerMove={(event) => scrub(event.clientX)}
      onClick={(event) => {
        event.stopPropagation();
        const video = videoRef.current;
        if (!video) {
          setEngaged(true);
          return;
        }
        if (video.paused) {
          video.muted = false;
          void video.play().catch(() => undefined);
        } else {
          video.pause();
        }
      }}
    >
      {poster ? (
        <img className="evidence-video__poster" src={poster} alt={title} draggable={false} />
      ) : (
        <div className="evidence-video__poster evidence-video__poster--blank" />
      )}
      {engaged ? (
        <video
          ref={videoRef}
          className="evidence-video__player"
          src={streamUrl}
          muted
          playsInline
          preload="auto"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onError={onError}
        />
      ) : null}
      {failure ? (
        <span className="evidence-video__unavailable" role="status">
          {failure}
        </span>
      ) : null}
      {!playing && !failure ? (
        <span className="evidence-video__badge" aria-hidden="true">
          <Play size={11} />
        </span>
      ) : null}
    </div>
  );
};
