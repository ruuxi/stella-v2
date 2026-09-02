/**
 * State machine for the chat-style onboarding.
 *
 * Owns the transcript (assistant messages + the user's short replies), the
 * current step, the "Stella is typing" beat between messages, resume, and
 * the exit. Cards never talk to persistence directly — they call `answer`
 * and the hook does the rest.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WORKING_INDICATOR_HANDOFF_MS } from "@/features/chat/working-indicator-state";
import { useT } from "@/shared/i18n";
import {
  clearOnboardingChatProgress,
  nextOnboardingChatStep,
  ONBOARDING_CHAT_STEPS,
  readOnboardingChatProgress,
  writeOnboardingChatProgress,
  type OnboardingChatAnswer,
  type OnboardingChatProgress,
  type OnboardingChatStep,
} from "./onboarding-chat-flow";
import type { PendingComposerDraft } from "./pending-handoff";

export type OnboardingChatEntry =
  | {
      kind: "assistant";
      id: string;
      step: OnboardingChatStep;
      /** Plays the arrival animation — only for rows added this session. */
      fresh: boolean;
    }
  | { kind: "user"; id: string; text: string; fresh: boolean };

export type OnboardingChatHandoff = {
  composerDraft?: PendingComposerDraft;
};

type UseOnboardingChatArgs = {
  onFinished: (handoff: OnboardingChatHandoff) => void;
};

/** The user bubble lands, then Stella "reads" it before typing. */
const TYPING_DELAY_MS = 420;
/** How long the working indicator stays before the reply drops in. */
const TYPING_HOLD_MS = 900;
/** Surface fade before the shell swaps to the real chat. */
const EXIT_MS = 320;

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const ANSWER_TEXT_KEYS: Record<
  OnboardingChatStep,
  Partial<Record<OnboardingChatAnswer, string>>
> = {
  discovery: {
    accepted: "onboarding.chat.replies.discoveryAccepted",
    skipped: "onboarding.chat.replies.discoverySkipped",
  },
  capabilities: {
    done: "onboarding.chat.replies.capabilitiesDone",
    skipped: "onboarding.chat.replies.capabilitiesSkipped",
  },
  memory: {
    done: "onboarding.chat.replies.memoryDone",
    skipped: "onboarding.chat.replies.memorySkipped",
  },
  theme: {
    done: "onboarding.chat.replies.themeDone",
    skipped: "onboarding.chat.replies.themeSkipped",
  },
  extras: {
    done: "onboarding.chat.replies.extrasDone",
    skipped: "onboarding.chat.replies.extrasSkipped",
  },
  ready: {},
};

const assistantEntry = (
  step: OnboardingChatStep,
  fresh: boolean,
): OnboardingChatEntry => ({
  kind: "assistant",
  id: `assistant:${step}`,
  step,
  fresh,
});

const buildResumedEntries = (
  progress: OnboardingChatProgress,
  t: (key: string) => string,
  resumed: boolean,
): OnboardingChatEntry[] => {
  const entries: OnboardingChatEntry[] = [];
  for (const step of ONBOARDING_CHAT_STEPS) {
    if (step === progress.step) break;
    const answer = progress.answers[step];
    // A past step with no recorded answer was never shown (the flow gained a
    // step after this progress was saved); rebuilding it would leave an
    // orphaned card above the current one.
    if (!answer) continue;
    entries.push(assistantEntry(step, false));
    const textKey = ANSWER_TEXT_KEYS[step][answer];
    if (textKey) {
      entries.push({
        kind: "user",
        id: `user:${step}`,
        text: t(textKey),
        fresh: false,
      });
    }
  }
  entries.push(assistantEntry(progress.step, !resumed));
  return entries;
};

export function useOnboardingChat({ onFinished }: UseOnboardingChatArgs) {
  const t = useT();
  const [progress, setProgress] = useState<OnboardingChatProgress>(
    () => readOnboardingChatProgress() ?? { step: "discovery", answers: {} },
  );
  const resumedRef = useRef(readOnboardingChatProgress() !== null);
  const [entries, setEntries] = useState<OnboardingChatEntry[]>(() =>
    buildResumedEntries(progress, t, resumedRef.current),
  );
  const [typing, setTyping] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const [exiting, setExiting] = useState(false);
  const busyRef = useRef(false);
  const finishedRef = useRef(false);
  const timersRef = useRef<number[]>([]);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const schedule = useCallback((ms: number, fn: () => void) => {
    const id = window.setTimeout(() => {
      timersRef.current = timersRef.current.filter((other) => other !== id);
      fn();
    }, ms);
    timersRef.current.push(id);
  }, []);

  useEffect(
    () => () => {
      for (const id of timersRef.current) window.clearTimeout(id);
      timersRef.current = [];
    },
    [],
  );

  const finish = useCallback(
    (handoffPayload: OnboardingChatHandoff = {}) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      busyRef.current = true;
      clearOnboardingChatProgress();
      setExiting(true);
      schedule(prefersReducedMotion() ? 0 : EXIT_MS, () => {
        onFinishedRef.current(handoffPayload);
      });
    },
    [schedule],
  );

  const answer = useCallback(
    (step: OnboardingChatStep, kind: OnboardingChatAnswer) => {
      if (busyRef.current || finishedRef.current) return;
      if (progress.step !== step) return;
      const next = nextOnboardingChatStep(step);
      const textKey = ANSWER_TEXT_KEYS[step][kind];
      if (textKey) {
        setEntries((prev) => [
          ...prev,
          { kind: "user", id: `user:${step}`, text: t(textKey), fresh: true },
        ]);
      }
      const answers = { ...progress.answers, [step]: kind };
      if (!next) {
        finish();
        return;
      }
      const nextProgress: OnboardingChatProgress = { step: next, answers };
      setProgress(nextProgress);
      writeOnboardingChatProgress(nextProgress);

      busyRef.current = true;
      const reveal = () => {
        setHandoff(false);
        setEntries((prev) => [...prev, assistantEntry(next, true)]);
        busyRef.current = false;
      };
      if (prefersReducedMotion()) {
        schedule(120, reveal);
        return;
      }
      schedule(TYPING_DELAY_MS, () => setTyping(true));
      schedule(TYPING_DELAY_MS + TYPING_HOLD_MS, () => {
        setTyping(false);
        setHandoff(true);
      });
      schedule(
        TYPING_DELAY_MS + TYPING_HOLD_MS + WORKING_INDICATOR_HANDOFF_MS,
        reveal,
      );
    },
    [finish, progress, schedule, t],
  );

  const indicator = useMemo(
    () => ({ active: typing, handoff }),
    [handoff, typing],
  );

  return {
    entries,
    currentStep: progress.step,
    answers: progress.answers,
    indicator,
    exiting,
    answer,
    finish,
  };
}
