/**
 * The sidebar image viewer's zoom surface.
 *
 * Click zooms in at the pointer (to the image's full resolution, at least 2x)
 * and click again zooms back out. While zoomed, dragging pans, the wheel pans,
 * and a trackpad pinch (ctrl+wheel) zooms around the pointer. At fit size a
 * horizontal drag past a threshold hands off to `onSwipe` instead of zooming,
 * so the viewer can step to the neighbouring file.
 *
 * Every pointer and wheel move writes the transform straight onto the image
 * element: a per-move React render would cost frames while a turn streams.
 */

import { useCallback, useEffect, useRef } from "react";

const MAX_SCALE = 8;
const MIN_CLICK_SCALE = 2;
/** Pointer travel under this is a click, not a drag. */
const CLICK_SLOP_PX = 4;
/** Horizontal drag at fit size that counts as a swipe to the next file. */
const SWIPE_DISTANCE_PX = 60;

type Transform = { scale: number; x: number; y: number };

const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };

export type SwipeDirection = "previous" | "next";

export const ZoomableImage = ({
  src,
  alt,
  ariaLabel,
  onSwipe,
}: {
  src: string;
  alt: string;
  ariaLabel: string;
  onSwipe?: (direction: SwipeDirection) => void;
}) => {
  const frameRef = useRef<HTMLButtonElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const transformRef = useRef<Transform>(IDENTITY);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  // A drag that ended as a pan or a swipe still fires `click`; this swallows it.
  const suppressClickRef = useRef(false);
  const onSwipeRef = useRef(onSwipe);
  onSwipeRef.current = onSwipe;

  const clamp = useCallback((next: Transform): Transform => {
    const frame = frameRef.current;
    const img = imgRef.current;
    if (!frame || !img || next.scale <= 1) return IDENTITY;
    const maxX = Math.max(0, (img.offsetWidth * next.scale - frame.clientWidth) / 2);
    const maxY = Math.max(0, (img.offsetHeight * next.scale - frame.clientHeight) / 2);
    return {
      scale: next.scale,
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    };
  }, []);

  const apply = useCallback(
    (next: Transform, animate: boolean) => {
      const clamped = clamp(next);
      transformRef.current = clamped;
      const img = imgRef.current;
      const frame = frameRef.current;
      if (!img || !frame) return;
      img.classList.toggle("display-media__zoom-img--animate", animate);
      img.style.transform =
        clamped.scale === 1
          ? ""
          : `translate3d(${clamped.x}px, ${clamped.y}px, 0) scale(${clamped.scale})`;
      frame.dataset.zoomed = clamped.scale > 1 ? "true" : "false";
    },
    [clamp],
  );

  /** Zoom to `scale` keeping the point under (clientX, clientY) still. */
  const zoomAt = useCallback(
    (scale: number, clientX: number, clientY: number, animate: boolean) => {
      const frame = frameRef.current;
      if (!frame) return;
      const rect = frame.getBoundingClientRect();
      const px = clientX - (rect.left + rect.width / 2);
      const py = clientY - (rect.top + rect.height / 2);
      const current = transformRef.current;
      const ratio = scale / current.scale;
      apply(
        {
          scale,
          x: px - (px - current.x) * ratio,
          y: py - (py - current.y) * ratio,
        },
        animate,
      );
    },
    [apply],
  );

  // A new image starts at fit size.
  useEffect(() => {
    apply(IDENTITY, false);
  }, [apply, src]);

  // Native, non-passive wheel listener: React's is passive, and a zoomed
  // image has to claim the wheel (pan / pinch) before the viewer reads it as
  // a swipe or Chromium reads ctrl+wheel as page zoom.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const onWheel = (event: WheelEvent) => {
      const current = transformRef.current;
      if (event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        const scale = Math.min(
          MAX_SCALE,
          Math.max(1, current.scale * Math.exp(-event.deltaY * 0.01)),
        );
        zoomAt(scale, event.clientX, event.clientY, false);
        return;
      }
      if (current.scale <= 1) return;
      event.preventDefault();
      event.stopPropagation();
      apply(
        { ...current, x: current.x - event.deltaX, y: current.y - event.deltaY },
        false,
      );
    };
    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => frame.removeEventListener("wheel", onWheel);
  }, [apply, zoomAt]);

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    suppressClickRef.current = false;
    const current = transformRef.current;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: current.x,
      originY: current.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < CLICK_SLOP_PX) return;
    if (!drag.moved) {
      drag.moved = true;
      event.currentTarget.dataset.dragging = "true";
    }
    const current = transformRef.current;
    if (current.scale > 1) {
      apply(
        { scale: current.scale, x: drag.originX + dx, y: drag.originY + dy },
        false,
      );
    }
  };

  const endDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    delete event.currentTarget.dataset.dragging;
    if (!drag.moved) return;
    suppressClickRef.current = true;
    if (transformRef.current.scale > 1) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) >= SWIPE_DISTANCE_PX && Math.abs(dx) > Math.abs(dy)) {
      onSwipeRef.current?.(dx < 0 ? "next" : "previous");
    }
  };

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (transformRef.current.scale > 1) {
      apply(IDENTITY, true);
      return;
    }
    const img = imgRef.current;
    const frame = frameRef.current;
    if (!img || !frame) return;
    // Full resolution when the fitted image is shrunk, never less than 2x.
    const natural = img.offsetWidth > 0 ? img.naturalWidth / img.offsetWidth : 1;
    const scale = Math.min(MAX_SCALE, Math.max(MIN_CLICK_SCALE, natural));
    // Keyboard activation has no pointer position: zoom on the centre.
    const fromPointer = event.detail > 0;
    const rect = frame.getBoundingClientRect();
    zoomAt(
      scale,
      fromPointer ? event.clientX : rect.left + rect.width / 2,
      fromPointer ? event.clientY : rect.top + rect.height / 2,
      true,
    );
  };

  return (
    <button
      ref={frameRef}
      type="button"
      className="display-media__primary-btn display-media__zoom-frame"
      data-zoomed="false"
      aria-label={ariaLabel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={handleClick}
      onKeyDown={(event) => {
        if (event.key === "Escape" && transformRef.current.scale > 1) {
          event.stopPropagation();
          apply(IDENTITY, true);
        }
      }}
    >
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        draggable={false}
        className="display-media__primary-img display-media__zoom-img"
      />
    </button>
  );
};
