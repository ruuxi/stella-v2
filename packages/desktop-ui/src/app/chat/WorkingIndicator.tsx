import { useWindowFocus } from "@/shared/hooks/use-window-focus";
import { cn } from "@/shared/lib/utils";
import { StellaCharacter } from "@/ui/stella-character/StellaCharacter";
import { SwapText } from "./SwapText";
import { CHAT_ACTIVITY_SHIMMER_GROUP } from "./TextShimmer";
import {
  getWorkingIndicatorCharacterState,
  getWorkingIndicatorDisplayStatus,
  INLINE_WORKING_INDICATOR_MIN_VISIBLE_MS,
} from "@/features/chat/working-indicator-state";
import "./indicators.css";

/**
 * Rendered footprint of the character mark. Matches `.indicator-stella`
 * in `indicators.css`; the rig draws its SVG at exactly this size (no
 * transform scaling), so the two must stay in sync.
 */
const INDICATOR_MARK_SIZE_PX = 30;

/**
 * The eye cutouts are punched in the surface color behind the mark. The
 * inline indicator's own pill is transparent (see
 * `.inline-working-indicator__indicator`), so what sits behind it is the
 * transcript background.
 */
const INDICATOR_EYE_COLOR = "var(--surface-base)";

interface WorkingIndicatorProps {
  status?: string;
  toolName?: string;
  /** Stable id of the in-flight tool call. Used as a seed for the
   * friendly variation picker so the label doesn't flicker on each
   * re-render. */
  toolCallId?: string;
  isReasoning?: boolean;
  /** Seed for the reasoning/idle label. */
  reasoningSeed?: string;
  className?: string;
  /** Stops persistent motion while the shell finishes its finite exit. */
  animationActive?: boolean;
  minimumVisibleMs?: number;
}

export function WorkingIndicator({
  status,
  toolName,
  toolCallId,
  isReasoning,
  reasoningSeed,
  className,
  animationActive = true,
  minimumVisibleMs = INLINE_WORKING_INDICATOR_MIN_VISIBLE_MS,
}: WorkingIndicatorProps) {
  const windowFocused = useWindowFocus();
  const animationPaused = !animationActive || !windowFocused;

  const displayStatus = getWorkingIndicatorDisplayStatus({
    status,
    toolName,
    toolCallId,
    isReasoning,
    reasoningSeed,
  });
  const characterState = getWorkingIndicatorCharacterState({
    toolName,
    isReasoning,
  });
  return (
    <div className={cn("working-indicator", className)}>
      <div className="indicator-stella">
        {/* The SVG character rig replaces the old WebGL aurora canvas: it
            animates by writing attributes from one rAF loop, costs no GL
            context, and can express what Stella is actually doing (the
            three-dot "thinking" morph, orbit for search/read, twinkle for
            write/work). It honors `prefers-reduced-motion` internally. */}
        <StellaCharacter
          size={INDICATOR_MARK_SIZE_PX}
          state={characterState}
          eyeColor={INDICATOR_EYE_COLOR}
          paused={animationPaused}
        />
      </div>
      <SwapText
        text={displayStatus}
        active={animationActive}
        animateInitial={false}
        minimumVisibleMs={minimumVisibleMs}
        className="working-status"
        shimmerGroup={CHAT_ACTIVITY_SHIMMER_GROUP}
        shimmerPriority={100}
      />
    </div>
  );
}
