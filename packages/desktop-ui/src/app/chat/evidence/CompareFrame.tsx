import { useCallback, useEffect, useRef } from "react";

export const CompareFrame = ({
  before,
  after,
  title,
}: {
  before: string;
  after: string;
  title: string;
}) => {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const boundsRef = useRef<{ left: number; width: number } | null>(null);

  const measure = useCallback(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    boundsRef.current = { left: rect.left, width: rect.width };
  }, []);

  const applySplit = useCallback((clientX: number) => {
    const frame = frameRef.current;
    const bounds = boundsRef.current;
    if (!frame || !bounds || bounds.width <= 0) return;
    const ratio = Math.min(
      1,
      Math.max(0, (clientX - bounds.left) / bounds.width),
    );
    frame.style.setProperty("--evidence-split", `${(ratio * 100).toFixed(2)}%`);
  }, []);

  useEffect(() => {
    measure();
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(frame);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div
      ref={frameRef}
      className="evidence-compare"
      role="group"
      aria-label={title}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        measure();
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.dragging = "true";
        applySplit(event.clientX);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.dataset.dragging !== "true") return;
        applySplit(event.clientX);
      }}
      onPointerUp={(event) => {
        delete event.currentTarget.dataset.dragging;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={(event) => {
        delete event.currentTarget.dataset.dragging;
      }}
    >
      <img className="evidence-compare__after" src={after} alt="" draggable={false} />
      <div className="evidence-compare__clip">
        <img
          className="evidence-compare__before"
          src={before}
          alt=""
          draggable={false}
        />
      </div>
      <div className="evidence-compare__handle" aria-hidden="true">
        <span className="evidence-compare__grip" />
      </div>
      <span className="evidence-compare__tag evidence-compare__tag--before">
        before
      </span>
      <span className="evidence-compare__tag evidence-compare__tag--after">after</span>
    </div>
  );
};
