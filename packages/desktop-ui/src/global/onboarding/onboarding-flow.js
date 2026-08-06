export const SPLIT_PHASES = new Set([
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
export const SPLIT_STEP_ORDER = [
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
export const PHASE_ACTS = {
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
export const CREATURE_HIDDEN_PHASES = new Set([
    "voice",
    "enter",
]);
/**
 * Discovery rows are translated at render time. `labelKey` /
 * `descriptionKey` resolve against the locale catalog under
 * `onboarding.discovery.<id>.{label,description}`.
 */
export const DISCOVERY_CATEGORIES = [
    {
        id: "apps_system",
        labelKey: "onboarding.discovery.appsSystem.label",
        descriptionKey: "onboarding.discovery.appsSystem.description",
        defaultEnabled: false,
        requiresFDA: true,
    },
    {
        id: "messages_notes",
        labelKey: "onboarding.discovery.messagesNotes.label",
        descriptionKey: "onboarding.discovery.messagesNotes.description",
        defaultEnabled: false,
        requiresFDA: true,
    },
    {
        id: "dev_environment",
        labelKey: "onboarding.discovery.devEnvironment.label",
        descriptionKey: "onboarding.discovery.devEnvironment.description",
        defaultEnabled: false,
        requiresFDA: false,
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
];
