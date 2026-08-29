import type { DiscoveryCategory } from "@stella/contracts/discovery";

export type Phase =
  | "capabilities"
  | "shapeshift"
  | "theme"
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
  "permissions",
  "browser",
  "extension",
  "engine",
  "voice",
  "memory",
  "enter",
]);

/**
 * The onboarding story, told in five acts:
 *
 *   Discover      — what Stella can do
 *   Make it yours — theme
 *   Connect       — permissions, browser discovery, extension, engine
 *   Your flow     — voice and memory
 *   Ready         — the final gate
 *
 * The act label renders as a small eyebrow above each step title so the
 * user always knows where they are in the arc; the progress strip at the
 * bottom mirrors the same grouping.
 */
export const SPLIT_STEP_ORDER: Phase[] = [
  "capabilities",
  "theme",
  "permissions",
  "browser",
  "extension",
  "engine",
  "voice",
  "memory",
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
  permissions: "connect",
  browser: "connect",
  extension: "connect",
  engine: "connect",
  voice: "flow",
  memory: "flow",
  enter: "ready",
};

/**
 * Phases whose demo surfaces own the full stage; the Stella creature
 * fades out for these (it stays mounted — see OnboardingView) and fades
 * back in for the form-like phases between them.
 *
 * Membership here is also what pauses the mark's animation loop, so every
 * phase that hides the creature must be listed. `capabilities` hides it
 * through CSS either way (it is absent from the reveal rules in
 * full-shell.layout.css), so before it was listed here the mark kept
 * animating behind `opacity: 0` for the whole demo — the longest phase in
 * the flow.
 */
export const CREATURE_HIDDEN_PHASES = new Set<Phase>([
  "capabilities",
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
