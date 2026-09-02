import type { CSSProperties } from "react";
import { useWindowFocus } from "@/shared/hooks/use-window-focus";
import { cn } from "@/shared/lib/utils";
import { StellaCharacter, type StellaCharacterState } from "./StellaCharacter";

/** Large enough to read as a hero, small enough to sit above a headline. */
const DEFAULT_HERO_SIZE_PX = 96;

/** Punches the eyes out to the surface the hero sits on, so they read as
 *  holes in the mark rather than paint. Override per surface via the token. */
const DEFAULT_EYE_COLOR = "var(--stella-empty-state-eye, var(--card))";

export interface StellaEmptyStateProps {
  /** What the character is doing while the surface is empty. */
  mood?: StellaCharacterState;
  /** Rendered edge length of the mark in px. */
  size?: number;
  /** Let the mark's gaze track the pointer so the empty surface feels awake. */
  followPointer?: boolean;
  glow?: boolean;
  eyeColor?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * The character as an empty-state hero.
 *
 * One mark, one mood: every empty surface (connect, pairing, and anything
 * that used to carry a bespoke illustration) mounts this and picks the pose
 * that fits its copy, so "empty" always looks like Stella waiting rather than
 * a different drawing per screen.
 *
 * The rig already sleeps when scrolled out of view and honours reduced
 * motion; this adds the window-blur pause the working indicator uses, so a
 * decorative hero never ticks in a backgrounded window.
 */
export function StellaEmptyState({
  mood = "idle",
  size = DEFAULT_HERO_SIZE_PX,
  followPointer = true,
  glow = true,
  eyeColor = DEFAULT_EYE_COLOR,
  className,
  style,
}: StellaEmptyStateProps) {
  const windowFocused = useWindowFocus();

  return (
    <div
      className={cn("stella-empty-state", className)}
      data-mood={mood}
      style={style}
      aria-hidden="true"
    >
      <StellaCharacter
        className="stella-empty-state__mark"
        size={size}
        state={mood}
        shape="star"
        ink="aurora"
        glow={glow}
        eyeColor={eyeColor}
        followPointer={followPointer}
        paused={!windowFocused}
      />
    </div>
  );
}
