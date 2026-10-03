/** The renderer's synthesis prompts; see `desktop-ui/src/prompts/transport.ts`. */
export type OnboardingSynthesisPromptConfig = {
  /** Per-category system prompts keyed by discovery category id. */
  categoryAnalysisSystemPrompts?: Record<string, string>;
  categoryAnalysisUserPromptTemplate?: string;
  coreMemorySystemPrompt: string;
  coreMemoryUserPromptTemplate: string;
  welcomeMessagePromptTemplate: string;
};

export type OnboardingSynthesisRequest = {
  formattedSections: Record<string, string>;
  promptConfig: OnboardingSynthesisPromptConfig;
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
  categoryAnalyses?: Record<string, string>;
  /** 3–5 two-to-five-word phrases describing the person, from discovery. */
  profileHighlights?: string[];
  /** 4 personalized starter prompts drawn from the core memory. */
  starters?: OnboardingStarter[];
};
