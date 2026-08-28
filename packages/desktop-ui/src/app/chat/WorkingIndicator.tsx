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

const INDICATOR_EYE_COLOR = "var(--surface-base)";

interface WorkingIndicatorProps {
  status?: string;
  toolName?: string;

  toolCallId?: string;
  isReasoning?: boolean;

  reasoningSeed?: string;
  className?: string;

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
  const dotsOnly = characterState === "thinking";

  return (
    <div
      className={cn("working-indicator", className)}
      data-mode={dotsOnly ? "thinking" : "tool"}
    >
      <div className="indicator-stella">
        {

}
        <StellaCharacter
          size={INDICATOR_MARK_SIZE_PX}
          state={characterState}
          eyeColor={INDICATOR_EYE_COLOR}
          paused={animationPaused}
        />
      </div>
      {dotsOnly ? null : (
        <SwapText
          text={displayStatus}
          active={animationActive}
          animateInitial={false}
          minimumVisibleMs={minimumVisibleMs}
          className="working-status"
          shimmerGroup={CHAT_ACTIVITY_SHIMMER_GROUP}
          shimmerPriority={100}
        />
      )}
    </div>
  );
}
