import type { DiscoveryCategory } from "@stella/contracts/discovery";

export type Phase =
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

export const CREATURE_HIDDEN_PHASES = new Set<Phase>([
  "capabilities",
  "voice",
  "enter",
]);

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
