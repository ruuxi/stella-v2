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

  size: number | null;
  state?: StellaCharacterState;
  shape?: StellaCharacterShape;

  ink?: "aurora" | "vivid";

  eyeColor?: string;
  glow?: boolean;
  paused?: boolean;
  followPointer?: boolean;
  className?: string;
  style?: React.CSSProperties;

  handleRef?: React.RefObject<StellaMarkHandle | null>;
}

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
