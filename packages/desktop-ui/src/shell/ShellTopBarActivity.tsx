/**
 * Stella's presence in the desktop top bar — the DOM half of the indicator
 * mobile already carries (`StellaStatusHeader`).
 *
 * At rest the mark sits centred with idle eyes. While background work runs the
 * work reads out beside it — the single running agent's own description, or a
 * count once several are going — which pushes the mark off centre exactly as
 * the mobile pill does. A new agent plays the thinking beat before the mark
 * settles into a work pose; when the last one finishes the mark pops once and
 * the label leaves.
 *
 * The timings, the phase machine and the choice of label are not written twice
 * — they live in `@stella/contracts/activity-indicator` and mobile reads the
 * same module. Only the rendering is local: `motion/react` and the rig here,
 * Reanimated and the mark layers there.
 *
 * Unlike mobile there is no pill around it. The bar already reads as chrome,
 * so a capsule would only add a box where the window has none.
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  animate,
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
} from "motion/react";
import {
  ACTIVITY_INDICATOR_LABEL_IN_DELAY_MS,
  ACTIVITY_INDICATOR_LABEL_IN_MS,
  ACTIVITY_INDICATOR_LABEL_OUT_MS,
  ACTIVITY_INDICATOR_POP_RISE_MS,
  ACTIVITY_INDICATOR_POP_SCALE,
  ACTIVITY_INDICATOR_POP_SETTLE_SPRING,
  ACTIVITY_INDICATOR_SETTLE_SPRING,
  ACTIVITY_INDICATOR_SPAWN_BEAT_MS,
  activityIndicatorTransition,
  selectActivityIndicatorLabel,
  type ActivityIndicatorPhase,
} from "@stella/contracts/activity-indicator";
import {
  CHAT_ACTIVITY_SHIMMER_GROUP,
  TextShimmer,
} from "@/app/chat/TextShimmer";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { deriveRunningActivityIndicatorEntries } from "@/features/chat/lib/event-transforms";
import { pickWorkingIndicatorToolPose } from "@/features/chat/working-indicator-state";
import { useWindowFocus } from "@/shared/hooks/use-window-focus";
import { useT, useTPlural } from "@/shared/i18n";
import { StellaCharacter } from "@/ui/stella-character/StellaCharacter";
import "./shell-topbar-activity.css";

/** Sweep for the running label — matches the inline chat indicator. */
const LABEL_SHIMMER_MS = 1900;

const MARK_SIZE_PX = 22;

/** Punches the eyes out of the mark so they read as holes, not paint. */
const MARK_EYE_COLOR = "var(--surface-base)";

export const ShellTopBarActivity = memo(function ShellTopBarActivity() {
  const t = useT();
  const tPlural = useTPlural();
  const chat = useChatRuntime();
  const tasks = chat.conversation.tasks;
  const windowFocused = useWindowFocus();
  const reduceMotion = useReducedMotion();

  const running = useMemo(
    () => deriveRunningActivityIndicatorEntries(tasks),
    [tasks],
  );
  const count = running.length;
  const label = selectActivityIndicatorLabel(running, (total) =>
    tPlural("app.chat.activityPill.tasksInProgress", total),
  );

  const [phase, setPhase] = useState<ActivityIndicatorPhase>(
    count > 0 ? "working" : "idle",
  );
  const previousCount = useRef(count);
  const popScale = useMotionValue(1);

  useEffect(() => {
    const previous = previousCount.current;
    previousCount.current = count;
    const transition = activityIndicatorTransition(count, previous);
    if (transition === "spawn") {
      setPhase("spawn");
      const timer = window.setTimeout(
        () => setPhase("working"),
        ACTIVITY_INDICATOR_SPAWN_BEAT_MS,
      );
      return () => window.clearTimeout(timer);
    }
    if (transition === "settle") {
      setPhase("idle");
      if (reduceMotion) return undefined;
      void animate(popScale, [1, ACTIVITY_INDICATOR_POP_SCALE], {
        duration: ACTIVITY_INDICATOR_POP_RISE_MS / 1000,
        ease: [0.33, 1, 0.68, 1],
      }).then(() =>
        animate(popScale, 1, {
          type: "spring",
          ...ACTIVITY_INDICATOR_POP_SETTLE_SPRING,
        }),
      );
    }
    return undefined;
  }, [count, popScale, reduceMotion]);

  const busy = phase !== "idle" && label !== null;
  const pose =
    phase === "spawn"
      ? ("thinking" as const)
      : pickWorkingIndicatorToolPose(running[0]?.id ?? "stella");

  // The shared settle is a duration + damping ratio; `motion` expresses the
  // same curve as a duration and a bounce.
  const settle = reduceMotion
    ? { duration: 0 }
    : {
        type: "spring" as const,
        duration: ACTIVITY_INDICATOR_SETTLE_SPRING.durationMs / 1000,
        bounce: 1 - ACTIVITY_INDICATOR_SETTLE_SPRING.dampingRatio,
      };

  return (
    <div className="shell-topbar-activity" data-busy={busy ? "true" : "false"}>
      <motion.div
        layout={reduceMotion ? false : "position"}
        transition={settle}
        className="shell-topbar-activity__group"
        aria-label={
          busy && label
            ? t("app.chat.activityPill.openActivity", { label })
            : t("app.chat.activityPill.idle")
        }
      >
        <motion.span
          className="shell-topbar-activity__mark"
          style={{ scale: popScale }}
        >
          <StellaCharacter
            size={MARK_SIZE_PX}
            state={busy ? pose : "idle"}
            eyeColor={MARK_EYE_COLOR}
            paused={!windowFocused}
          />
        </motion.span>
        <AnimatePresence initial={false} mode="wait">
          {busy && label ? (
            <motion.span
              key={label}
              className="shell-topbar-activity__label"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{
                opacity: 0,
                transition: reduceMotion
                  ? { duration: 0 }
                  : {
                      duration: ACTIVITY_INDICATOR_LABEL_OUT_MS / 1000,
                      delay: 0,
                    },
              }}
              transition={
                reduceMotion
                  ? { duration: 0 }
                  : {
                      duration: ACTIVITY_INDICATOR_LABEL_IN_MS / 1000,
                      delay: ACTIVITY_INDICATOR_LABEL_IN_DELAY_MS / 1000,
                    }
              }
            >
              <TextShimmer
                text={label}
                durationMs={LABEL_SHIMMER_MS}
                exclusiveGroup={CHAT_ACTIVITY_SHIMMER_GROUP}
                exclusivePriority={30}
              />
            </motion.span>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </div>
  );
});
