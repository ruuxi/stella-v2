import { useWindowFocus } from "@/shared/hooks/use-window-focus";
import { cn } from "@/shared/lib/utils";
import { StellaAnimation } from "@/shell/aurora/StellaAnimation";
import { SwapText } from "./SwapText";
import { CHAT_ACTIVITY_SHIMMER_GROUP } from "./TextShimmer";
import {
  getWorkingIndicatorDisplayStatus,
  INLINE_WORKING_INDICATOR_MIN_VISIBLE_MS,
} from "@/features/chat/working-indicator-state";
import "./indicators.css";

interface WorkingIndicatorProps {
  status?: string;
  toolName?: string;
  /** Stable id of the in-flight tool call. Used as a seed for the
   * friendly variation picker so the label doesn't flicker on each
   * re-render. */
  toolCallId?: string;
  isReasoning?: boolean;
  /** Per-turn seed so the reasoning/idle label varies across turns
   * instead of always landing on the first variation ("Thinking"). */
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
  return (
    <div className={cn("working-indicator", className)}>
      <div className="indicator-stella">
        <div className="indicator-stella-scale">
          {/* 10×7.15 cells × the 5×7px cell metric → a square 125×125
              canvas, which .indicator-stella-scale shrinks to exactly the
              30px slot. The canvas must never overflow the slot: ancestor
              containers in the chat layout clip overflow with hard edges.
              Keep these dims in sync with `prewarmAurora` in ChatColumn —
              they form the pooled renderer's key, and a mismatch means the
              prewarmed context goes unused.

              125 and not the old 250: the slot is 30 css px, so even a 2x
              display only shows 60 device px and a 3x display 90. Rendering
              250 shaded 4x the pixels that survive, and measured *further*
              from ground truth than 125 — a 250→60 downscale is past what
              the compositor's bilinear tap can resolve, so it aliases.
              125 still exceeds the device pixels everywhere, so it never
              upscales. */}
          <StellaAnimation
            width={10}
            height={7.15}
            maxDpr={1}
            /* 15fps left the churn reading as discrete steps at this size.
               The orb's move to three noise octaves (see `fbmCoarse`) pays
               for most of the extra frames. */
            maxFps={24}
            timeScale={2.2}
            paused={animationPaused}
            requireWindowFocus
          />
        </div>
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
