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
  /** Rendered edge length in px. `null` lets the mark fill its container. */
  size: number | null;
  state?: StellaCharacterState;
  shape?: StellaCharacterShape;
  /** `aurora` is the ambient gradient; `vivid` is the saturated brand fill. */
  ink?: "aurora" | "vivid";
  eyeColor?: string;
  glow?: boolean;
  paused?: boolean;
  followPointer?: boolean;
  className?: string;
  style?: React.CSSProperties;
  /** Escape hatch for imperative pokes like `sparkle()` and `setGaze()`. */
  handleRef?: React.RefObject<StellaMarkHandle | null>;
}

/**
 * React host for the imperative rig.
 *
 * The rig owns its own animation loop, so this component's job is only to
 * mount it once and forward prop changes onto the handle. Anything the rig can
 * ease between — state, shape, paused — is pushed through a setter rather than
 * remounting; only the props that change the mark's construction rebuild it.
 */
export function StellaCharacter({
  size,
  state = "idle",
  shape = "star",
  ink = "aurora",
  eyeColor,
  glow = false,
  paused = false,
  followPointer = false,
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
      followPointer,
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
    // `state`, `shape`, and `paused` seed the initial mark but must not
    // remount it — the effects below drive them through the handle so the rig
    // eases into the change instead of restarting mid-animation.
  }, [size, ink, glow, eyeColor, followPointer]);

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
        width: size ?? undefined,
        height: size ?? undefined,
        flex: "0 0 auto",
        ...style,
      }}
    />
  );
}
