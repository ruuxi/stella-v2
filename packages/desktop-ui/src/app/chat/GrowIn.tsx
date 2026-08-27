import { useRef, useEffect, useState, type ReactNode } from "react";
import { animate } from "motion";
import "./grow-in.css";

interface GrowInProps {
  children: ReactNode;

  animate?: boolean;

  show?: boolean;

  duration?: number;
  className?: string;
}

export function GrowIn({
  children,
  animate: shouldAnimate = true,
  show = true,
  duration = 500,
  className,
}: GrowInProps) {
  const canAnimate = shouldAnimate && typeof ResizeObserver !== "undefined";
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [settled, setSettled] = useState(!canAnimate);
  const [exited, setExited] = useState(!show);
  const controlsRef = useRef<ReturnType<typeof animate> | null>(null);
  const cachedChildrenRef = useRef<ReactNode>(children);
  const showRef = useRef(show);
  const entranceDoneRef = useRef(!canAnimate);

  if (show) {
    cachedChildrenRef.current = children;
  }

  useEffect(() => {
    const prevShow = showRef.current;
    showRef.current = show;

    if (!canAnimate) {
      setExited(!show);
      return;
    }

    const outer = outerRef.current;
    if (!outer) return;

    if (prevShow && !show) {

      controlsRef.current?.stop();
      setSettled(false);
      entranceDoneRef.current = false;
      outer.style.height = `${outer.getBoundingClientRect().height}px`;
      controlsRef.current = animate(
        outer,
        { height: "0px", opacity: 0 },
        {
          type: "spring",
          duration: duration / 1000,
          bounce: 0,
          onComplete: () => setExited(true),
        },
      );
    } else if (!prevShow && show) {

      setExited(false);
      setSettled(false);
      entranceDoneRef.current = false;
      outer.style.height = "0px";
      outer.style.opacity = "1";
    }
  }, [show, canAnimate, duration]);

  useEffect(() => {
    if (!canAnimate || !show) {
      entranceDoneRef.current = false;
      return;
    }
    const timer = setTimeout(() => {
      entranceDoneRef.current = true;
      const outer = outerRef.current;
      if (outer) {
        controlsRef.current?.stop();
        outer.style.height = "auto";
      }
      setSettled(true);
    }, duration);
    return () => clearTimeout(timer);
  }, [canAnimate, show, duration]);

  useEffect(() => {
    const inner = innerRef.current;
    const outer = outerRef.current;
    if (!inner || !outer || !canAnimate || !show) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;

      if (entranceDoneRef.current) {
        controlsRef.current?.stop();
        outer.style.height = "auto";
        return;
      }

      controlsRef.current?.stop();
      controlsRef.current = animate(
        outer,
        { height: `${h}px` },
        {
          type: "spring",
          duration: duration / 1000,
          bounce: 0,
          onComplete: () => {
            entranceDoneRef.current = true;
            outer.style.height = "auto";
            setSettled(true);
          },
        },
      );
    });

    observer.observe(inner);
    return () => {
      observer.disconnect();
      controlsRef.current?.stop();
    };
  }, [canAnimate, duration, show]);

  if (!canAnimate) {
    if (!show) return null;
    return <div className={className}>{children}</div>;
  }

  if (exited && !show) return null;

  const displayChildren = show ? children : cachedChildrenRef.current;

  return (
    <div
      ref={outerRef}
      className={`grow-in${className ? ` ${className}` : ""}`}
      style={{ height: "0px", overflow: settled ? undefined : "clip" }}
    >
      <div
        ref={innerRef}
        className={`grow-in-inner${!show ? " grow-in-exiting" : ""}`}
      >
        {displayChildren}
      </div>
    </div>
  );
}
