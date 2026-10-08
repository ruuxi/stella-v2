import AsyncStorage from "@react-native-async-storage/async-storage";

const ONBOARDING_SEEN_KEY = "stella-mobile:onboarding-seen";
const ONBOARDING_PROGRESS_KEY = "stella-mobile:onboarding-progress";

/**
 * The chat-style onboarding, as a script: each step is one assistant message
 * carrying a card, answered in order.
 */
export type OnboardingStep =
  | "hello"
  | "showcase"
  | "computer"
  | "account"
  | "gmail"
  | "theme"
  | "ready";

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  "hello",
  "showcase",
  "computer",
  "account",
  "gmail",
  "theme",
  "ready",
];

export type OnboardingAnswer = "done" | "skipped";

export type OnboardingProgress = {
  step: OnboardingStep;
  answers: Partial<Record<OnboardingStep, OnboardingAnswer>>;
};

let cachedSeen: boolean | null = null;
/** `undefined` until loaded; `null` when there is nothing to resume. */
let cachedProgress: OnboardingProgress | null | undefined;

export async function loadOnboardingSeen(): Promise<boolean> {
  if (cachedSeen !== null) return cachedSeen;
  cachedSeen = (await AsyncStorage.getItem(ONBOARDING_SEEN_KEY)) === "1";
  return cachedSeen;
}

export function hasSeenOnboarding(): boolean {
  return cachedSeen === true;
}

export async function markOnboardingSeen(): Promise<void> {
  cachedSeen = true;
  cachedProgress = null;
  await AsyncStorage.setItem(ONBOARDING_SEEN_KEY, "1");
  await AsyncStorage.removeItem(ONBOARDING_PROGRESS_KEY);
}

const isStep = (value: unknown): value is OnboardingStep =>
  typeof value === "string" &&
  (ONBOARDING_STEPS as readonly string[]).includes(value);

const isAnswer = (value: unknown): value is OnboardingAnswer =>
  value === "done" || value === "skipped";

const parseProgress = (raw: string | null): OnboardingProgress | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OnboardingProgress> | null;
    if (!parsed || !isStep(parsed.step)) return null;
    const answers: OnboardingProgress["answers"] = {};
    if (parsed.answers && typeof parsed.answers === "object") {
      for (const [step, answer] of Object.entries(parsed.answers)) {
        if (isStep(step) && isAnswer(answer)) answers[step] = answer;
      }
    }
    return { step: parsed.step, answers };
  } catch {
    return null;
  }
};

/**
 * Where an interrupted onboarding left off — leaving for the sign-in screen,
 * or the app being closed mid-flow — so it resumes on the same message with
 * the earlier ones already answered. Loaded with the other startup state so
 * the screen can read it synchronously on its first render.
 */
export async function loadOnboardingProgress(): Promise<OnboardingProgress | null> {
  if (cachedProgress !== undefined) return cachedProgress;
  cachedProgress = parseProgress(
    await AsyncStorage.getItem(ONBOARDING_PROGRESS_KEY).catch(() => null),
  );
  return cachedProgress;
}

export function readOnboardingProgress(): OnboardingProgress | null {
  return cachedProgress ?? null;
}

export function writeOnboardingProgress(progress: OnboardingProgress): void {
  cachedProgress = progress;
  void AsyncStorage.setItem(
    ONBOARDING_PROGRESS_KEY,
    JSON.stringify(progress),
  ).catch(() => undefined);
}
