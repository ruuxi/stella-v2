/**
 * Account preferences (locale, preferred browser) and feedback.
 */

/** App languages; mirrors the desktop's `SUPPORTED_LOCALES`. */
export const PREFERENCE_LOCALES = [
  "en",
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "nl",
  "ru",
  "ja",
  "zh-Hans",
  "zh-Hant",
  "ko",
  "pl",
  "sv",
  "nb",
  "da",
  "fi",
  "cs",
  "el",
  "tr",
  "ro",
  "hu",
  "ar",
  "hi",
  "id",
  "vi",
  "th",
  "he",
] as const;
export type PreferenceLocale = (typeof PREFERENCE_LOCALES)[number];

export const PREFERRED_BROWSERS = [
  "arc",
  "brave",
  "chrome",
  "edge",
  "firefox",
  "opera",
  "safari",
  "vivaldi",
  "none",
] as const;
export type PreferredBrowser = (typeof PREFERRED_BROWSERS)[number];

export const FEEDBACK_MAX_CHARS = 32_000;

export type Preferences = {
  locale: PreferenceLocale | null;
  preferredBrowser: PreferredBrowser | null;
};

export type PreferenceCalls = {
  /** Set any of the preferences; returns all of them. */
  "preferences.set": {
    args: { locale?: PreferenceLocale; preferredBrowser?: PreferredBrowser };
    result: Preferences;
  };
  /** Anonymous by design: nothing about the sender is stored. */
  "feedback.submit": {
    args: { message: string; appVersion?: string; platform?: string };
    result: null;
  };
};

export type PreferenceViews = {
  "preferences.get": { args: Record<string, never>; result: Preferences };
};
