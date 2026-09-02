export type OnboardingSynthesisRequest = {
  formattedSections?: Record<string, string>;
  promptConfig?: Record<string, unknown>;
  includeAuth?: boolean;
  includeWelcomeHtml?: boolean;
  /**
   * Ask synthesis for the personalized finale payload (`profileHighlights`
   * + `starters`). Off by default so the legacy onboarding flow keeps its
   * exact request shape and cost.
   */
  includeStarters?: boolean;
};

/** One tappable "try this" suggestion on the onboarding finale. */
export type OnboardingStarter = {
  /** Short label the user taps, e.g. "Plan my week". */
  title: string;
  /** The exact plain-language request dropped into the composer. */
  prompt: string;
};

export type OnboardingSynthesisResponse = {
  coreMemory: string;
  welcomeMessage: string;
  welcomeHtml?: string;
  categoryAnalyses?: Record<string, string>;
  /** 3–5 two-to-five-word phrases describing the person, from discovery. */
  profileHighlights?: string[];
  /** 4 personalized starter prompts drawn from the core memory. */
  starters?: OnboardingStarter[];
};

export type OnboardingWelcomeHtmlRequest = {
  coreMemory: string;
  includeAuth?: boolean;
};

export type OnboardingWelcomeHtmlResponse = {
  welcomeHtml: string;
};
