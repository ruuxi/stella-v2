export const SUPPORTED_LOCALES = [
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

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export const RTL_LOCALES: ReadonlySet<Locale> = new Set<Locale>(["ar", "he"]);

export const LOCALE_NATIVE_LABELS: Record<Locale, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
  pt: "Português",
  nl: "Nederlands",
  ru: "Русский",
  ja: "日本語",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
  ko: "한국어",
  pl: "Polski",
  sv: "Svenska",
  nb: "Norsk bokmål",
  da: "Dansk",
  fi: "Suomi",
  cs: "Čeština",
  el: "Ελληνικά",
  tr: "Türkçe",
  ro: "Română",
  hu: "Magyar",
  ar: "العربية",
  hi: "हिन्दी",
  id: "Bahasa Indonesia",
  vi: "Tiếng Việt",
  th: "ไทย",
  he: "עברית",
};

export const LOCALE_ENGLISH_NAMES: Record<Locale, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  ru: "Russian",
  ja: "Japanese",
  "zh-Hans": "Simplified Chinese",
  "zh-Hant": "Traditional Chinese",
  ko: "Korean",
  pl: "Polish",
  sv: "Swedish",
  nb: "Norwegian Bokmål",
  da: "Danish",
  fi: "Finnish",
  cs: "Czech",
  el: "Greek",
  tr: "Turkish",
  ro: "Romanian",
  hu: "Hungarian",
  ar: "Arabic",
  hi: "Hindi",
  id: "Indonesian",
  vi: "Vietnamese",
  th: "Thai",
  he: "Hebrew",
};

const SUPPORTED_SET: ReadonlySet<string> = new Set(SUPPORTED_LOCALES);

export const isSupportedLocale = (
  value: string | null | undefined,
): value is Locale => typeof value === "string" && SUPPORTED_SET.has(value);

export const matchSupportedLocale = (
  candidate: string | null | undefined,
): Locale | null => {
  if (!candidate) return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  if (isSupportedLocale(trimmed)) return trimmed;

  const lower = trimmed.toLowerCase();

  if (lower.startsWith("zh")) {
    if (
      lower.includes("hant") ||
      lower.includes("-tw") ||
      lower.includes("-hk") ||
      lower.includes("-mo")
    ) {
      return "zh-Hant";
    }
    return "zh-Hans";
  }

  if (lower === "no" || lower.startsWith("no-") || lower.startsWith("nn")) {
    return "nb";
  }

  const primary = lower.split(/[-_]/)[0];
  if (primary && isSupportedLocale(primary)) return primary;

  return null;
};

export const resolveBestLocale = (
  candidates: ReadonlyArray<string | null | undefined>,
): Locale => {
  for (const candidate of candidates) {
    const matched = matchSupportedLocale(candidate ?? null);
    if (matched) return matched;
  }
  return DEFAULT_LOCALE;
};

export const isRtlLocale = (locale: Locale): boolean =>
  RTL_LOCALES.has(locale);

export const localeDir = (locale: Locale): "ltr" | "rtl" =>
  isRtlLocale(locale) ? "rtl" : "ltr";

export const LOCALE_STORAGE_KEY = "stella:locale";

export const LOCALE_PREFERENCE_KEY = "locale";
