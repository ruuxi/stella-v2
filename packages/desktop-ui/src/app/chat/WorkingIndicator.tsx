import { useMemo } from "react";
import { useMinimumVisibleValue } from "@/shared/hooks/use-minimum-visible-value";
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

const INDICATOR_MARK_SIZE_PX = 30;

/** Punches the eyes out of the mark so they read as holes, not paint. */
const INDICATOR_EYE_COLOR = "var(--surface-base)";

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

  // Pose and label are held as one tuple so they can never disagree: holding
  // them separately would let a stale label sit under the next activity's
  // pose for the remainder of its floor.
  const liveDisplay = useMemo(
    () => ({
      status: getWorkingIndicatorDisplayStatus({
        status,
        toolName,
        toolCallId,
        isReasoning,
        reasoningSeed,
      }),
      characterState: getWorkingIndicatorCharacterState({
        toolName,
        isReasoning,
      }),
    }),
    [status, toolName, toolCallId, isReasoning, reasoningSeed],
  );
  const held = useMinimumVisibleValue(
    liveDisplay,
    minimumVisibleMs,
    (a, b) => a.status === b.status && a.characterState === b.characterState,
  );
  // Thinking has nothing worth narrating, so it shows as the mark alone and
  // the row stays quiet until a tool gives it something to say.
  const dotsOnly = held.characterState === "thinking";

  return (
    <div
      className={cn("working-indicator", className)}
      data-mode={dotsOnly ? "thinking" : "tool"}
    >
      <div className="indicator-stella">
        <StellaCharacter
          size={INDICATOR_MARK_SIZE_PX}
          state={held.characterState}
          eyeColor={INDICATOR_EYE_COLOR}
          paused={animationPaused}
        />
      </div>
      {dotsOnly ? null : (
        <SwapText
          text={held.status}
          active={animationActive}
          animateInitial={false}
          className="working-status"
          shimmerGroup={CHAT_ACTIVITY_SHIMMER_GROUP}
          shimmerPriority={100}
        />
      )}
    </div>
  );
}
