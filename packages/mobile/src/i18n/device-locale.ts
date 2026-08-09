/**
 * Device locale discovery, without adding a dependency.
 *
 * `expo-localization` is NOT in this app's package.json, and the only thing
 * we need from it is the ordered list of the user's preferred language tags.
 * React Native already exposes that:
 *
 *   - `Intl.DateTimeFormat().resolvedOptions().locale` — Hermes ships Intl on
 *     both platforms and resolves against the OS locale.
 *   - iOS: `SettingsManager.settings.AppleLanguages` (ordered preference
 *     list) / `AppleLocale`.
 *   - Android: `I18nManager.getConstants().localeIdentifier`
 *     (e.g. `pt_BR`, which `matchSupportedLocale` handles — it splits on
 *     `-` and `_`).
 *
 * Every source is best-effort; whatever we collect is handed to
 * `matchSupportedLocale`, which is the same matcher the desktop uses.
 */

import { I18nManager, NativeModules, Platform } from "react-native";

const fromIntl = (): string[] => {
  try {
    if (typeof Intl === "undefined") return [];
    const resolved = new Intl.DateTimeFormat().resolvedOptions().locale;
    return typeof resolved === "string" && resolved ? [resolved] : [];
  } catch {
    return [];
  }
};

const fromIos = (): string[] => {
  if (Platform.OS !== "ios") return [];
  try {
    const settings = (
      NativeModules as {
        SettingsManager?: {
          settings?: {
            AppleLanguages?: unknown;
            AppleLocale?: unknown;
          };
        };
      }
    ).SettingsManager?.settings;
    if (!settings) return [];
    const list: string[] = [];
    if (Array.isArray(settings.AppleLanguages)) {
      for (const tag of settings.AppleLanguages) {
        if (typeof tag === "string" && tag) list.push(tag);
      }
    }
    if (typeof settings.AppleLocale === "string" && settings.AppleLocale) {
      list.push(settings.AppleLocale);
    }
    return list;
  } catch {
    return [];
  }
};

const fromAndroid = (): string[] => {
  if (Platform.OS !== "android") return [];
  try {
    const identifier = I18nManager.getConstants?.().localeIdentifier;
    return typeof identifier === "string" && identifier ? [identifier] : [];
  } catch {
    return [];
  }
};

/**
 * The device's preferred language tags, most-preferred first. Raw BCP-47 /
 * POSIX-ish tags — resolution to a supported Stella locale is the caller's
 * job (`resolveBestLocale`).
 */
export const deviceLanguageTags = (): string[] => [
  ...fromIos(),
  ...fromAndroid(),
  ...fromIntl(),
];
