/**
 * Stella's presence in the desktop top bar — the DOM half of the indicator
 * mobile already carries (`StellaStatusHeader`).
 *
 * The mark sits centred and plays its own resting animation — the blob's
 * breathe and idle eyes — at all times. While background work runs it glides
 * aside and the work reads out beside it: the single running agent's own
 * description, or a count once several are going; when the last one finishes
 * the mark pops once and the label leaves.
 *
 * The mark deliberately does NOT change character while work runs. The rig's
 * activity states (the thinking ellipsis, the twinkle and orbit poses) are the
 * chat working indicator's language — `WorkingIndicator` is where a run is
 * narrated. Up here the label carries the state and the mark stays Stella.
 *
 * The timings, the phase machine and the choice of label are not written twice
 * — they live in `@stella/contracts/activity-indicator` and mobile reads the
 * same module. Only the rendering is local: `motion/react` and the rig here,
 * Reanimated and the mark layers there.
 *
 * Unlike mobile there is no pill around it. The bar already reads as chrome,
 * so a capsule would only add a box where the window has none.
 */

import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { useWindowFocus } from "@/shared/hooks/use-window-focus";
import { useT, useTPlural } from "@/shared/i18n";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { StellaCharacter } from "@/ui/stella-character/StellaCharacter";
import "./shell-topbar-activity.css";

/** Keeps the whole Activity hierarchy out of the top bar's eager graph. */
const loadActivityOverview = () =>
  import("@/shell/sidebar-sections/HomeSection").then((module) => ({
    default: module.ActivityOverview,
  }));

const preloadActivityOverview = (): void => {
  // Opening the menu surfaces a real failure through the render boundary;
  // a speculative hover must not create an unhandled rejection.
  void loadActivityOverview().catch(() => undefined);
};

const ActivityOverview = lazy(loadActivityOverview);

/** Sweep for the running label — matches the inline chat indicator. */
const LABEL_SHIMMER_MS = 1900;

const MARK_SIZE_PX = 22;

/** Punches the eyes out of the mark so they read as holes, not paint. */
const MARK_EYE_COLOR = "var(--surface-base)";

/** The menu's own list and cap come from `ActivityOverview` (overview variant),
 *  which is the list the right-hand activity panel used to show. */
function ActivityMenu({ onNavigate }: { onNavigate: () => void }) {
  return (
    <div className="shell-topbar-activity-menu">
      <Suspense fallback={null}>
        <ActivityOverview onNavigate={onNavigate} />
      </Suspense>
    </div>
  );
}

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

  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!busy && open) setOpen(false);
  }, [busy, open]);

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
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <motion.button
            type="button"
            layout={reduceMotion ? false : "position"}
            transition={settle}
            className="shell-topbar-activity__trigger"
            data-open={open || undefined}
            disabled={!busy}
            onMouseEnter={preloadActivityOverview}
            onFocus={preloadActivityOverview}
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
                state="idle"
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
          </motion.button>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="center"
          sideOffset={6}
          collisionPadding={8}
          className="shell-topbar-activity-menu-popover"
        >
          <ActivityMenu onNavigate={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
    </div>
  );
});
