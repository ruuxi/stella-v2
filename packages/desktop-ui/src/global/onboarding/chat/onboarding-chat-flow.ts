/**
 * Chat-style onboarding: the flow definition and its durable bits.
 *
 * The onboarding is a scripted conversation. Each step is one assistant
 * message with an interactive card inside it; answering a card appends a
 * short user bubble and the next message arrives. Everything here is
 * renderer-side state — the rows are never persisted as chat messages.
 *
 * Discovery runs first on purpose: it kicks off signal collection and the
 * synthesis model call, and the remaining steps give that work time to
 * finish before the personalized finale needs its result.
 */
import { uiState } from "@/platform/ui-state";

export type OnboardingChatStep =
  | "discovery"
  | "capabilities"
  | "memory"
  | "theme"
  | "extras"
  | "ready";

export const ONBOARDING_CHAT_STEPS: readonly OnboardingChatStep[] = [
  "discovery",
  "capabilities",
  "memory",
  "theme",
  "extras",
  "ready",
];

export type OnboardingChatAnswer = "accepted" | "skipped" | "done";

export type OnboardingChatProgress = {
  step: OnboardingChatStep;
  answers: Partial<Record<OnboardingChatStep, OnboardingChatAnswer>>;
};

export const nextOnboardingChatStep = (
  step: OnboardingChatStep,
): OnboardingChatStep | null => {
  const index = ONBOARDING_CHAT_STEPS.indexOf(step);
  return index >= 0 && index < ONBOARDING_CHAT_STEPS.length - 1
    ? ONBOARDING_CHAT_STEPS[index + 1]!
    : null;
};

/* ── Resume ──────────────────────────────────────────────────────────
 * Quitting mid-flow lands the user back on the same message with the
 * earlier ones already answered. Cleared on completion and on replay. */

const PROGRESS_KEY = "stella-onboarding-chat-progress";

const isStep = (value: unknown): value is OnboardingChatStep =>
  typeof value === "string" &&
  (ONBOARDING_CHAT_STEPS as readonly string[]).includes(value);

const isAnswer = (value: unknown): value is OnboardingChatAnswer =>
  value === "accepted" || value === "skipped" || value === "done";

export const readOnboardingChatProgress = (): OnboardingChatProgress | null => {
  const raw = uiState.getItem(PROGRESS_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OnboardingChatProgress>;
    if (!parsed || !isStep(parsed.step)) {
      uiState.removeItem(PROGRESS_KEY);
      return null;
    }
    const answers: OnboardingChatProgress["answers"] = {};
    if (parsed.answers && typeof parsed.answers === "object") {
      for (const [step, answer] of Object.entries(parsed.answers)) {
        if (isStep(step) && isAnswer(answer)) answers[step] = answer;
      }
    }
    return { step: parsed.step, answers };
  } catch {
    uiState.removeItem(PROGRESS_KEY);
    return null;
  }
};

export const writeOnboardingChatProgress = (
  progress: OnboardingChatProgress,
) => {
  uiState.setItem(PROGRESS_KEY, JSON.stringify(progress));
};

export const clearOnboardingChatProgress = () => {
  uiState.removeItem(PROGRESS_KEY);
};
