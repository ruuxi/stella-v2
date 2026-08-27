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

export const deviceLanguageTags = (): string[] => [
  ...fromIos(),
  ...fromAndroid(),
  ...fromIntl(),
];
