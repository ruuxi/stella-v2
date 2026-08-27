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
  return (
    <div className={cn("working-indicator", className)}>
      <div className="indicator-stella">
        <div className="indicator-stella-scale">
          {/* 10×7.15 cells × the 5×7px cell metric → a square 125×125
              backing buffer displayed in a native 30×30 CSS footprint.
              Keeping the display size on the canvas itself avoids putting an
              oversized, transformed WebGL layer into the Windows compositor.
              The canvas must never overflow the slot: ancestor containers in
              the chat layout clip overflow with hard edges.
              Keep these dims — and the variant — in sync with `prewarmAurora`
              in ChatColumn: they form the pooled renderer's key, and a
              mismatch means the prewarmed context goes unused.

              125 and not the old 250: the slot is 30 css px, so even a 2x
              display only shows 60 device px and a 3x display 90. Rendering
              250 shaded 4x the pixels that survive, and measured *further*
              from ground truth than 125 — a 250→60 downscale is past what
              the compositor's bilinear tap can resolve, so it aliases.
              125 still exceeds the device pixels everywhere, so it never
              upscales. */}
          <StellaAnimation
            variant="star-spin"
            width={10}
            height={7.15}
            displayWidth={30}
            displayHeight={30}
            maxDpr={1}
            /* 30fps at an unscaled clock, and both halves of that are load
               bearing. The star's motion blur smears each arm across
               1/30s worth of shader time, so this is the pairing at which
               the smear covers exactly the ground the arms cover between
               frames; scaling the clock or dropping the rate leaves the
               whip's fastest pass under-smeared, which at this size shows up
               as strobing rather than as blur. The turn is staged in the
               shader (see starTurn), so the cadence does not come from here. */
            maxFps={30}
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
