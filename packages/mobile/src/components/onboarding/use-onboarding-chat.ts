/**
 * State machine for the chat-style onboarding.
 *
 * Owns the transcript (scripted assistant messages and the user's short
 * replies), the current step, the "Stella is typing" beat between messages,
 * resume, and the exit. Cards never touch persistence: they call `answer`
 * and this hook does the rest.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "react-native-reanimated";
import { useT } from "../../i18n";
import { tapLight } from "../../lib/haptics";
import {
  ONBOARDING_STEPS,
  readOnboardingProgress,
  writeOnboardingProgress,
  type OnboardingAnswer,
  type OnboardingProgress,
  type OnboardingStep,
} from "../../lib/onboarding";

export type OnboardingEntry =
  | {
      kind: "assistant";
      id: string;
      step: OnboardingStep;
      /** Plays the arrival animation: only rows added this session. */
      fresh: boolean;
    }
  | { kind: "user"; id: string; text: string; fresh: boolean };

/** The reply lands, then Stella "reads" it before typing. */
const TYPING_DELAY_MS = 380;
/** How long the typing indicator holds before the next message drops in. */
const TYPING_HOLD_MS = 950;
/** On a first visit, the hero settles before Stella starts typing. */
const INTRO_TYPING_AT_MS = 650;

const REPLY_KEYS: Record<
  OnboardingStep,
  Partial<Record<OnboardingAnswer, string>>
> = {
  hello: { done: "mobile.onboarding.replies.helloDone" },
  showcase: { done: "mobile.onboarding.replies.showcaseDone" },
  computer: {
    done: "mobile.onboarding.replies.computerDone",
    skipped: "mobile.onboarding.replies.computerSkipped",
  },
  account: {
    done: "mobile.onboarding.replies.accountDone",
    skipped: "mobile.onboarding.replies.accountSkipped",
  },
  theme: {
    done: "mobile.onboarding.replies.themeDone",
    skipped: "mobile.onboarding.replies.themeSkipped",
  },
  ready: {},
};

const nextStep = (
  steps: readonly OnboardingStep[],
  step: OnboardingStep,
): OnboardingStep | null => {
  const index = steps.indexOf(step);
  return index >= 0 && index < steps.length - 1 ? steps[index + 1]! : null;
};

const assistantEntry = (
  step: OnboardingStep,
  fresh: boolean,
): OnboardingEntry => ({
  kind: "assistant",
  id: `assistant:${step}`,
  step,
  fresh,
});

const buildEntries = (
  progress: OnboardingProgress,
  t: (key: string) => string,
  resumed: boolean,
): OnboardingEntry[] => {
  const entries: OnboardingEntry[] = [];
  for (const step of ONBOARDING_STEPS) {
    if (step === progress.step) break;
    const answer = progress.answers[step];
    // A past step with no recorded answer was never shown (the flow gained a
    // step after this progress was saved); rebuilding it would leave an
    // orphaned card above the current one.
    if (!answer) continue;
    entries.push(assistantEntry(step, false));
    const key = REPLY_KEYS[step][answer];
    if (key) {
      entries.push({ kind: "user", id: `user:${step}`, text: t(key), fresh: false });
    }
  }
  entries.push(assistantEntry(progress.step, !resumed));
  return entries;
};

export function useOnboardingChat({
  started,
  skipPairing,
}: {
  started: boolean;
  /**
   * Pairing is already handled for this owner, so the computer message is left
   * out of the script entirely (see `usePairingStepNeeded`).
   */
  skipPairing: boolean;
}) {
  const t = useT();
  const reducedMotion = useReducedMotion();
  const [initial] = useState(() => {
    const saved = readOnboardingProgress();
    return {
      resumed: saved !== null,
      progress: saved ?? { step: "hello" as const, answers: {} },
    };
  });
  const [progress, setProgress] = useState<OnboardingProgress>(
    initial.progress,
  );
  // A first visit opens on an empty thread: Stella "types" the greeting in.
  const [entries, setEntries] = useState<OnboardingEntry[]>(() =>
    initial.resumed ? buildEntries(initial.progress, t, true) : [],
  );
  const [typing, setTyping] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const busyRef = useRef(!initial.resumed);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const progressRef = useRef(progress);
  progressRef.current = progress;

  // Dropping a step the user is already on, or already answered, would strand
  // the transcript, so the decision only applies ahead of the message.
  const steps = useMemo(() => {
    if (!skipPairing) return ONBOARDING_STEPS;
    if (progress.step === "computer") return ONBOARDING_STEPS;
    if (progress.answers.computer !== undefined) return ONBOARDING_STEPS;
    return ONBOARDING_STEPS.filter((step) => step !== "computer");
  }, [progress.answers.computer, progress.step, skipPairing]);
  const stepsRef = useRef(steps);
  stepsRef.current = steps;

  const schedule = useCallback((ms: number, fn: () => void) => {
    const id = setTimeout(() => {
      timersRef.current = timersRef.current.filter((other) => other !== id);
      fn();
    }, ms);
    timersRef.current.push(id);
  }, []);

  useEffect(
    () => () => {
      for (const id of timersRef.current) clearTimeout(id);
      timersRef.current = [];
    },
    [],
  );

  // The greeting waits for the screen to actually be visible (the native
  // splash can still be up while startup state resolves).
  const introStartedRef = useRef(false);
  useEffect(() => {
    if (initial.resumed || !started || introStartedRef.current) return;
    introStartedRef.current = true;
    const greet = () => {
      setTyping(false);
      setHandoff(true);
      setEntries([assistantEntry("hello", true)]);
      busyRef.current = false;
    };
    if (reducedMotion) {
      schedule(120, greet);
      return;
    }
    schedule(INTRO_TYPING_AT_MS, () => setTyping(true));
    schedule(INTRO_TYPING_AT_MS + TYPING_HOLD_MS, greet);
    // Once, when the screen first shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  const answer = useCallback(
    (step: OnboardingStep, kind: OnboardingAnswer) => {
      const current = progressRef.current;
      if (busyRef.current || current.step !== step) return;
      const next = nextStep(stepsRef.current, step);
      if (!next) return;
      tapLight();
      const key = REPLY_KEYS[step][kind];
      if (key) {
        setEntries((prev) => [
          ...prev,
          { kind: "user", id: `user:${step}`, text: t(key), fresh: true },
        ]);
      }
      const nextProgress: OnboardingProgress = {
        step: next,
        answers: { ...current.answers, [step]: kind },
      };
      progressRef.current = nextProgress;
      setProgress(nextProgress);
      writeOnboardingProgress(nextProgress);

      busyRef.current = true;
      const reveal = () => {
        setTyping(false);
        setHandoff(true);
        setEntries((prev) => [...prev, assistantEntry(next, true)]);
        busyRef.current = false;
      };
      if (reducedMotion) {
        schedule(160, reveal);
        return;
      }
      schedule(TYPING_DELAY_MS, () => {
        setHandoff(false);
        setTyping(true);
      });
      schedule(TYPING_DELAY_MS + TYPING_HOLD_MS, reveal);
    },
    [reducedMotion, schedule, t],
  );

  return {
    entries,
    steps,
    currentStep: progress.step,
    answers: progress.answers,
    typing,
    handoff,
    answer,
  };
}
