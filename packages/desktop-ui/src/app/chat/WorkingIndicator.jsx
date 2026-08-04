import { useWindowFocus } from "@/shared/hooks/use-window-focus";
import { cn } from "@/shared/lib/utils";
import { StellaAnimation } from "@/shell/ascii-creature/StellaAnimation";
import { SwapText } from "./SwapText";
import { CHAT_ACTIVITY_SHIMMER_GROUP } from "./TextShimmer";
import { getWorkingIndicatorDisplayStatus } from "@/features/chat/working-indicator-state";
import "./indicators.css";
export function WorkingIndicator({ status, toolName, toolCallId, isReasoning, reasoningSeed, className, animationActive = true, }) {
    const windowFocused = useWindowFocus();
    const animationPaused = !animationActive || !windowFocused;
    const displayStatus = getWorkingIndicatorDisplayStatus({
        status,
        toolName,
        toolCallId,
        isReasoning,
        reasoningSeed,
    });
    return (<div className={cn("working-indicator", className)}>
      <div className="indicator-stella">
        <div className="indicator-stella-scale">
          <StellaAnimation width={20} height={20} maxDpr={1} maxFps={15} paused={animationPaused} requireWindowFocus/>
        </div>
      </div>
      <SwapText text={displayStatus} active={animationActive} animateInitial={false} className="working-status" shimmerGroup={CHAT_ACTIVITY_SHIMMER_GROUP} shimmerPriority={100}/>
    </div>);
}
