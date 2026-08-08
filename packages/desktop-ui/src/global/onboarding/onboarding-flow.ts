import type { DiscoveryCategory } from "@stella/contracts/discovery";

export type Phase =
  | "intro"
  | "capabilities"
  | "shapeshift"
  | "theme"
  | "personality"
  | "permissions"
  | "browser"
  | "extension"
  | "engine"
  | "voice"
  | "memory"
  | "enter"
  | "complete"
  | "done";

export const SPLIT_PHASES = new Set<Phase>([
  "capabilities",
  "theme",
  "personality",
  "permissions",
  "browser",
  "extension",
  "engine",
  "voice",
  "enter",
]);

/**
 * The onboarding story, told in five acts:
 *
 *   Discover      — what Stella can do
 *   Make it yours — theme and personality
 *   Connect       — permissions, browser discovery, extension, engine
 *   Your flow     — voice
 *   Ready         — the final gate
 *
 * The act label renders as a small eyebrow above each step title so the
 * user always knows where they are in the arc; the progress strip at the
 * bottom mirrors the same grouping.
 */
export const SPLIT_STEP_ORDER: Phase[] = [
  "capabilities",
  "theme",
  "personality",
  "permissions",
  "browser",
  "extension",
  "engine",
  "voice",
  "enter",
];

export type OnboardingAct =
  | "discover"
  | "personalize"
  | "connect"
  | "flow"
  | "ready";

export const PHASE_ACTS: Partial<Record<Phase, OnboardingAct>> = {
  capabilities: "discover",
  theme: "personalize",
  personality: "personalize",
  permissions: "connect",
  browser: "connect",
  extension: "connect",
  engine: "connect",
  voice: "flow",
  enter: "ready",
};

/**
 * Phases whose demo surfaces own the full stage; the Stella creature
 * fades out for these (it stays mounted — see OnboardingView) and fades
 * back in for the form-like phases between them.
 */
export const CREATURE_HIDDEN_PHASES = new Set<Phase>([
  "voice",
  "enter",
]);

/**
 * Discovery rows are translated at render time. `labelKey` /
 * `descriptionKey` resolve against the locale catalog under
 * `onboarding.discovery.<id>.{label,description}`.
 */
export const DISCOVERY_CATEGORIES: {
  id: DiscoveryCategory;
  labelKey: string;
  descriptionKey: string;
  defaultEnabled: boolean;
  requiresFDA?: boolean;
}[] = [
  {
    id: "dev_environment",
    labelKey: "onboarding.discovery.devEnvironment.label",
    descriptionKey: "onboarding.discovery.devEnvironment.description",
    defaultEnabled: false,
  },
];

export const BROWSERS = [
  { id: "chrome", label: "Google Chrome" },
  { id: "firefox", label: "Firefox" },
  { id: "edge", label: "Microsoft Edge" },
  { id: "arc", label: "Arc" },
  { id: "brave", label: "Brave" },
  { id: "safari", label: "Safari" },
  { id: "opera", label: "Opera" },
] as const;

export type BrowserId = (typeof BROWSERS)[number]["id"];
