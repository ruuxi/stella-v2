import { useEffect, useLayoutEffect, useRef } from "react";
import {
  createStellaMark,
  type CreateStellaMarkOptions,
  type StellaCharacterShape,
  type StellaCharacterState,
  type StellaMarkHandle,
} from "./rig";

export type { StellaCharacterShape, StellaCharacterState };

export interface StellaCharacterProps {
  /** Rendered square size in px. */
  size: number;
  state?: StellaCharacterState;
  shape?: StellaCharacterShape;
  /** Ink ramp: "aurora" (the shipping WorkingStar ramp) or "vivid" (logo ramp). */
  ink?: "aurora" | "vivid";
  /**
   * Eye cutout colour. Defaults to `var(--stella-mark-bg)` with a dark
   * fallback inside the rig; set it to the surface the mark sits on.
   */
  eyeColor?: string;
  glow?: boolean;
  paused?: boolean;
  className?: string;
  style?: React.CSSProperties;
  /** Imperative access (sparkle bursts, gaze) without re-rendering. */
  handleRef?: React.RefObject<StellaMarkHandle | null>;
}

/**
 * React binding for the vanilla-JS character rig in `rig.js`.
 *
 * The rig renders its SVG once and animates by writing attributes from a
 * single rAF loop, so this wrapper deliberately keeps React out of the frame
 * path: mount creates the rig, prop changes call the imperative setters, and
 * unmount destroys it. Only `size`/`ink`/`glow` changes force a rebuild.
 */
export function StellaCharacter({
  size,
  state = "idle",
  shape = "star",
  ink = "aurora",
  eyeColor,
  glow = false,
  paused = false,
  className,
  style,
  handleRef,
}: StellaCharacterProps) {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const markRef = useRef<StellaMarkHandle | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const opts: CreateStellaMarkOptions = {
      size,
      state,
      shape,
      ink,
      glow,
      paused,
    };
    if (eyeColor) opts.eyeColor = eyeColor;
    const mark = createStellaMark(host, opts);
    markRef.current = mark;
    if (handleRef) handleRef.current = mark;
    return () => {
      markRef.current = null;
      if (handleRef) handleRef.current = null;
      mark.destroy();
    };
    // Structural options require a rebuild; state/shape/paused go through
    // the imperative setters below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, ink, glow, eyeColor]);

  useEffect(() => {
    markRef.current?.setState(state);
  }, [state]);

  useEffect(() => {
    markRef.current?.setShape(shape);
  }, [shape]);

  useEffect(() => {
    if (paused) markRef.current?.pause();
    else markRef.current?.resume();
  }, [paused]);

  return (
    <span
      ref={hostRef}
      className={className}
      aria-hidden
      style={{
        display: "inline-block",
        width: size,
        height: size,
        flex: "0 0 auto",
        ...style,
      }}
    />
  );
}
